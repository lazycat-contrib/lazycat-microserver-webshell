import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { instanceSelector } from "../runtime/static/instances/index.js";
import { redactBrowserArtifacts, redactDiagnosticText } from "./artifact-redaction.mjs";

const testsAutoDir = path.dirname(fileURLToPath(import.meta.url));
const localModuleRoot = path.join(testsAutoDir, "node_modules");
const sharedModuleRoot = path.resolve(testsAutoDir, "../../lzc-os/onbox-tester/e2e/node_modules");

const loadDotenvDefaults = async () => {
  let contents;
  try {
    contents = await fs.readFile(path.join(testsAutoDir, ".env"), "utf8");
  } catch {
    return;
  }
  for (let line of contents.split(/\r?\n/)) {
    line = line.trimStart();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
};
await loadDotenvDefaults();

const moduleRoot = process.env.PLAYWRIGHT_NODE_PATH
  || await fs.access(path.join(localModuleRoot, "@playwright/test/index.mjs")).then(() => localModuleRoot).catch(() => sharedModuleRoot);
const { chromium } = await import(pathToFileURL(path.join(moduleRoot, "@playwright/test/index.mjs")));

const envFlag = (value, fallback) => {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
};

export const config = {
  url: process.env.WEBSHELL_TEST_URL
    || "https://lightos.debug123.heiyu.space/webshell/?name=devos-core%40cloud.lazycat.lightos.entry&tab=tab-4",
  username: String(process.env.WEBSHELL_TEST_USERNAME || ""),
  password: String(process.env.WEBSHELL_TEST_PASSWORD || ""),
  rounds: Math.max(1, Number.parseInt(process.env.TEST_ROUNDS || "3", 10) || 3),
  foreground: process.env.HEADLESS === "1"
    ? false
    : envFlag(process.env.TEST_FOREGROUND, true),
  localStaticDir: String(process.env.WEBSHELL_LOCAL_STATIC_DIR || "").trim(),
  mobileUserAgent: String(process.env.WEBSHELL_MOBILE_USER_AGENT || "").trim(),
  mobileDeviceScaleFactor: Math.max(1, Number(process.env.WEBSHELL_MOBILE_DEVICE_SCALE_FACTOR || "1") || 1),
  captureTerminalTimeline: envFlag(process.env.WEBSHELL_CAPTURE_TERMINAL_TIMELINE, false),
  enableInitializationPerformance: envFlag(process.env.WEBSHELL_ENABLE_INITIALIZATION_PERFORMANCE, false),
};

const installLocalStaticRoute = async (context) => {
  if (!config.localStaticDir) return;
  const staticRoot = path.resolve(config.localStaticDir);
  const localIndex = await fs.readFile(path.join(staticRoot, "index.html"), "utf8");
  await context.route(/\/webshell\/(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET" || route.request().resourceType() !== "document") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: localIndex.replaceAll("__LCMD_ASSET_BASE__", "./assets/tests-auto-local/"),
    });
  });
  await context.route(/\/assets\/[^/]+\/.+/, async (route) => {
    const requestURL = new URL(route.request().url());
    const match = requestURL.pathname.match(/\/assets\/[^/]+\/(.+)$/);
    if (!match) {
      await route.continue();
      return;
    }
    const relativePath = decodeURIComponent(match[1]);
    const localPath = path.resolve(staticRoot, relativePath);
    if (localPath !== staticRoot && !localPath.startsWith(`${staticRoot}${path.sep}`)) {
      await route.abort("blockedbyclient");
      return;
    }
    try {
      await fs.access(localPath);
      await route.fulfill({ path: localPath });
    } catch {
      await route.continue();
    }
  });
};

const runID = new Date().toISOString().replaceAll(/[:.]/g, "-");
const caseFile = path.resolve(process.argv[2] || "");
if (!caseFile) throw new Error("usage: node run-playwright.mjs <case>/test.mjs");
const caseDir = path.dirname(caseFile);
const artifactsDir = path.join(caseDir, "artifacts", runID);
await fs.mkdir(artifactsDir, { recursive: true });
const eventsPath = path.join(artifactsDir, "events.jsonl");
const errorsPath = path.join(artifactsDir, "error.txt");
const eventLog = async (event) => {
  const record = { at: new Date().toISOString(), ...event };
  await fs.appendFile(eventsPath, `${redactDiagnosticText(JSON.stringify(record), [config.username, config.password])}\n`);
  if (record.status !== "info" || record.action !== "console") {
    process.stdout.write(`[${record.status || "event"}] ${record.action || record.message || ""}\n`);
  }
};

