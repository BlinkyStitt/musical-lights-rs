export function requireHardwareRenderer(renderer) {
  if (typeof renderer !== 'string' || !renderer.trim()) {
    throw new Error('GPU validation requires a WebGL2 hardware renderer');
  }
  if (/swiftshader|llvmpipe|softpipe|software/i.test(renderer)) {
    throw new Error(`GPU validation requires hardware rendering; found ${renderer}`);
  }
  return renderer;
}

// Chromium needs the full browser channel and the same ANGLE path as GPU CI.
// WebKit keeps its native backend; its reported renderer is checked separately.
export function hardwareBrowserOptions(browserName) {
  return browserName === 'chromium' ? { channel: 'chromium', args: process.platform === 'darwin'
    ? ['--use-angle=metal', '--enable-gpu']
    : ['--use-gl=angle', '--use-angle=gl', '--enable-gpu'] } : {};
}

// WebKit on Linux can mask its WebGL renderer as "Apple GPU". Retain native
// software-renderer thread evidence instead of treating that string as hardware.
export function renderingEvidence(browser, renderer, processes = [], platform = process.platform) {
  const softwareThreads = processes.flatMap(process => (process.tasks ?? [])
    .filter(task => typeof task.name === 'string' && /llvmpipe|softpipe|swiftshader/i.test(task.name))
    .map(task => ({ pid: process.pid, tid: task.tid, name: task.name })));
  let kind;
  if (softwareThreads.length || /swiftshader|llvmpipe|softpipe|software/i.test(renderer ?? '')) kind = 'software';
  else if (typeof renderer !== 'string' || !renderer.trim()
    || (platform === 'linux' && browser === 'webkit' && renderer === 'Apple GPU')) kind = 'unverified';
  else kind = 'hardware';
  return { kind, platform, renderer, softwareThreads };
}
