import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspaceActivityController } from "../runtime/static/workspace/index.js";

const createWindow = () => {
  let nextID = 1;
  const intervals = new Map();
  const timeouts = new Map();
  return {
    clearInterval: (id) => intervals.delete(id),
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (callback) => { const id = nextID++; intervals.set(id, callback); return id; },
    setTimeout: (callback) => { const id = nextID++; timeouts.set(id, callback); return id; },
    runIntervals: () => [...intervals.values()].forEach((callback) => callback()),
    runTimeouts: () => [...timeouts.values()].forEach((callback) => callback()),
    intervalCount: () => intervals.size,
    timeoutCount: () => timeouts.size,
  };
};

test("activity refresh updates pane state and ignores stale generations", async () => {
  const windowObject = createWindow();
  const pane = { id: "pane-a", busy: false, shellEl: { dataset: {} } };
  const tab = { id: "tab-a", activePaneId: "pane-a", panes: new Map([[pane.id, pane]]) };
  const calls = [];
  const controller = createWorkspaceActivityController({
    windowObject,
    documentObject: { hidden: false },
    navigatorObject: { onLine: true },
    getTabs: () => [tab],
    getCurrentTab: () => tab,
    getActiveTabId: () => tab.id,
    getActiveName: () => "demo@owner",
    getInstanceGeneration: () => 3,
    getActivityURL: (name) => `/activity?name=${name}`,
    fetchFunction: async () => ({
      ok: true,
      json: async () => ({ selector: "demo@owner", panes: [{ id: pane.id, busy: true, command: "top", cwd: "/tmp" }] }),
    }),
    isCurrentInstanceRequest: () => true,
    ensureResponseSelector: () => calls.push("selector"),
    observeServerGeometry: () => calls.push("geometry"),
    recoverSessions: () => calls.push("recover"),
    refreshTabAutoLabel: () => calls.push("label"),
    updateMobileActiveTabTitle: () => calls.push("mobile-title"),
    updateDocumentTitle: () => calls.push("document-title"),
    markSessionActivityNotification: () => calls.push("activity-notification"),
    markSessionIdleNotification: () => calls.push("idle-notification"),
  });

  const result = await controller.refreshActivity();
  assert.equal(result.length, 1);
  assert.equal(pane.busy, true);
  assert.equal(pane.shellEl.dataset.busy, "true");
  assert.ok(calls.includes("selector"));
  assert.ok(calls.includes("document-title"));
});

test("activity timers are latest-only and disposed together", () => {
  const windowObject = createWindow();
  const controller = createWorkspaceActivityController({
    windowObject,
    documentObject: { hidden: false },
    navigatorObject: { onLine: true },
    getActiveName: () => "demo@owner",
    getActivityURL: () => "/activity",
    fetchFunction: async () => ({ ok: true, json: async () => ({ panes: [] }) }),
  });
  assert.equal(controller.startActivityRefresh(), true);
  assert.equal(windowObject.intervalCount(), 1);
  assert.equal(controller.scheduleActivityRefresh(10), true);
  assert.equal(windowObject.timeoutCount(), 1);
  assert.equal(controller.dispose(), true);
  assert.equal(windowObject.intervalCount(), 0);
  assert.equal(windowObject.timeoutCount(), 0);
  assert.equal(controller.dispose(), false);
});

test("activity detects added and removed panes without requesting unchanged membership", async () => {
  const panes = new Map([["one", { id: "one", name: "demo" }]]);
  let response = { panes: [{ id: "one" }] };
  const changes = [];
  const clock = createWindow();
  const controller = createWorkspaceActivityController({
    windowObject: clock, getTabs: () => [{ panes }], getActiveName: () => "demo", getInstanceGeneration: () => 4,
    getActivityURL: () => "/activity", fetchFunction: async () => ({ ok: true, json: async () => response }),
    syncPaneMembership: async (value) => { changes.push(value); },
  });
  controller.startActivityRefresh();
  await controller.refreshActivity();
  assert.equal(changes.length, 0);
  response = { panes: [{ id: "one" }, { id: "two" }] };
  await controller.refreshActivity();
  assert.deepEqual(changes.at(-1), { instanceName: "demo", generation: 4, paneIDs: ["one", "two"] });
  panes.set("two", { id: "two", name: "demo" });
  await controller.refreshActivity();
  assert.equal(changes.length, 1);
  response = { panes: [{ id: "two" }] };
  await controller.refreshActivity();
  assert.deepEqual(changes.at(-1).paneIDs, ["two"]);
  assert.equal(clock.intervalCount(), 1);
  assert.equal(clock.timeoutCount(), 0);
  response = {};
  await controller.refreshActivity();
  response = { panes: [{ id: "bad" }], error: "partial response" };
  await assert.rejects(controller.refreshActivity(), /partial response/);
  assert.equal(changes.length, 2, "incomplete/error responses cannot remove local panes");
  controller.dispose();
});

test("out-of-order or disposed activity replies cannot trigger structural recovery", async () => {
  const replies = [];
  const changes = [];
  const controller = createWorkspaceActivityController({
    getTabs: () => [{ panes: new Map([["one", { id: "one" }]]) }],
    getActiveName: () => "demo", getActivityURL: () => "/activity",
    fetchFunction: () => new Promise((resolve) => replies.push((panes) => resolve({ ok: true, json: async () => ({ panes }) }))),
    syncPaneMembership: async (value) => changes.push(value),
  });
  const first = controller.refreshActivity();
  const second = controller.refreshActivity();
  replies[1]([{ id: "one" }]); await second;
  replies[0]([{ id: "stale" }]); await first;
  assert.equal(changes.length, 0);
  const late = controller.refreshActivity();
  controller.dispose();
  replies[2]([{ id: "late" }]); await late;
  assert.equal(changes.length, 0);
});

test("activity observed before a local action cannot trigger redundant membership refresh afterward", async () => {
  let reply;
  let version = 0;
  let changes = 0;
  const controller = createWorkspaceActivityController({ getActiveName: () => "demo", getActivityURL: () => "/activity",
    getTabs: () => [{ panes: new Map([["new-local", { id: "new-local" }]]) }],
    getMutationState: () => ({ version, pending: false }),
    fetchFunction: () => new Promise((resolve) => { reply = resolve; }),
    syncPaneMembership: async () => { changes += 1; },
  });
  const pending = controller.refreshActivity();
  version += 2;
  reply({ ok: true, json: async () => ({ panes: [{ id: "old" }] }) });
  await pending;
  assert.equal(changes, 0);
});
