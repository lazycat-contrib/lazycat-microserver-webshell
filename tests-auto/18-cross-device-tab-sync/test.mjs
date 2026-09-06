import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const host = (page) => page.locator(".terminal-pane.active .terminal-host").first();
const ready = (page) => page.waitForFunction(() => {
  const shell = document.querySelector(".terminal-pane.active .pane-shell");
  return shell?.dataset.renderReady === "true" && shell.dataset.hasPresentedFrame === "true";
}, null, { timeout: 30000 });
const send = async (page, command) => {
  await host(page).click({ position: { x: 24, y: 24 } });
  await page.keyboard.insertText(command);
  await page.keyboard.press("Enter");
};
const output = (page, marker) => page.waitForFunction((value) => String(window.__testsAutoTerminalOutput || "").includes(value), marker, { timeout: 15000 });
const createTab = async (page, cleanupIDs) => {
  const responsePromise = page.waitForResponse((response) => response.request().method() === "POST"
    && response.url().includes("/api/workspace?") && response.request().postDataJSON()?.action === "create_tab");
  await page.locator("#newTab").click();
  const response = await responsePromise;
  assert.ok(response.ok(), "real create_tab API must succeed");
  const state = await response.json();
  cleanupIDs.push(state.active_tab_id);
  await page.waitForFunction((id) => document.querySelector("#tabs .tab.active")?.dataset.tabId === id, state.active_tab_id);
  await ready(page);
  return state.tabs.find((tab) => tab.id === state.active_tab_id);
};
const closeTab = (page, tabID) => page.evaluate(async (tabID) => {
  const selector = new URL(location.href).searchParams.get("name");
  const response = await fetch(`./api/workspace?name=${encodeURIComponent(selector)}&cols=120&rows=32`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "close_tab", tab_id: tabID }),
  });
  if (!response.ok) throw Error(`close_tab HTTP ${response.status}`);
}, tabID);

const startInvariantProbe = (page) => page.evaluate(() => {
  const tabID = document.querySelector("#tabs .tab.active").dataset.tabId;
  const button = document.querySelector("#tabs .tab.active");
  const shell = document.querySelector(".terminal-pane.active .pane-shell");
  const canvas = shell.querySelector("canvas:not(.terminal-frame-hold)");
  const focus = document.activeElement;
  const sockets = (window.__testsAutoSockets || []).slice();
  const probe = { tabID, samples: [], stopped: false, socketsBefore: sockets.length };
  window.__crossTabProbe = probe;
  const sample = () => {
    if (probe.stopped) return;
    const style = getComputedStyle(canvas);
    probe.samples.push({ tabID: document.querySelector("#tabs .tab.active")?.dataset.tabId,
      buttonSame: document.querySelector(`#tabs .tab[data-tab-id="${CSS.escape(tabID)}"]`) === button,
      shellSame: document.querySelector(".terminal-pane.active .pane-shell") === shell,
      canvasSame: shell.querySelector("canvas:not(.terminal-frame-hold)") === canvas,
      connected: canvas.isConnected, visible: style.visibility === "visible" && style.display !== "none",
      focusSame: document.activeElement === focus,
      sockets: (window.__testsAutoSockets || []).length,
    });
    requestAnimationFrame(sample);
  };
  sample();
});

const stopInvariantProbe = (page) => page.evaluate(() => { window.__crossTabProbe.stopped = true; return window.__crossTabProbe; });
const assertInvariantProbe = (probe) => {
  assert.ok(probe.samples.length > 0);
  assert.ok(probe.samples.every((s) => s.tabID === probe.tabID && s.buttonSame && s.shellSame && s.canvasSame && s.connected && s.visible && s.focusSame && s.sockets === probe.socketsBefore), "remote membership sync must retain PC focus, DOM, Canvas and physical sockets");
};