const textDecoder = new TextDecoder();
const decodeQueueFrame = (data) => {
  if (typeof data === "string") {
    try {
      const value = JSON.parse(data);
      if (typeof value?.data === "string") return { text: value.data, header: value };
      if (typeof value?.payload?.data === "string") return { text: value.payload.data, header: value };
    } catch {}
    return { text: data, header: null };
  }
  if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return null;
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.length < 8 || textDecoder.decode(bytes.subarray(0, 4)) !== "LCQ1") {
    return { header: null, text: textDecoder.decode(bytes) };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(4, false);
  if (headerLength <= 0 || 8 + headerLength > bytes.length) return null;
  let header;
  try { header = JSON.parse(textDecoder.decode(bytes.subarray(8, 8 + headerLength))); } catch { return null; }
  return { header, text: textDecoder.decode(bytes.subarray(8 + headerLength)) };
};

const outerResize = (frame) => {
  if (!frame) return null;
  if (typeof frame !== "string") {
    if (!(frame instanceof ArrayBuffer) && !ArrayBuffer.isView(frame)) return null;
    const bytes = frame instanceof ArrayBuffer
      ? new Uint8Array(frame)
      : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
    frame = textDecoder.decode(bytes);
  }
  try {
    const value = JSON.parse(frame);
    const control = value?.control;
    const resize = value?.type === "pane-control" ? control : value;
    if (resize?.type !== "resize") return null;
    return {
      paneID: String(value?.pane_id || ""),
      cols: Number(resize.cols),
      rows: Number(resize.rows),
      pixelWidth: Number(resize.pixel_width || 0),
      pixelHeight: Number(resize.pixel_height || 0),
      resizeEpoch: resize.resize_epoch || "",
      claim: resize.claim === true,
    };
  } catch { return null; }
};

const loginIfNeeded = async (page, name) => {
  if (!page.url().includes("/sys/login")) return false;
  if (!config.username || !config.password) {
    throw new Error("WEBSHELL_TEST_USERNAME and WEBSHELL_TEST_PASSWORD are required when the test target requests login");
  }
  await page.locator("#username").fill(config.username);
  await page.locator("#password").fill(config.password);
  await page.locator("#submit").waitFor({ state: "visible" });
  await page.locator("#submit").click();
  await page.waitForURL((url) => !url.pathname.includes("/sys/login"), { timeout: 30_000 });
  await eventLog({ status: "pass", window: name, action: "click-login-submit", result: "authenticated" });
  return true;
};

const resolveTestURL = async (page, windowName) => {
  const requestedURL = new URL(config.url);
  const requestedName = requestedURL.searchParams.get("name") || "";
  const instancesURL = new URL("./api/instances", new URL("/webshell/", requestedURL));
  const response = await page.request.get(instancesURL.toString());
  if (!response.ok()) throw new Error(`instances ${response.status()}: ${await response.text()}`);
  const instances = await response.json();
  const selectors = new Set(instances.map(instanceSelector));
  if (requestedName && selectors.has(requestedName) && (config.targetKind !== "client" || requestedName.startsWith("client:"))) return requestedURL.toString();
  if (config.targetKind === "client" || requestedName.startsWith("client:")) {
    const client = !requestedName.startsWith("client:") && instances.find((instance) => (
      instanceSelector(instance).startsWith("client:") && instance.status === "running"
    ));
    if (!client) throw new Error("CLIENT_TARGET_UNAVAILABLE: no authorized running client: terminal; container fallback is forbidden");
    requestedURL.searchParams.set("name", instanceSelector(client));
    requestedURL.searchParams.delete("tab");
    return requestedURL.toString();
  }
  const fallback = instances.find((instance) => instance.status === "running");
  if (!fallback) throw new Error(`requested instance ${requestedName || "(empty)"} is unavailable and no running fallback exists`);
  const fallbackName = instanceSelector(fallback);
  requestedURL.searchParams.set("name", fallbackName);
  requestedURL.searchParams.delete("tab");
  await eventLog({ status: "pass", window: windowName, action: "select-running-instance", requestedName, selectedName: fallbackName });
  return requestedURL.toString();
};

