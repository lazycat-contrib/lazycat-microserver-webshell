const noop = () => {};

export function createTerminalSessionConnectionLifecycle({
  windowObject = globalThis.window,
  getActiveName = () => "",
  now = () => Date.now(),
  isSocketOpen = (socket) => socket?.readyState === 1,
  isSocketConnecting = (socket) => socket?.readyState === 0,
  sendPing = (socket) => socket?.send?.(JSON.stringify({ type: "ping" })),
  isReplayCommitted = () => false,
  flushPendingInput = noop,
  closeSocketForReconnect = noop,
  pingIntervalMs = 10 * 1000,
  healthTimeoutMs = 25 * 1000,
  resumeProbeTimeoutMs = 1500,
  connectTimeoutMs = 12 * 1000,
  attachReadyTimeoutMs = 8 * 1000,
  attachMaxDurationMs = 60 * 1000,
  agentPrepareTimeoutMs = 45 * 1000,
} = {}) {
  const sessions = new Set();
  const attachWatches = new WeakMap();
  let disposed = false;

  const clearTimeoutField = (session, field) => {
    if (!session?.[field]) {
      return false;
    }
    windowObject?.clearTimeout?.(session[field]);
    session[field] = 0;
    return true;
  };

  const clearReconnectTimer = (session) => {
    clearTimeoutField(session, "reconnectTimer");
    if (session) {
      session.reconnectPending = false;
    }
    return Boolean(session);
  };

  const clearSocketHealthTimer = (session) => {
    if (!session?.socketHealthTimer) {
      return false;
    }
    windowObject?.clearInterval?.(session.socketHealthTimer);
    session.socketHealthTimer = 0;
    return true;
  };

  const clearSocketConnectTimer = (session) => clearTimeoutField(session, "socketConnectTimer");
  const clearAttachReadyTimer = (session) => {
    if (session) attachWatches.delete(session);
    return clearTimeoutField(session, "attachReadyTimer");
  };
  const clearSocketResumeProbeTimer = (session) => clearTimeoutField(session, "resumeProbeTimer");

  const clearConnectionTimers = (session) => {
    clearSocketConnectTimer(session);
    clearSocketHealthTimer(session);
    clearAttachReadyTimer(session);
    clearSocketResumeProbeTimer(session);
    sessions.delete(session);
    return Boolean(session);
  };

  const markSocketHealth = (session, currentSocket) => {
    if (disposed || session?.socket !== currentSocket) {
      return false;
    }
    session.lastSocketHealthAt = now();
    clearSocketResumeProbeTimer(session);
    flushPendingInput(session);
    return true;
  };

  const probeOpenSocket = (session, { allowHidden = false } = {}) => {
    const socket = session?.socket;
    if (
      disposed
      || !socket
      || !isSocketOpen(socket)
      || session.closed
      || session.name !== getActiveName()
    ) {
      return false;
    }
    const probeStartedAt = now();
    clearSocketResumeProbeTimer(session);
    try {
      sendPing(socket);
    } catch (error) {
      closeSocketForReconnect(
        session,
        socket,
        `Terminal WebSocket resume probe failed: ${session.name}/${session.id}`,
        { allowHidden },
      );
      return false;
    }
    sessions.add(session);
    session.resumeProbeTimer = windowObject?.setTimeout?.(() => {
      session.resumeProbeTimer = 0;
      if (disposed || session.socket !== socket || !isSocketOpen(socket)) {
        return;
      }
      const lastHealth = Number(session.lastSocketHealthAt || 0);
      if (lastHealth < probeStartedAt) {
        closeSocketForReconnect(
          session,
          socket,
          `Terminal WebSocket resume probe timed out: ${session.name}/${session.id}`,
          { allowHidden },
        );
      }
    }, resumeProbeTimeoutMs) || 0;
    return true;
  };

  const startSocketHealthMonitor = (session, currentSocket) => {
    if (disposed || !session) {
      return false;
    }
    clearSocketHealthTimer(session);
    markSocketHealth(session, currentSocket);
    sessions.add(session);
    session.socketHealthTimer = windowObject?.setInterval?.(() => {
      if (disposed || session.socket !== currentSocket) {
        clearSocketHealthTimer(session);
        return;
      }
      if (!isSocketOpen(currentSocket)) {
        return;
      }
      const lastHealth = Number(session.lastSocketHealthAt || 0);
      const healthTimeout = session.agentPreparing ? agentPrepareTimeoutMs : healthTimeoutMs;
      if (lastHealth > 0 && now() - lastHealth > healthTimeout) {
        closeSocketForReconnect(
          session,
          currentSocket,
          `Terminal WebSocket health timeout: ${session.name}/${session.id}`,
        );
        return;
      }
      try {
        sendPing(currentSocket);
      } catch (error) {
        closeSocketForReconnect(
          session,
          currentSocket,
          `Terminal WebSocket ping failed: ${session.name}/${session.id}`,
        );
      }
    }, pingIntervalMs) || 0;
    return true;
  };

  const startSocketConnectTimer = (session, currentSocket) => {
    if (disposed || !session) {
      return false;
    }
    clearSocketConnectTimer(session);
    sessions.add(session);
    session.socketConnectTimer = windowObject?.setTimeout?.(() => {
      session.socketConnectTimer = 0;
      if (disposed || session.socket !== currentSocket || !isSocketConnecting(currentSocket)) {
        return;
      }
      closeSocketForReconnect(
        session,
        currentSocket,
        `Terminal WebSocket connect timed out: ${session.name}/${session.id}`,
      );
    }, connectTimeoutMs) || 0;
    return true;
  };

  const watchIsCurrent = (session, watch) => Boolean(
    !disposed && session && !session.closed && watch
    && attachWatches.get(session) === watch && session.socket === watch.socket
    && Number(session.connectionEpoch || 0) === watch.connectionEpoch
  );

  const inspectAttach = (session, watch, checkedAt) => {
    if (!watchIsCurrent(session, watch) || isReplayCommitted(session)) return false;
    // Only validated history cursor advancement counts. Ping/focus/resize must
    // not keep a replay with no usable output alive indefinitely.
    const received = session.receivedHistoryCursor ?? 0n;
    const applied = session.appliedHistoryCursor ?? 0n;
    const phase = String(session.replayController?.phase || "");
    const advancedPhase = phase !== watch.phase && ["replaying", "awaiting_commit"].includes(phase);
    if (advancedPhase || received > watch.received || applied > watch.applied) {
      watch.lastProgressAt = checkedAt;
      watch.received = received;
      watch.applied = applied;
    }
    watch.phase = phase;
    return checkedAt >= watch.deadline || checkedAt - watch.lastProgressAt >= watch.idleTimeout;
  };

  const checkAttachReady = (session, currentSocket) => {
    const watch = attachWatches.get(session);
    return currentSocket === watch?.socket && inspectAttach(session, watch, now());
  };

  const startAttachReadyTimer = (session, currentSocket, timeoutMs = attachReadyTimeoutMs) => {
    if (disposed || !session) {
      return false;
    }
    const previousWatch = attachWatches.get(session);
    const preserveDeadline = watchIsCurrent(session, previousWatch);
    clearAttachReadyTimer(session);
    session.attachStartedAt = preserveDeadline ? previousWatch.startedAt : now();
    session.attachReadyTimeoutMs = timeoutMs;
    sessions.add(session);
    const watch = {
      socket: currentSocket,
      startedAt: session.attachStartedAt,
      connectionEpoch: Number(session.connectionEpoch || 0),
      received: session.receivedHistoryCursor ?? 0n,
      applied: session.appliedHistoryCursor ?? 0n,
      phase: String(session.replayController?.phase || ""),
      lastProgressAt: session.attachStartedAt,
      idleTimeout: timeoutMs,
      deadline: preserveDeadline ? previousWatch.deadline : session.attachStartedAt + Math.max(timeoutMs, attachMaxDurationMs),
    };
    attachWatches.set(session, watch);
    const schedule = (checkedAt) => {
      const dueAt = Math.min(watch.deadline, watch.lastProgressAt + watch.idleTimeout);
      session.attachReadyTimer = windowObject?.setTimeout?.(() => {
        if (!watchIsCurrent(session, watch)) return;
        session.attachReadyTimer = 0;
        if (isReplayCommitted(session)) { attachWatches.delete(session); return; }
        const at = Math.max(now(), dueAt);
        if (inspectAttach(session, watch, at)) {
          attachWatches.delete(session);
          closeSocketForReconnect(session, currentSocket,
            `Terminal attach timed out before replay complete: ${session.name}/${session.id}`);
        } else {
          schedule(at);
        }
      }, Math.max(1, dueAt - checkedAt)) || 0;
    };
    schedule(now());
    return true;
  };

  const disposeSession = (session) => {
    clearReconnectTimer(session);
    return clearConnectionTimers(session);
  };

  const dispose = () => {
    if (disposed) {
      return false;
    }
    disposed = true;
    for (const session of Array.from(sessions)) {
      disposeSession(session);
    }
    sessions.clear();
    return true;
  };

  return Object.freeze({
    clearAttachReadyTimer,
    checkAttachReady,
    clearConnectionTimers,
    clearReconnectTimer,
    clearSocketConnectTimer,
    clearSocketHealthTimer,
    clearSocketResumeProbeTimer,
    dispose,
    disposeSession,
    markSocketHealth,
    probeOpenSocket,
    startAttachReadyTimer,
    startSocketConnectTimer,
    startSocketHealthMonitor,
  });
}