export async function run({ config, states, artifactsDir, eventLog, assertNoFatalErrors }) {
  assert.ok(config.localStaticDir, "current frontend build is required");
  const { desktop, mobile } = states;
  const cleanupIDs = [];
  const observations = { activity: [], workspaceGets: [], navigations: 0 };
  const pendingResponses = new Set();
  let measuring = false;
  const onResponse = (response) => {
    if (!measuring || response.request().method() !== "GET" || !response.ok()) return;
    const url = new URL(response.url());
    if (!url.pathname.endsWith("/api/workspace/activity") && !url.pathname.endsWith("/api/workspace")) return;
    const task = response.json().then((state) => {
      const entry = { at: Date.now(), paneIDs: (state.panes || state.tabs?.flatMap((tab) => tab.panes) || []).map((pane) => pane.id).sort() };
      if (url.pathname.endsWith("/activity")) observations.activity.push(entry);
      else observations.workspaceGets.push(entry);
    }).finally(() => pendingResponses.delete(task));
    pendingResponses.add(task);
  };
  const onNavigate = (request) => {
    if (measuring && request.isNavigationRequest() && request.frame() === desktop.page.mainFrame()) observations.navigations += 1;
  };
  desktop.page.on("response", onResponse);
  desktop.page.on("request", onNavigate);
  try {
    await ready(desktop.page);
    await createTab(desktop.page, cleanupIDs);
    await createTab(desktop.page, cleanupIDs);
    // Setup only: both devices see the same three dedicated test tabs before
    // the measured remote creation. Never reload PC after this point.
    await mobile.page.reload({ waitUntil: "domcontentloaded" });
    await ready(mobile.page);
    await desktop.page.locator(`#tabs .tab[data-tab-id="${desktop.testTabID}"]`).click();
    await ready(desktop.page);
    const marker = `AUTO_CROSS_TAB_${Date.now()}`;
    await send(desktop.page, `printf '%s%s\\n' '${marker}' '_READY'; i=0; while [ "$i" -lt 120 ]; do printf 'CROSS%03d\\n' "$i"; i=$((i+1)); sleep 0.1; done; printf '%s%s\\n' '${marker}' '_DONE'`);
    await output(desktop.page, `${marker}_READY`);
    await startInvariantProbe(desktop.page);
    const documentTimeOrigin = await desktop.page.evaluate(() => performance.timeOrigin);
    measuring = true;
    const remoteTab = await createTab(mobile.page, cleanupIDs);
    const remotePaneIDs = remoteTab.panes.map((pane) => pane.id);
    await eventLog({ status: "info", action: "mobile-created-tab", tabID: remoteTab.id, paneIDs: remotePaneIDs });
    await desktop.page.locator(`#tabs .tab[data-tab-id="${remoteTab.id}"]`).waitFor({ state: "visible", timeout: 12000 });
    assert.ok(observations.activity.some((entry) => remotePaneIDs.every((id) => entry.paneIDs.includes(id))), "existing activity must observe remote pane membership");
    assert.ok(observations.workspaceGets.length > 0, "membership change must fetch authoritative workspace");
    await output(desktop.page, `${marker}_DONE`);
    await desktop.page.screenshot({ path: path.join(artifactsDir, "pc-synced-new-tab.png") });
    const pollsBefore = observations.activity.length;
    const getsBefore = observations.workspaceGets.length;
    const deadline = Date.now() + 12000;
    while (observations.activity.length < pollsBefore + 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(observations.activity.length >= pollsBefore + 2, "two unchanged activity responses must arrive");
    assert.equal(observations.workspaceGets.length, getsBefore, "unchanged activity must not poll full workspace");
    const addedProbe = await stopInvariantProbe(desktop.page);
    assertInvariantProbe(addedProbe);
    await fs.writeFile(path.join(artifactsDir, "add-invariants.json"), JSON.stringify(addedProbe));
    await desktop.page.locator(`#tabs .tab[data-tab-id="${remoteTab.id}"]`).click();
    await ready(desktop.page);
    await send(desktop.page, `printf '%s%s\\n' '${marker}' '_NEW_TAB'`);
    await output(desktop.page, `${marker}_NEW_TAB`);
    await desktop.page.screenshot({ path: path.join(artifactsDir, "pc-new-tab-usable.png") });
    await desktop.page.locator(`#tabs .tab[data-tab-id="${desktop.testTabID}"]`).click();
    await ready(desktop.page);
    await host(desktop.page).click({ position: { x: 24, y: 24 } });
    await startInvariantProbe(desktop.page);
    await closeTab(mobile.page, remoteTab.id);
    cleanupIDs.splice(cleanupIDs.indexOf(remoteTab.id), 1);
    await desktop.page.locator(`#tabs .tab[data-tab-id="${remoteTab.id}"]`).waitFor({ state: "detached", timeout: 12000 });
    const probe = await stopInvariantProbe(desktop.page);
    assert.equal(observations.navigations, 0, "PC must not reload");
    assert.equal(await desktop.page.evaluate(() => performance.timeOrigin), documentTimeOrigin, "PC document/runtime must remain the same");
    assertInvariantProbe(probe);
    await send(desktop.page, `printf '%s%s\\n' '${marker}' '_INPUT'`);
    await output(desktop.page, `${marker}_INPUT`);
    assertNoFatalErrors();
    await eventLog({ status: "pass", action: "cross-device-tab-sync", activityResponses: observations.activity.length, workspaceGets: observations.workspaceGets.length, sampleCount: probe.samples.length });
  } finally {
    measuring = false;
    desktop.page.off("response", onResponse);
    desktop.page.off("request", onNavigate);
    await Promise.allSettled([...pendingResponses]);
    const probe = await desktop.page.evaluate(() => { if (window.__crossTabProbe) window.__crossTabProbe.stopped = true; return window.__crossTabProbe || null; }).catch(() => null);
    await fs.writeFile(path.join(artifactsDir, "cross-tab-sync.json"), JSON.stringify({ observations, probe }));
    await eventLog({ status: "info", action: "cross-tab-sync-evidence", ...observations, sampleCount: probe?.samples?.length || 0 });
    const errors = [];
    for (const id of cleanupIDs.reverse()) await closeTab(mobile.page, id).catch((error) => errors.push(error.message));
    if (errors.length) throw Error(`cross-tab cleanup failed: ${errors.join("; ")}`);
  }
}