const createWindow = async (name, viewport, position, onCreated, beforeNavigate) => {
  const headless = !config.foreground;
  const browser = await chromium.launch({
    headless,
    channel: process.env.PW_CHANNEL || "chrome",
    args: [`--window-size=${viewport.width},${viewport.height}`, `--window-position=${position.x},${position.y}`],
  });
  const context = await browser.newContext({
    viewport,
    hasTouch: name === "mobile",
    isMobile: name === "mobile",
    ...(name === "mobile" ? { deviceScaleFactor: config.mobileDeviceScaleFactor } : {}),
    ...(name === "mobile" && config.mobileUserAgent ? { userAgent: config.mobileUserAgent } : {}),
    ignoreHTTPSErrors: true,
    serviceWorkers: config.localStaticDir ? "block" : "allow",
  });
  const targetOrigin = new URL(config.url).origin;
  await context.grantPermissions(["local-network-access"], { origin: targetOrigin }).catch(() => {});
  await installLocalStaticRoute(context);
  const page = await context.newPage();
  const state = { name, page, browser, context, framesSent: [], output: "", lastResize: null, fatalErrors: [], assetRequestFailures: [], resizeErrors: 0, initialTerminalTimeline: [] };
  onCreated?.(state);
  await page.addInitScript(({ captureTimeline, enableInitializationPerformance }) => {
    if (captureTimeline || enableInitializationPerformance) {
      window.localStorage.setItem("webshell.debugMode", "true");
    }
    if (captureTimeline) {
      window.localStorage.setItem("webshell.debugLog", "true");
    }
    if (enableInitializationPerformance) {
      window.localStorage.setItem("webshell.initializationPerformance", "true");
    }
    window.__testsAutoResizeFrames = [];
    window.__testsAutoResizeResponses = [];
    window.__testsAutoResizeTrace = [];
    window.__testsAutoTerminalOutput = "";
    window.__testsAutoSockets = [];
    window.__testsAutoPresentationProbe = {
      startedAt: performance.now(),
      samples: [],
      stopped: false,
    };
    const capturePresentationSample = () => {
      const probe = window.__testsAutoPresentationProbe;
      if (!probe || probe.stopped) return;
      const describeCanvas = (canvas) => {
        if (!(canvas instanceof HTMLCanvasElement)) {
          return { width: 0, height: 0, cssWidth: 0, cssHeight: 0, hidden: null };
        }
        const rect = canvas.getBoundingClientRect();
        return {
          width: canvas.width,
          height: canvas.height,
          cssWidth: rect.width,
          cssHeight: rect.height,
          hidden: canvas.hidden === true,
        };
      };
      probe.samples.push({
        at: performance.now(),
        devicePixelRatio: window.devicePixelRatio || 1,
        panes: Array.from(document.querySelectorAll(".terminal-pane")).map((pane) => {
          const shell = pane.querySelector(".pane-shell");
          const liveCanvas = pane.querySelector(".terminal-host canvas:not(.terminal-frame-hold)");
          const holdCanvas = pane.querySelector(".terminal-frame-hold");
          return {
            paneID: shell?.dataset?.paneId || "",
            tabID: pane.dataset?.tabId || "",
            connection: shell?.dataset?.connection || "",
            renderReady: shell?.dataset?.renderReady || "",
            hasPresentedFrame: shell?.dataset?.hasPresentedFrame || "",
            liveCanvas: describeCanvas(liveCanvas),
            holdCanvas: describeCanvas(holdCanvas),
          };
        }),
      });
      if (probe.samples.length > 8000) probe.samples.splice(0, probe.samples.length - 8000);
      requestAnimationFrame(capturePresentationSample);
    };
    requestAnimationFrame(capturePresentationSample);
    window.__testsAutoSentMessages = [];
    const NativeWebSocket = window.WebSocket;
    const send = NativeWebSocket.prototype.send;
    NativeWebSocket.prototype.send = function autoTestObservedSend(data) {
      if (typeof data === "string") {
        try {
          const value = JSON.parse(data);
          window.__testsAutoSentMessages.push(value);
          const resize = value?.type === "pane-control" ? value.control : value;
          if (resize?.type === "resize") {
            window.__testsAutoResizeFrames.push({
              paneID: String(value?.pane_id || ""),
              cols: Number(resize.cols),
              rows: Number(resize.rows),
              pixelWidth: Number(resize.pixel_width || 0),
              pixelHeight: Number(resize.pixel_height || 0),
              resizeEpoch: resize.resize_epoch || "",
              claim: resize.claim === true,
            });
          }
        } catch {}
      }
      return send.call(this, data);
    };
    const appendMessage = async (data) => {
      if (data instanceof Blob) data = await data.arrayBuffer();
      if (typeof data === "string") {
        try {
          const value = JSON.parse(data);
          const control = value?.type === "pane-control" ? value.payload : value;
          if (control?.type === "resize-applied" || control?.type === "resize-error") {
            window.__testsAutoResizeResponses.push({
              paneID: String(value?.pane_id || control?.pane_id || ""),
              type: String(control.type),
              resizeEpoch: String(control.resize_epoch || ""),
              cols: Number(control.cols || 0),
              rows: Number(control.rows || 0),
              pixelWidth: Number(control.pixel_width || 0),
              pixelHeight: Number(control.pixel_height || 0),
              reason: String(control.reason || ""),
            });
            if (window.__testsAutoResizeResponses.length > 4000) {
              window.__testsAutoResizeResponses.splice(0, window.__testsAutoResizeResponses.length - 4000);
            }
          }
          if (typeof value?.data === "string") window.__testsAutoTerminalOutput += value.data;
          else if (typeof value?.payload?.data === "string") window.__testsAutoTerminalOutput += value.payload.data;
        } catch {}
        return;
      }
      if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return;
      const bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      let payload = bytes;
      if (bytes.length >= 8 && new TextDecoder().decode(bytes.subarray(0, 4)) === "LCQ1") {
        const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, false);
        if (headerLength > 0 && 8 + headerLength <= bytes.length) payload = bytes.subarray(8 + headerLength);
      }
      window.__testsAutoTerminalOutput += new TextDecoder().decode(payload);
    };
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args);
        window.__testsAutoSockets.push(socket);
        socket.addEventListener("message", (event) => { appendMessage(event.data).catch(() => {}); });
        return socket;
      },
    });
  }, {
    captureTimeline: config.captureTerminalTimeline,
    enableInitializationPerformance: config.enableInitializationPerformance,
  });
  await beforeNavigate?.(state);
  page.on("console", (message) => {
    const text = message.text();
    const sourceURL = String(message.location()?.url || "");
    const ignorableFaviconError = message.type() === "error" && /\/favicon\.ico(?:$|[?#])/.test(sourceURL);
    if (text.includes("resize-error")) state.resizeErrors += 1;
    if (message.type() === "error" && !ignorableFaviconError) state.fatalErrors.push(`console error: ${text}`);
    eventLog({ status: "info", window: name, action: "console", type: message.type(), sourceURL, message: text });
  });
  page.on("pageerror", (error) => {
    state.fatalErrors.push(`pageerror: ${error.message}`);
    eventLog({ status: "error", window: name, action: "pageerror", message: error.message });
  });
  page.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText || "";
    const aborted = errorText.includes("ERR_ABORTED");
    const message = `${request.method()} ${request.url()} ${errorText}`;
    const assetFailure = !aborted && request.url().includes("/assets/");
    const apiFailure = !aborted && request.url().includes("/api/");
    if (assetFailure) state.assetRequestFailures.push(message);
    if (assetFailure || apiFailure) state.fatalErrors.push(`requestfailed: ${message}`);
    eventLog({
      status: assetFailure || apiFailure ? "error" : "info",
      window: name,
      action: "requestfailed",
      message,
    });
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && response.url().includes("/api/")) {
      const message = `HTTP ${response.status()} ${response.request().method()} ${response.url()}`;
      state.fatalErrors.push(message);
      eventLog({ status: "error", window: name, action: "api-response", message });
    }
  });
  page.on("websocket", (websocket) => {
    websocket.on("framesent", (data) => {
      const resize = outerResize(data);
      if (resize) {
        state.lastResize = resize;
        state.framesSent.push(resize);
      }
    });
    websocket.on("framereceived", (data) => {
      const frame = decodeQueueFrame(data);
      if (frame?.text) state.output += frame.text;
    });
  });
  const authURL = new URL("/", config.url).toString();
  await page.goto(authURL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const loggedIn = await loginIfNeeded(page, name);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const testURL = await resolveTestURL(page, name);
  await page.goto(testURL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".terminal-pane.active .terminal-host", { timeout: 60_000 });
  await page.waitForTimeout(2_000);
  state.initialTerminalTimeline = await page.evaluate(() => (
    globalThis.__testsAutoTerminalTimelineSnapshot?.() || []
  )).catch(() => []);
  await eventLog({ status: "pass", window: name, action: "open", viewport, deviceScaleFactor: name === "mobile" ? config.mobileDeviceScaleFactor : 1, loggedIn, url: page.url() });
  return state;
};

