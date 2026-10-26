// Reference-D65 HSLuv mirror of core color_correction.rs. Inputs/outputs remain
// linear sRGB; Three.js applies screen encoding once at the output boundary.
const M = [
  [3.240969941904521, -1.537383177570093, -.498610760293],
  [-.96924363628087, 1.87596750150772, .041555057407175],
  [.055630079696993, -.20397695888897, 1.056971514242878],
];
function maxChroma(l, h) {
  const sub = ((l + 16) / 116) ** 3, y = sub > 216 / 24389 ? sub : l / (24389 / 27);
  let chroma = Infinity;
  for (const [a, b, c] of M) for (const t of [0, 1]) {
    const top1 = (284517 * a - 94839 * c) * y;
    const top2 = (838422 * c + 769860 * b + 731718 * a) * l * y - 769860 * t * l;
    const bottom = (632260 * c - 126452 * b) * y + 126452 * t;
    const length = top2 / (bottom * Math.sin(h) - top1 * Math.cos(h));
    if (length >= 0) chroma = Math.min(chroma, length);
  }
  return chroma;
}
export function linearToHsluv([r, g, b]) {
  if (![r, g, b].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('Invalid linear pigment');
  const x = .41239079926595*r + .35758433938387*g + .18048078840183*b;
  const y = .21263900587151*r + .71516867876775*g + .072192315360733*b;
  const z = .019330818715591*r + .11919477979462*g + .95053215224966*b;
  const l = y <= 216/24389 ? y*(24389/27) : 116*Math.cbrt(y)-16;
  if (l < 1e-8) return [0, 0, 0];
  if (l > 99.9999999) return [0, 0, 100];
  const d = x+15*y+3*z, u = 13*l*(4*x/d-.19783000664283), v = 13*l*(9*y/d-.46831999493879);
  const c = Math.hypot(u,v);
  if (c < 1e-6) return [0,0,l];
  const h = Math.atan2(v,u);
  return [(h*180/Math.PI+360)%360, Math.min(100,Math.max(0,100*c/maxChroma(l,h))), l];
}
export function blendHsluv(a, b, t) {
  a = [...a]; b = [...b];
  const chromatic = c => c[1] > 1e-4 && c[2] > 1e-5 && c[2] < 99.99999;
  if (!chromatic(a)) a[0] = chromatic(b) ? b[0] : 0;
  if (!chromatic(b)) b[0] = a[0];
  const wrap = h => ((h%360)+360)%360;
  let delta = wrap(wrap(b[0])-wrap(a[0])); if (delta > 180) delta -= 360;
  return [wrap(a[0]+delta*t), a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
}
export function hsluvToLinear([h,s,l]) {
  if (l <= 1e-8) return [0,0,0]; if (l >= 99.9999999) return [1,1,1];
  h *= Math.PI/180;
  const sub = ((l+16)/116)**3, y = sub > 216/24389 ? sub : l/(24389/27);
  const c = maxChroma(l,h)*s/100, u = c*Math.cos(h)/(13*l)+.19783000664283, v = c*Math.sin(h)/(13*l)+.46831999493879;
  const x = 9*y*u/(4*v), z = y*(12-3*u-20*v)/(4*v);
  return M.map(m => Math.min(1,Math.max(0,m[0]*x+m[1]*y+m[2]*z)));
}

// Only the final HSLuv color converts per fragment. The three constant regional
// attributes convert on upload, avoiding three inverse conversions per pixel.
export const pigmentGLSL = `
vec3 blendHsluv(vec3 a, vec3 b, float t) {
  bool ac = a.y > .0001 && a.z > .00001 && a.z < 99.99999;
  bool bc = b.y > .0001 && b.z > .00001 && b.z < 99.99999;
  if (!ac) a.x = bc ? b.x : 0.;
  if (!bc) b.x = a.x;
  float delta = mod(b.x-a.x+360.,360.);
  if (delta > 180.) delta -= 360.;
  return vec3(mod(a.x+delta*t+360.,360.), mix(a.yz,b.yz,t));
}
float pigmentBound(vec3 m, float l, float y, float h) {
  float top1 = (284517.*m.x-94839.*m.z)*y;
  float top2 = (838422.*m.z+769860.*m.y+731718.*m.x)*l*y;
  float bottom = (632260.*m.z-126452.*m.y)*y;
  float chroma = 1.e20;
  for (int i=0; i<2; i++) {
    float t = float(i);
    float length = (top2-769860.*t*l)/((bottom+126452.*t)*sin(h)-top1*cos(h));
    if (length >= 0.) chroma = min(chroma,length);
  }
  return chroma;
}
vec3 hsluvToLinear(vec3 hsl) {
  float l = hsl.z;
  if (l <= .00000001) return vec3(0.);
  if (l >= 99.99999) return vec3(1.);
  float h = radians(hsl.x), sub = pow((l+16.)/116.,3.);
  float y = sub > 216./24389. ? sub : l/(24389./27.);
  vec3 m0 = vec3(3.240969941904521,-1.537383177570093,-.498610760293);
  vec3 m1 = vec3(-.96924363628087,1.87596750150772,.041555057407175);
  vec3 m2 = vec3(.055630079696993,-.20397695888897,1.056971514242878);
  float c = min(min(pigmentBound(m0,l,y,h),pigmentBound(m1,l,y,h)),pigmentBound(m2,l,y,h))*hsl.y/100.;
  float u = c*cos(h)/(13.*l)+.19783000664283, v = c*sin(h)/(13.*l)+.46831999493879;
  vec3 xyz = vec3(9.*y*u/(4.*v),y,y*(12.-3.*u-20.*v)/(4.*v));
  return clamp(vec3(dot(m0,xyz),dot(m1,xyz),dot(m2,xyz)),0.,1.);
}
`;
