/** Injected into MeshBasic / MeshPhong via onBeforeCompile — displacement + normals. */
export const baseDisplaceVertexChunk = /* glsl */ `
uniform sampler2D uDepth;
uniform float uDisplace;
uniform float uInvertDepth;
uniform vec2 uCardSize;
uniform vec2 uDepthTexel;

float sampleDepthBA(vec2 uv) {
  float d = texture2D(uDepth, clamp(uv, vec2(0.001), vec2(0.999))).r;
  if (uInvertDepth > 0.5) d = 1.0 - d;
  return d;
}

vec3 displacedPosition(vec3 pos, vec2 uv) {
  float d = sampleDepthBA(uv);
  pos.z += (d - 0.4) * uDisplace;
  return pos;
}

vec3 displacedNormal(vec2 uv) {
  vec2 t = uDepthTexel;
  float dx = sampleDepthBA(uv + vec2(t.x, 0.0)) - sampleDepthBA(uv - vec2(t.x, 0.0));
  float dy = sampleDepthBA(uv + vec2(0.0, t.y)) - sampleDepthBA(uv - vec2(0.0, t.y));
  float sx = uDisplace / max(uCardSize.x * t.x, 1e-5);
  float sy = uDisplace / max(uCardSize.y * t.y, 1e-5);
  return normalize(vec3(-dx * sx * 0.5, dy * sy * 0.5, 1.0));
}
`

export const cloudVertex = /* glsl */ `
attribute float aSize;
attribute float aSeed;
attribute float aDepth;
attribute float aMotion;
attribute float aSpeed;
attribute vec3 aColor;
attribute vec3 aScatter;

uniform float uTime;
uniform float uPixelRatio;
uniform float uExplode;
uniform vec2 uMouse;
uniform float uPointScale;
uniform float uFlowSpeed;
uniform float uSwirl;
uniform float uClay;

uniform vec2 uScanOrigin;
uniform float uScanStart;
uniform float uScanSpeed;
uniform float uScanActive;

varying vec3 vColor;
varying float vAlpha;

void main() {
  vec3 tint = mix(aColor, vec3(0.72), uClay);
  vColor = tint;

  vec3 home = position;

  // Drift backward — speed/amplitude driven by aMotion (depth gradient).
  float cycle = fract(uTime * aSpeed * uFlowSpeed + aSeed);
  float move = smoothstep(0.02, 0.15, aMotion);
  float life = mix(0.0, cycle, max(move, 0.001));

  float drift = life * (0.08 + aMotion * 0.7);
  home.z -= drift;

  float swirl = uSwirl * move;
  home.x += sin(aSeed * 40.0 + life * 4.0) * 0.014 * swirl;
  home.y += cos(aSeed * 30.0 + life * 3.2) * 0.012 * swirl;
  // Extra vortex curl around seed axis
  float ang = life * 6.2831853 * (0.35 + aSeed * 0.65) * uSwirl;
  vec2 radial = vec2(
    cos(aSeed * 17.0),
    sin(aSeed * 23.0)
  ) * (0.01 + aMotion * 0.028);
  home.xy += vec2(
    radial.x * cos(ang) - radial.y * sin(ang),
    radial.x * sin(ang) + radial.y * cos(ang)
  ) * move;

  float fadeIn = smoothstep(0.0, 0.1, life);
  float fadeOut = 1.0 - smoothstep(0.5, 1.0, life);
  float flowAlpha = fadeIn * fadeOut;
  float baseAlpha = mix(0.35, flowAlpha, move);

  float scanGlow = 0.0;
  float splashAmt = 0.0;
  if (uScanActive > 0.5 && uScanStart >= 0.0) {
    float age = max(uTime - uScanStart, 0.0);
    float depthLag = (1.0 - aDepth) * 0.42;
    vec2 delta = position.xy - uScanOrigin;
    float radialDist = length(delta);
    float warped = radialDist + (0.55 - aDepth) * 0.22 + depthLag;

    float R = age * uScanSpeed;
    float band = 0.055 + aSeed * 0.025;
    float crest = 1.0 - smoothstep(0.0, band, abs(warped - R));
    float crest2 = 1.0 - smoothstep(0.0, band * 1.4, abs(warped - (R * 0.82)));
    crest2 *= smoothstep(0.35, 0.85, aSeed);

    float wake = smoothstep(R + 0.04, R - 0.32, warped);
    wake *= exp(-age * 0.55) * 0.45;

    float osc = sin(warped * 32.0 - age * 16.0 + aSeed * 12.0)
              * cos(warped * 11.0 + aSeed * 7.0);
    float lift = (crest * 1.0 + crest2 * 0.55) * (0.035 + aDepth * 0.055);
    home.z += lift * (0.65 + 0.35 * osc);

    vec2 dir = delta / max(radialDist, 1e-4);
    vec2 spray = vec2(
      sin(aSeed * 41.0 + age * 9.0),
      cos(aSeed * 27.0 - age * 7.0)
    );
    splashAmt = crest * crest * (0.55 + aSeed * 0.7) + crest2 * 0.35;
    home.xy += dir * splashAmt * 0.085 * (0.4 + aDepth);
    home.xy += spray * splashAmt * 0.035;
    home.z += splashAmt * aSeed * 0.05;

    scanGlow = clamp(crest * 1.35 + crest2 * 0.55 + wake, 0.0, 1.0);
    scanGlow *= 1.0 - smoothstep(1.6, 2.4, age);
    splashAmt *= 1.0 - smoothstep(1.6, 2.4, age);
  }

  vec3 holo = mix(vec3(0.15, 0.95, 1.0), vec3(0.75, 0.35, 1.0), fract(aSeed * 3.1 + aDepth));
  holo += vec3(0.2, 0.5, 0.35) * splashAmt;
  // In clay mode, keep scan highlight monochrome
  holo = mix(holo, vec3(0.92), uClay);
  vColor = mix(vColor, vColor * 0.25 + holo, scanGlow);

  float e = uExplode;
  float ease = e * e * (3.0 - 2.0 * e);
  vec3 pos = mix(home, home + aScatter, ease);

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z -= aDepth * 1.5e-4 * gl_Position.w;

  float sizeBoost = mix(1.0, 1.12, ease) * mix(1.0, 1.0 - life * 0.3, move);
  sizeBoost *= 1.0 + scanGlow * 0.85 + splashAmt * 0.5;
  gl_PointSize = max(aSize * uPointScale * uPixelRatio * sizeBoost * (3.35 / -mv.z), 1.0);

  vAlpha = mix(baseAlpha, baseAlpha * 0.75, ease);
  vAlpha = min(1.0, vAlpha + scanGlow * 0.35);
}
`

export const cloudFragment = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 c = gl_PointCoord - vec2(0.5);
  float d = length(c);
  if (d > 0.48) discard;
  float mask = 1.0 - smoothstep(0.42, 0.48, d);
  float alpha = mask * vAlpha;
  if (alpha < 0.35) discard;
  vec3 linear = sRGBTransferEOTF(vec4(vColor, 1.0)).rgb;
  gl_FragColor = vec4(linear, alpha);
  #include <colorspace_fragment>
}
`