const activity = async (state) => state.page.evaluate(async () => {
  const name = new URLSearchParams(location.search).get("name");
  const response = await fetch(`./api/workspace/activity?name=${encodeURIComponent(name || "")}&cols=120&rows=32`, { cache: "no-store" });
  if (!response.ok) throw new Error(`workspace activity ${response.status}: ${await response.text()}`);
  return response.json();
});

const paneSize = (state, snapshot) => {
  const panes = snapshot?.panes || [];
  return panes.find((pane) => pane.id === state.activePaneID) || panes[0] || null;
};

const waitForResizeApplied = async (state, previous, action, frameCountBefore, resizeErrorsBefore = state.resizeErrors) => {
  const syncObservedFrames = async () => {
    const observed = await state.page.evaluate(() => window.__testsAutoResizeFrames || []);
    state.framesSent = observed;
    state.lastResize = observed.at(-1) || state.lastResize;
  };
  await syncObservedFrames();
  const deadline = Date.now() + 8_000;
  while (state.framesSent.length <= frameCountBefore && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await syncObservedFrames();
  }
  if (state.framesSent.length <= frameCountBefore) {
    throw new Error(`${action}: interaction did not send a new resize frame`);
  }
  if (!state.lastResize || state.lastResize.cols <= 0 || state.lastResize.rows <= 0) {
    throw new Error(`${action}: no resize frame was sent after interaction`);
  }
  const resizeErrors = state.resizeErrors - resizeErrorsBefore;
  let candidates = state.framesSent.slice(frameCountBefore).filter((frame) => frame.cols > 0 && frame.rows > 0);
  const deadlineApplied = Date.now() + 15_000;
  let latest = null;
  let applied = null;
  let expected = null;
  while (Date.now() < deadlineApplied) {
    await syncObservedFrames();
    candidates = state.framesSent.slice(frameCountBefore).filter((frame) => frame.cols > 0 && frame.rows > 0);
    latest = await activity(state);
    applied = paneSize(state, latest);
    expected = candidates.find((frame) => Number(applied?.cols) === frame.cols && Number(applied?.rows) === frame.rows) || null;
    if (expected && applied) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!expected || !applied) {
    const sent = candidates.map((frame) => `${frame.cols}x${frame.rows}`).join(", ");
    throw new Error(`${action}: server size ${applied?.cols}x${applied?.rows || "?"} did not match resize frames [${sent}] (resize-error events: ${resizeErrors})`);
  }
  if (previous && previous.cols === expected.cols && previous.rows === expected.rows) {
    throw new Error(`${action}: interaction did not change terminal geometry (${expected.cols}x${expected.rows})`);
  }
  return { expected, applied, resizeErrors };
};

