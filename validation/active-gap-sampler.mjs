// Browser-only collector. The production submission hook supplies frames; no
// independent rAF loop can turn skipped draws into successful FPS evidence.
export function collectActiveGapPerformance(view, mode, evaluatePerformance) {
  return new Promise((resolve, reject) => {
    const report = view.report, intervals = [], renderCosts = [], progress = [], invalid = new Set();
    const viewport = [innerWidth, innerHeight], camera = JSON.stringify(view.cameraParameters.values);
    const workloadKeys = ['source', 'kind', 'state', 'repeat', 'diagnostics', 'sampleRate', 'dbfs', 'frequency', 'channel', 'pascalsPerUnit'];
    // Audio session events also contain the restart callback and live processor.
    // Snapshot evidence fields only, detaching continuity from later mutations.
    const audioSnapshot = (state = report.audioState) => structuredClone(Object.fromEntries([...workloadKeys, 'sessionId', 'continuity', 'reason',
      'peakAmplitude', 'audioStart', 'calibrated', 'selectedChannel'].filter(key => key in state)
      .map(key => [key, state[key]])));
    const workload = audioSnapshot(), audioTransitions = [], invalidations = [], renderProgress = [];
    const scrolling = view.card.querySelector('.scroll-lights').checked;
    const cameraMotion = view.settings.cameraMotion, cameraBase = view.cameraBase;
    const config = report.readConfig(), layout = [...view.layout], palette = Array.from(view.palette);
    const oldFrame = report.frame, oldReceive = report.receive, oldInvalidate = report.invalidate;
    const oldOnFrame = view.onFrame, oldReady = view.gpuFrames.ready;
    let start, previous, lastProgress = -Infinity, maxSnapshotAgeMs = 0, finishing = false;
    const captureStarted = performance.now();
    let lastAnimation, lastRenderProgress = -Infinity;
    let callbacks = 0, submissions = 0, backpressure = 0, maxAnimationGapMs = 0, maxSubmissionDelayMs = 0;
    const invalidate = reason => {
      if (!invalid.has(reason)) invalidations.push({ reason, atMs: performance.now() - captureStarted, audio: audioSnapshot() });
      invalid.add(reason);
    };
    const check = () => {
      if (!report.acceptanceWorkload() || report.audioState.sessionId !== workload.sessionId
        || report.audioState.continuity?.segment !== workload.continuity?.segment)
        invalidate('Audio interrupted or changed');
      for (const key of workloadKeys)
        if (report.audioState[key] !== workload[key]) invalidate('Audio workload changed');
      if (document.hidden) invalidate('Page hidden during test');
      if (view.lost || view.closed) invalidate('Renderer stopped during test');
      if (view.sceneVisible === false) invalidate('Visualizer left viewport');
      if (view.card.hasAttribute('data-expanded') !== (mode !== 'normal')
        || innerWidth !== viewport[0] || innerHeight !== viewport[1]) invalidate('View changed during test');
      if (JSON.stringify(view.cameraParameters.values) !== camera || view.settings.cameraMotion !== cameraMotion
        || view.cameraBase !== cameraBase) invalidate('Camera changed during test');
      if (view.card.querySelector('.scroll-lights').checked !== scrolling) invalidate('Scrolling changed during test');
    };
    const audioChanged = ({ detail }) => {
      if (audioTransitions.length < 64) audioTransitions.push({ atMs: performance.now() - captureStarted, audio: audioSnapshot(detail) });
      else invalidate('Audio event evidence capacity exceeded');
      check();
    };
    const hidden = () => { if (document.hidden) invalidate('Page hidden during test'); };
    const lost = () => invalidate('WebGL context lost');
    const cleanup = () => {
      clearTimeout(deadline);
      report.frame = oldFrame; report.receive = oldReceive; report.invalidate = oldInvalidate;
      view.onFrame = oldOnFrame; view.gpuFrames.ready = oldReady;
      view.card.removeEventListener('audio-session', audioChanged);
      document.removeEventListener('visibilitychange', hidden);
      view.canvas.removeEventListener('webglcontextlost', lost);
    };
    const deadline = setTimeout(() => {
      cleanup(); reject(new Error('Performance capture ended without a complete five-minute worker report'));
    }, 330000);
    report.invalidate = reason => { invalidate(reason); oldInvalidate.call(report, reason); };
    // Observe the production loop without creating another animation clock.
    // These counters explain missing submissions; only frame() feeds acceptance.
    view.onFrame = (...args) => {
      oldOnFrame.apply(view, args);
      if (start === undefined || finishing || args[1]) return;
      const now = performance.now(), elapsedMs = now - start;
      callbacks++;
      if (lastAnimation !== undefined) maxAnimationGapMs = Math.max(maxAnimationGapMs, now - lastAnimation);
      lastAnimation = now;
      if (elapsedMs - lastRenderProgress >= 1000) {
        if (renderProgress.length < 400) renderProgress.push({ elapsedMs, callbacks, submissions, backpressure,
          maxAnimationGapMs, maxSubmissionDelayMs, debtMs: view.metrics.debt,
          maxSchedulingGapMs: view.metrics.maxSchedulingGap, maxStepMs: view.metrics.maxStepMs });
        else invalidate('Render progress evidence capacity exceeded');
        lastRenderProgress = elapsedMs;
        callbacks = submissions = backpressure = maxAnimationGapMs = maxSubmissionDelayMs = 0;
      }
    };
    view.gpuFrames.ready = function () {
      const ready = oldReady.call(this);
      if (start !== undefined && !finishing && !ready) backpressure++;
      return ready;
    };
    report.receive = data => {
      if (data.type === 'recording') { start = data.timestamp - performance.timeOrigin; return; }
      if (data.type !== 'report') return oldReceive.call(report, data);
      check();
      const invalidReasons = [...invalid];
      const evaluation = evaluatePerformance({ intervals, renderCosts, progress, maxSnapshotAgeMs,
        invalid: invalidReasons, hz: layout[1], data });
      cleanup();
      resolve({ ...data, type: 'musical-lights-phone-report-v8', layout, palette, config: data.config,
        mode, viewport, camera: JSON.parse(camera), cameraBase, cameraMotion, scrolling, workload,
        physicalPhone: false, evidenceEnvironment: 'hardware-rendered desktop Chromium with mobile viewport',
        warmupSeconds: 15, measurementSeconds: 300, frameIntervalsMs: intervals, renderCostsMs: renderCosts,
        simulationProgress: progress, maxSnapshotAgeMs, invalidReasons, invalidations, audioTransitions,
        finalAudio: audioSnapshot(), renderProgress, ...evaluation });
    };
    report.frame = (timestamp, cost) => {
      oldFrame.call(report, timestamp, cost); check();
      if (start === undefined || finishing) return;
      submissions++;
      maxSubmissionDelayMs = Math.max(maxSubmissionDelayMs, performance.now() - timestamp);
      const elapsed = performance.now() - start;
      if (elapsed < 15000) return;
      maxSnapshotAgeMs = Math.max(maxSnapshotAgeMs, view.metrics.snapshotAgeMs);
      if (intervals.length >= 60000 || renderCosts.length >= 60000) invalidate('Frame report capacity exceeded');
      else {
        if (previous !== undefined) intervals.push(timestamp - previous);
        renderCosts.push(cost);
      }
      previous = timestamp;
      if (elapsed - lastProgress >= 1000) {
        progress.push({ elapsedMs: elapsed - 15000, tick: view.metrics.physicsSteps,
          debtMs: view.metrics.debt, snapshotAgeMs: view.metrics.snapshotAgeMs });
        lastProgress = elapsed;
      }
      if (elapsed >= 315000) { finishing = true; view.worker.postMessage({ type: 'report' }); }
    };
    view.card.addEventListener('audio-session', audioChanged);
    document.addEventListener('visibilitychange', hidden);
    view.canvas.addEventListener('webglcontextlost', lost);
    check();
    if (!config || layout[1] !== 120 || !report.acceptanceWorkload() || Math.abs(config[11] - .6) > 1e-6
      || (mode === 'landscape-fullscreen' ? innerWidth <= innerHeight : innerWidth > innerHeight)) {
      cleanup(); reject(new Error('Invalid active-gap acceptance workload or view')); return;
    }
    view.worker.postMessage({ type: 'record', config });
  });
}
