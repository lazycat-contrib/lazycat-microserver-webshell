import { createWorkspaceRefreshLifecycle } from "./refresh_lifecycle.js";

export function createWorkspaceRefreshController({
  getActiveName = () => "",
  getActiveGeneration = () => 0,
  isCurrentRequest = () => true,
  fetchWorkspaceState = () => Promise.reject(new Error("Workspace fetch is unavailable.")),
  ensureResponseSelector = () => {},
  observeServerRevision = () => {},
  applyWorkspaceState = () => {},
  markStartupMetric = () => {},
  appendStartupTrace = () => {},
  performanceNow = () => Date.now(),
  measureTask = (name, task) => task(),
  getTabCount = () => 0,
  getStateRevision = () => 0,
  getMutationState = () => ({ version: 0, pending: false }),
  lifecycleFactory = createWorkspaceRefreshLifecycle,
  lifecycleOptions = {},
} = {}) {
  let latestRecoveryMetrics = null;
  let disposed = false;
  let lifecycle = null;
  let membershipRequest = null;

  const request = async ({
    instanceName = getActiveName(),
    generation = getActiveGeneration(),
  } = {}) => {
    const requestName = String(instanceName || "").trim();
    if (disposed) {
      throw new Error("Workspace refresh controller is disposed.");
    }
    const stateRevision = getStateRevision();
    const mutationVersion = getMutationState().version;
    const recoveryMetrics = {
      selector: requestName,
      generation,
      startedAt: performanceNow(),
      readyAt: 0,
    };
    if (isCurrentRequest(requestName, generation)) {
      latestRecoveryMetrics = recoveryMetrics;
    }
    markStartupMetric("workspaceRequestStartedAt");
    appendStartupTrace("workspace 请求开始", `selector=${requestName}`, {
      dedupeKey: `workspace-request:${requestName}`,
    });
    const state = await fetchWorkspaceState(requestName);
    if (disposed || !isCurrentRequest(requestName, generation)) {
      return { state, requestName, generation, stateRevision, mutationVersion };
    }
    recoveryMetrics.readyAt = performanceNow();
    markStartupMetric("workspaceReadyAt");
    appendStartupTrace("workspace 响应完成", `selector=${requestName}`, {
      dedupeKey: `workspace-ready:${requestName}`,
    });
    return { state, requestName, generation, stateRevision, mutationVersion };
  };

  const apply = ({ state, requestName, generation, stateRevision, mutationVersion }, { focus = false } = {}) => {
    if (disposed || !isCurrentRequest(requestName, generation)) {
      return state;
    }
    if ((stateRevision !== undefined && stateRevision !== getStateRevision())
      || (mutationVersion !== undefined && mutationVersion !== getMutationState().version)
      || getMutationState().pending) return state;
    ensureResponseSelector(state, requestName);
    observeServerRevision(state);
    applyWorkspaceState(state, { focus, instanceName: requestName, generation });
    markStartupMetric("workspaceAppliedAt");
    appendStartupTrace("workspace 应用完成", `tabs=${getTabCount()}`, {
      dedupeKey: "workspace-applied",
    });
    lifecycle?.clear();
    return state;
  };

  const refresh = async ({
    focus = false,
    instanceName = getActiveName(),
    generation = getActiveGeneration(),
  } = {}) => measureTask("workspace refresh", async () => {
    const result = await request({ instanceName, generation });
    return apply(result, { focus });
  });

  lifecycle = lifecycleFactory({
    ...lifecycleOptions,
    getActiveName,
    getActiveGeneration,
    isCurrentRequest,
    isDisposed: () => disposed,
    runRefresh: (context) => refresh(context),
  });

  const refreshWithRetry = async (options = {}) => {
    try {
      return await refresh(options);
    } catch (error) {
      if (error?.agentProtocolUpdateRequired !== true) {
        lifecycle.schedule(options);
      }
      throw error;
    }
  };

  const syncMembership = ({ instanceName = getActiveName(), generation = getActiveGeneration(), paneIDs = [] } = {}) => {
    if (disposed || getStateRevision() === 0 || !isCurrentRequest(instanceName, generation) || getMutationState().pending) return Promise.resolve(false);
    const key = JSON.stringify(paneIDs);
    if (membershipRequest?.instanceName === instanceName && membershipRequest.generation === generation) {
      if (membershipRequest.key !== key) {
        membershipRequest.key = key;
        membershipRequest.observation += 1;
      }
      return membershipRequest.promise;
    }
    const context = { instanceName, generation, key, observation: 0, promise: null };
    membershipRequest = context;
    const current = () => !disposed && membershipRequest === context && isCurrentRequest(instanceName, generation);
    context.promise = (async () => {
      // Each extra iteration requires a new activity observation received while
      // this request was in flight. Failures do not create a retry timer/loop.
      do {
        const observation = context.observation;
        const revision = getStateRevision();
        const mutation = getMutationState();
        if (mutation.pending) return false;
        const state = await fetchWorkspaceState(instanceName);
        if (!current() || revision !== getStateRevision() || mutation.version !== getMutationState().version || getMutationState().pending) return false;
        if (observation !== context.observation) continue;
        ensureResponseSelector(state, instanceName);
        if (!Array.isArray(state?.tabs) || state.tabs.some((tab) => !Array.isArray(tab?.panes))) throw new Error("Workspace membership response is incomplete");
        observeServerRevision(state);
        return applyWorkspaceState(state, { focus: false, instanceName, generation, preserveLocalState: true });
      } while (current());
      return false;
    })().finally(() => { if (membershipRequest === context) membershipRequest = null; });
    return context.promise;
  };

  const dispose = () => {
    if (disposed) {
      return false;
    }
    disposed = true;
    membershipRequest = null;
    lifecycle.dispose();
    latestRecoveryMetrics = null;
    return true;
  };

  return Object.freeze({
    apply,
    clearRetry: () => lifecycle.clear(),
    dispose,
    getLatestRecoveryMetrics: () => latestRecoveryMetrics ? { ...latestRecoveryMetrics } : null,
    getRetryContext: () => lifecycle.getContext(),
    isDisposed: () => disposed,
    refresh,
    refreshWithRetry,
    request,
    resumeRetry: () => lifecycle.resume(),
    scheduleRetry: (options) => lifecycle.schedule(options),
    syncMembership,
  });
}