const refreshResizeFrames = async (state) => {
  const observed = await state.page.evaluate(() => window.__testsAutoResizeFrames || []);
  state.framesSent = observed;
  state.lastResize = observed.at(-1) || state.lastResize;
  return observed;
};

const refreshTerminalOutput = async (state) => {
  state.output = await state.page.evaluate(() => window.__testsAutoTerminalOutput || "");
  return state.output;
};

const workspaceAction = async (state, action, payload = {}) => state.page.evaluate(async ({ action, payload }) => {
  const name = new URLSearchParams(location.search).get("name");
  const response = await fetch(`./api/workspace?name=${encodeURIComponent(name || "")}&cols=120&rows=32`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, cols: 120, rows: 32, ...payload }),
  });
  if (!response.ok) throw new Error(`workspace ${action} ${response.status}: ${await response.text()}`);
  return response.json();
}, { action, payload });

const createIsolatedTab = async (state) => {
  const workspace = await workspaceAction(state, "create_tab");
  const tabID = String(workspace.active_tab_id || "").trim();
  if (!tabID) throw new Error("create_tab returned no active_tab_id");
  const url = new URL(state.page.url());
  url.searchParams.set("tab", tabID);
  state.testTabID = tabID;
  await state.page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  await state.page.waitForSelector(".terminal-pane.active .terminal-host", { timeout: 60_000 });
  await state.page.waitForTimeout(1_000);
  await eventLog({ status: "pass", window: state.name, action: "create-isolated-tab", tabID });
  return url.toString();
};

