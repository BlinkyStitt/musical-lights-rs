export function requireHardwareRenderer(renderer) {
  if (typeof renderer !== 'string' || !renderer.trim()) {
    throw new Error('GPU validation requires a WebGL2 hardware renderer');
  }
  if (/swiftshader|llvmpipe|softpipe|software/i.test(renderer)) {
    throw new Error(`GPU validation requires hardware rendering; found ${renderer}`);
  }
  return renderer;
}
