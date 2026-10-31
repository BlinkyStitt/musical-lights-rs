// Browser-only collector. The production submission hook supplies frames; no
// independent rAF loop can turn skipped draws into successful FPS evidence.
export function collectActiveGapPerformance(view, mode, evaluatePerformance) {
  return new Promise((resolve, reject) => {
    const report = view.report, intervals = [], renderCosts = [], progress = [], invalid = new Set();
    const viewport = [innerWidth, innerHeight], camera = JSON.stringify(view.cameraParameters.values);
    const workload = structuredClone(report.audioState), scrolling = view.card.querySelector('.scroll-lights').checked;
    const cameraMotion = view.settings.cameraMotion, cameraBase = view.cameraBase;
    const config = report.readConfig(), layout = [...view.layout], palette = Array.from(view.palette);
    const oldFrame = report.frame, oldReceive = report.receive, oldInvalidate = report.invalidate;
    let start, previous, lastProgress = -Infinity, maxSnapshotAgeMs = 0, finishing = false;
    const invalidate = reason => invalid.add(reason);
    const check = () => {
      if (!report.acceptanceWorkload() || report.audioState.sessionId !== workload.sessionId
        || report.audioState.continuity?.segment !== workload.continuity?.segment)
        invalidate('Audio interrupted or changed');
      for (const key of ['source', 'kind', 'state', 'repeat', 'diagnostics', 'sampleRate', 'dbfs', 'frequency', 'channel', 'pascalsPerUnit'])
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
    const audioChanged = () => check(), hidden = () => { if (document.hidden) invalidate('Page hidden during test'); };
    const lost = () => invalidate('WebGL context lost');
    const cleanup = () => {
      clearTimeout(deadline);
      report.frame = oldFrame; report.receive = oldReceive; report.invalidate = oldInvalidate;
      view.card.removeEventListener('audio-session', audioChanged);
      document.removeEventListener('visibilitychange', hidden);
      view.canvas.removeEventListener('webglcontextlost', lost);
    };
    const deadline = setTimeout(() => {
      cleanup(); reject(new Error('Performance capture ended without a complete five-minute worker report'));
    }, 330000);
    report.invalidate = reason => { invalidate(reason); oldInvalidate.call(report, reason); };
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
        simulationProgress: progress, maxSnapshotAgeMs, invalidReasons, ...evaluation });
    };
    report.frame = (timestamp, cost) => {
      oldFrame.call(report, timestamp, cost); check();
      if (start === undefined || finishing) return;
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