const persistPresentationProbe = async (state, artifactsDir) => {
  const presentationProbe = await state.page.evaluate(() => {
    const probe = globalThis.__testsAutoPresentationProbe;
    if (probe) probe.stopped = true;
    return probe || { startedAt: 0, samples: [] };
  }).catch(() => ({ startedAt: 0, samples: [] }));
  const terminalTimeline = await state.page.evaluate(() => (
    globalThis.__testsAutoTerminalTimelineSnapshot?.() || []
  )).catch(() => []);
  await fs.writeFile(
    path.join(artifactsDir, `${state.name}-terminal-timeline.json`),
    `${JSON.stringify(terminalTimeline)}\n`,
  ).catch(() => {});
  await fs.writeFile(
    path.join(artifactsDir, `${state.name}-terminal-timeline-initial.json`),
    `${JSON.stringify(state.initialTerminalTimeline || [])}\n`,
  ).catch(() => {});
  await fs.writeFile(
    path.join(artifactsDir, `${state.name}-presentation-probe.json`),
    `${JSON.stringify(presentationProbe)}\n`,
  ).catch(() => {});
};

export const run = async (scenario, options = {}) => {
  const states = {};
  config.targetKind = options.targetKind || "";
  if (config.targetKind === "client" && process.env.WEBSHELL_CLIENT_TEST_URL) {
    config.url = process.env.WEBSHELL_CLIENT_TEST_URL;
  }
  try {
    states.desktop = await createWindow("desktop", { width: 1440, height: 900 }, { x: 0, y: 0 }, (state) => { states.desktop = state; }, options.beforeNavigate);
    config.url = await createIsolatedTab(states.desktop);
    states.desktop.activePaneID = await states.desktop.page.locator(".terminal-pane.active .pane-shell").first().getAttribute("data-pane-id");
    if (options.desktopOnly !== true) {
      states.mobile = await createWindow("mobile", { width: 390, height: 844 }, { x: 1450, y: 0 }, (state) => { states.mobile = state; }, options.beforeNavigate);
      states.mobile.activePaneID = await states.mobile.page.locator(".terminal-pane.active .pane-shell").first().getAttribute("data-pane-id");
    }
    const assertNoFatalErrors = () => {
      const errors = Object.values(states).flatMap((state) => state.fatalErrors.map((message) => `${state.name}: ${message}`));
      if (errors.length) throw new Error(errors.join("\n"));
    };
    assertNoFatalErrors();
    await scenario({ config, states, artifactsDir, eventLog, activity, paneSize, waitForResizeApplied, refreshResizeFrames, refreshTerminalOutput, assertNoFatalErrors });
    assertNoFatalErrors();
    await Promise.all(Object.values(states).map((state) => persistPresentationProbe(state, artifactsDir)));
    await eventLog({ status: "pass", action: "case-complete", artifactsDir });
  } catch (error) {
    const message = error?.stack || String(error);
    await fs.writeFile(errorsPath, `${message}\n`);
    for (const state of Object.values(states)) {
      await persistPresentationProbe(state, artifactsDir);
      await state.page.screenshot({ path: path.join(artifactsDir, `${state.name}-failure.png`), fullPage: true }).catch(() => {});
    }
    await eventLog({ status: "error", action: "case-failed", message, artifactsDir });
    throw error;
  } finally {
    if (states.desktop?.testTabID && !states.desktop.page.isClosed()) {
      await workspaceAction(states.desktop, "close_tab", { tab_id: states.desktop.testTabID })
        .then(() => eventLog({ status: "pass", window: "desktop", action: "close-isolated-tab", tabID: states.desktop.testTabID }))
        .catch((error) => eventLog({ status: "error", window: "desktop", action: "close-isolated-tab", message: error.message }));
    }
    await Promise.all(Object.values(states).map(async (state) => state.context.tracing.stop({ path: path.join(artifactsDir, `${state.name}-trace.zip`) }).catch(() => {})));
    await Promise.all(Object.values(states).map(async (state) => state.context.close().catch(() => {})));
    await Promise.all(Object.values(states).map(async (state) => state.browser.close().catch(() => {})));
    const zipUtilities = await import(pathToFileURL(path.join(moduleRoot, "playwright-core/lib/utilsBundle.js")));
    await redactBrowserArtifacts(artifactsDir, {
      secrets: [config.username, config.password],
      yauzl: zipUtilities.yauzl,
      yazl: zipUtilities.yazl,
    });
  }
};

const scenario = await import(pathToFileURL(caseFile));
if (typeof scenario.run !== "function") throw new Error(`${caseFile} must export run(context)`);
await run(scenario.run, scenario);
