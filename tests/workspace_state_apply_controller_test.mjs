import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkspaceStateApplyController,
  createWorkspaceStateApplyLifecycle,
} from "../runtime/static/workspace/index.js";

const createFrameWindow = () => {
  let nextID = 1;
  const frames = new Map();
  return {
    requestAnimationFrame: (callback) => {
      const id = nextID++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    flush: () => {
      for (const [id, callback] of [...frames]) {
        frames.delete(id);
        callback();
      }
    },
    size: () => frames.size,
  };
};

test("workspace state apply reconciles authoritative tabs and panes in applying mode", async () => {
  const windowObject = createFrameWindow();
  const oldPane = { id: "pane-old", name: "demo" };
  const retainedPane = { id: "pane-1", name: "demo", workspaceExitPending: true, exitExpected: true, pendingConnect: false };
  const retainedTab = {
    id: "tab-1",
    label: "Old",
    panes: new Map([[oldPane.id, oldPane], [retainedPane.id, retainedPane]]),
    activePaneId: oldPane.id,
    layout: null,
    button: { remove: () => {} },
  };
  const stalePane = { id: "pane-stale", name: "demo" };
  const staleTab = { id: "tab-stale", panes: new Map([[stalePane.id, stalePane]]) };
  const tabs = new Map([[retainedTab.id, retainedTab], [staleTab.id, staleTab]]);
  const calls = [];
  let recent = [];
  let controller;

  const closeTab = (tabId) => {
    assert.equal(controller.isApplying(), true);
    calls.push(["close-tab", tabId]);
    tabs.delete(tabId);
  };
  const createTab = (options) => {
    assert.equal(controller.isApplying(), true);
    const tab = {
      id: options.id,
      label: options.label,
      panes: new Map(),
      activePaneId: null,
      layout: null,
      button: null,
    };
    tabs.set(tab.id, tab);
    calls.push(["create-tab", tab.id]);
    return tab;
  };
  controller = createWorkspaceStateApplyController({
    getTabs: () => tabs,
    getActiveName: () => "demo",
    getActiveGeneration: () => 4,
    getActiveTabId: () => "tab-1",
    isCurrentRequest: (name, generation) => name === "demo" && generation === 4,
    ensureResponseSelector: () => calls.push(["selector"]),
    responseSelector: (state) => state.selector,
    showToast: (message) => calls.push(["toast", message]),
    readRestartTabForName: () => "",
    clearRestartTabForReload: () => calls.push(["clear-restart"]),
    readRequestedTab: () => "tab-1",
    setWorkspaceGenerationFromState: () => false,
    destroyLocalHistory: (pane) => { calls.push(["destroy-history", pane.id]); return Promise.resolve(); },
    closeTab,
    createTab,
    recreateTabButton: (tab) => calls.push(["button", tab.id]),
    createPaneSession: (tab, name, options) => {
      const pane = { id: options.id, name, socket: null };
      tab.panes.set(pane.id, pane);
      calls.push(["create-pane", pane.id]);
      return pane;
    },
    disposePane: (pane) => calls.push(["dispose-pane", pane.id]),
    updatePaneActivity: (paneState) => calls.push(["activity", paneState.id]),
    renderTabLabel: (tab) => calls.push(["label", tab.id]),
    renderTabLayout: (tab) => calls.push(["layout", tab.id]),
    clearTabButtons: () => calls.push(["clear-buttons"]),
    applyRecentTabIds: (ids) => { recent = ids.slice(0, 2); calls.push(["recent", ...recent]); return recent; },
    loadStoredRecentTabIds: () => [],
    getRecentTabIds: () => recent.slice(),
    readLastActiveTab: () => "",
    setActiveTab: (tabId, options) => calls.push(["active", tabId, options.focus]),
    clearActiveTab: () => calls.push(["clear-active"]),
    updateEmptyState: () => calls.push(["empty"]),
    scheduleOverviewRender: () => calls.push(["overview"]),
    resizeActiveTabForCurrentDevice: () => calls.push(["resize"]),
    connectPendingSessionsForTab: (tab, options) => calls.push(["connect", tab?.id || "", options.allowHidden]),
    flushPendingMembershipRefresh: (reason) => {
      assert.equal(controller.isApplying(), false);
      calls.push(["flush", reason]);
    },
    measureTask: (name, task) => { calls.push(["measure", name]); return task(); },
    lifecycleOptions: { windowObject },
  });

  const state = {
    selector: "demo",
    agent_notice: "agent ready",
    active_tab_id: "tab-1",
    recent_tab_ids: ["tab-1"],
    tabs: [{
      id: "tab-1",
      label: "Authoritative",
      custom_label: true,
      active_pane_id: "pane-1",
      layout: { type: "split" },
      panes: [
        { id: "pane-1", cols: 80, rows: 24 },
        { id: "pane-2", cols: 80, rows: 24 },
      ],
    }],
  };
  assert.equal(controller.apply(state, { focus: true }), true);
  assert.equal(controller.isApplying(), false);
  assert.equal(tabs.has("tab-stale"), false);
  assert.equal(retainedTab.panes.has("pane-old"), false);
  assert.equal(retainedTab.panes.has("pane-2"), true);
  assert.equal(retainedPane.workspaceExitPending, false);
  assert.equal(retainedPane.exitExpected, false);
  assert.equal(retainedPane.pendingConnect, true);
  assert.ok(calls.some(([name, id]) => name === "destroy-history" && id === "pane-stale"));
  assert.ok(calls.some(([name, id]) => name === "dispose-pane" && id === "pane-old"));
  assert.ok(calls.some(([name, id]) => name === "active" && id === "tab-1"));
  assert.deepEqual(calls.at(-1), ["flush", "workspace_restored"]);
  assert.equal(windowObject.size(), 1);
  windowObject.flush();
  assert.ok(calls.some(([name]) => name === "resize"));
  assert.ok(calls.some(([name, id]) => name === "connect" && id === "tab-1"));
});

test("workspace state apply rejects stale state and runApplying always restores the flag", () => {
  const controller = createWorkspaceStateApplyController({
    getActiveName: () => "current",
    getActiveGeneration: () => 2,
    isCurrentRequest: () => false,
    responseSelector: () => "stale",
    lifecycleOptions: { windowObject: createFrameWindow() },
  });
  assert.equal(controller.apply({ selector: "stale", tabs: [] }), false);
  assert.throws(() => controller.runApplying(() => {
    assert.equal(controller.isApplying(), true);
    throw new Error("stop");
  }), /stop/);
  assert.equal(controller.isApplying(), false);
  assert.equal(controller.dispose(), true);
  assert.equal(controller.runApplying(() => true), false);
});

test("workspace state apply lifecycle cancels late frames on dispose", () => {
  const windowObject = createFrameWindow();
  let calls = 0;
  const lifecycle = createWorkspaceStateApplyLifecycle({ windowObject });
  lifecycle.scheduleFrame(() => { calls += 1; });
  assert.equal(windowObject.size(), 1);
  assert.equal(lifecycle.dispose(), true);
  windowObject.flush();
  assert.equal(calls, 0);
  assert.equal(lifecycle.dispose(), false);
});

test("passive membership sync preserves current tab, pane, buttons, layout and pending input", () => {
  const windowObject = createFrameWindow();
  const first = { id: "one", name: "demo", socket: {}, pendingInput: ["unfinished"] };
  const second = { id: "two", name: "demo", socket: {} };
  const layout = { type: "split", children: [{ type: "leaf", paneId: "one" }, { type: "leaf", paneId: "two" }] };
  const button = {};
  const tab = { id: "tab-1", label: "first", activePaneId: "one", layout, button, panes: new Map([["one", first], ["two", second]]) };
  const tabs = new Map([[tab.id, tab]]);
  const calls = [];
  let controller;
  controller = createWorkspaceStateApplyController({
    getTabs: () => tabs, getActiveName: () => "demo", getActiveTabId: () => "tab-1",
    responseSelector: (state) => state.selector,
    createTab: (options) => { const next = { id: options.id, panes: new Map(), button: {} }; tabs.set(next.id, next); return next; },
    closeTab: (id) => { assert.equal(controller.isApplying(), true); tabs.delete(id); },
    createPaneSession: (next, name, options) => next.panes.set(options.id, { id: options.id, name, socket: {} }),
    clearTabButtons: () => calls.push("clear-buttons"), recreateTabButton: () => calls.push("recreate"),
    renderTabLayout: (next) => calls.push(`layout:${next.id}`),
    setActiveTab: () => calls.push("activate"), resizeActiveTabForCurrentDevice: () => calls.push("resize"),
    applyRecentTabIds: () => calls.push("recent"), clearRestartTabForReload: () => calls.push("clear-restart"),
    syncTabButtonOrder: (ordered) => calls.push(ordered.map((next) => next.id)),
    flushPendingMembershipRefresh: () => assert.equal(controller.isApplying(), false),
    lifecycleOptions: { windowObject },
  });
  const firstState = { id: tab.id, label: tab.label, active_pane_id: "two", layout, panes: [{ id: "one" }, { id: "two" }] };
  const remote = { id: "tab-remote", active_pane_id: "three", layout: { type: "leaf", paneId: "three" }, panes: [{ id: "three", cols: 80, rows: 24 }] };
  controller.apply({ selector: "demo", tabs: [firstState, remote], active_tab_id: remote.id, recent_tab_ids: [remote.id, tab.id] }, { preserveLocalState: true });
  assert.equal(tabs.get(tab.id), tab);
  assert.equal(tab.button, button);
  assert.equal(tab.layout, layout);
  assert.equal(tab.panes.get("one"), first);
  assert.equal(tab.activePaneId, "one", "remote active pane cannot steal local focus");
  assert.deepEqual(first.pendingInput, ["unfinished"]);
  assert.deepEqual(calls, ["layout:tab-remote", ["tab-1", "tab-remote"]]);
  assert.equal(windowObject.size(), 0, "unrelated membership must not schedule resize/activation");
  assert.equal(controller.getRevision(), 1);
  controller.apply({ selector: "demo", tabs: [firstState] }, { preserveLocalState: true });
  assert.equal(tabs.has(remote.id), false);
  assert.equal(tabs.get(tab.id), tab);
  assert.equal(windowObject.size(), 0);
});

test("background membership updates retain valid pending work for the current tab", () => {
  const windowObject = createFrameWindow();
  const tab = { id: "tab-1", activePaneId: "one", layout: { type: "leaf", paneId: "one" }, panes: new Map([["one", { id: "one", socket: {} }]]) };
  const tabs = new Map([[tab.id, tab]]);
  const calls = [];
  const controller = createWorkspaceStateApplyController({
    getTabs: () => tabs, getActiveName: () => "demo", getActiveTabId: () => tab.id,
    createTab: (options) => { const next = { id: options.id, panes: new Map() }; tabs.set(next.id, next); return next; },
    createPaneSession: (next, name, options) => next.panes.set(options.id, { id: options.id, name, socket: {} }),
    resizeActiveTabForCurrentDevice: () => calls.push("resize"),
    connectPendingSessionsForTab: (next) => calls.push(next.id),
    lifecycleOptions: { windowObject },
  });
  const first = { id: tab.id, active_pane_id: "one", layout: tab.layout, panes: [{ id: "one" }] };
  controller.apply({ tabs: [first] });
  controller.apply({ tabs: [first, { id: "tab-2", panes: [{ id: "two" }], active_pane_id: "two" }] }, { preserveLocalState: true });
  windowObject.flush();
  assert.deepEqual(calls, ["resize", "tab-1"], "unrelated background sync cannot cancel the current tab's initial fit/connect");
});
