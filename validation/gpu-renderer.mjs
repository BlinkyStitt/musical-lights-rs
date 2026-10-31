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
