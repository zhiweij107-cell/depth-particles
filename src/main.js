import * as THREE from 'three'
import { baseDisplaceVertexChunk, cloudVertex, cloudFragment } from './shaders.js'
import {
  estimateDepthFromImage,
  fileToImage,
  canvasToPreviewUrl,
} from './depthEstimate.js'

const MAX_SIDE = 680

const loaderEl = document.getElementById('loader')
const loaderText = document.getElementById('loader-text')
const countLabel = document.getElementById('count-label')

const state = {
  mouse: new THREE.Vector2(0, 0),
  targetMouse: new THREE.Vector2(0, 0),
  explode: 0,
  autoOrbit: false,
  holdUntil: 0,
  pointScale: 1.75,
  camDist: 4.4,
  fov: 32,
  yawDeg: 55,
  pitchDeg: 28,
  maxSide: MAX_SIDE,
  depthScale: 0.22,
  // Min normalized depth-gradient to spawn particles (below = none)
  minGrad: 0.22,
  // User depth map: dark = near, light = far
  invertDepth: true,
  // 'color' | 'clay' — clay = neutral gray Phong relief
  viewMode: 'color',
  flowSpeed: 1.0,
  swirl: 1.0,
}

function setStatus(loading, text) {
  if (text) loaderText.textContent = text
  loaderEl.classList.toggle('hide', !loading)
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })
}

function bindSlider(id, outId, format, onChange, { fireInitial = true } = {}) {
  const input = document.getElementById(id)
  if (!input) return null
  const out = document.getElementById(outId)
  const sync = (fire) => {
    const v = Number(input.value)
    if (out) out.textContent = format(v)
    if (fire) onChange(v)
  }
  input.addEventListener('input', () => sync(true))
  sync(fireInitial)
  return input
}

function readDepthField(img, w, h, invert) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0, w, h)
  const raw = ctx.getImageData(0, 0, w, h).data
  const field = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const v = raw[i * 4] / 255
    field[i] = invert ? 1 - v : v
  }
  const blurred = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let sum = 0
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) sum += field[(y + oy) * w + (x + ox)]
      }
      blurred[y * w + x] = sum / 9
    }
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) field[y * w + x] = blurred[y * w + x]
  }
  return field
}

function makeCardTextures(colorImg, depthImg, invert) {
  const colorTex = new THREE.Texture(colorImg)
  colorTex.colorSpace = THREE.SRGBColorSpace
  colorTex.needsUpdate = true
  colorTex.minFilter = THREE.LinearFilter
  colorTex.magFilter = THREE.LinearFilter

  let depthTex
  if (depthImg) {
    depthTex = new THREE.Texture(depthImg)
    depthTex.colorSpace = THREE.NoColorSpace
    depthTex.needsUpdate = true
    depthTex.minFilter = THREE.LinearFilter
    depthTex.magFilter = THREE.LinearFilter
  } else {
    const c = document.createElement('canvas')
    c.width = c.height = 4
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#737373'
    ctx.fillRect(0, 0, 4, 4)
    depthTex = new THREE.CanvasTexture(c)
    depthTex.colorSpace = THREE.NoColorSpace
  }

  return { colorTex, depthTex, invert: !!invert }
}

function attachDisplaceCompile(mat, extras = {}) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${baseDisplaceVertexChunk}`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        objectNormal = displacedNormal(uv);
        #ifdef USE_TANGENT
          objectTangent = normalize(cross(objectNormal, vec3(0.0, 1.0, 0.0)));
        #endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        transformed = displacedPosition(transformed, uv);`,
      )
    if (extras.afterCompile) extras.afterCompile(shader)
  }
}

/** Continuous displaced photo plate under the particle spray. */
function buildDisplaceBase(colorImg, depthImg, opts = {}) {
  const cardH = opts.cardH ?? 1.62
  const srcW = colorImg.naturalWidth || colorImg.width
  const srcH = colorImg.naturalHeight || colorImg.height
  const aspect = srcW / srcH
  const cardW = cardH * aspect
  const depthScale = opts.depthScale ?? state.depthScale
  const invert = opts.invertDepth ?? state.invertDepth
  const clay = (opts.viewMode ?? state.viewMode) === 'clay'
  const { colorTex, depthTex } = makeCardTextures(colorImg, depthImg, invert)

  const segs = Math.min(280, Math.max(120, Math.round(Math.max(srcW, srcH) / 3.5)))
  const geo = new THREE.PlaneGeometry(cardW, cardH, segs, segs)

  const sharedUD = {
    uDepth: { value: depthTex },
    uDisplace: { value: depthScale },
    uInvertDepth: { value: invert ? 1 : 0 },
    uCardSize: { value: new THREE.Vector2(cardW, cardH) },
    uDepthTexel: { value: new THREE.Vector2(1 / Math.max(segs, 1), 1 / Math.max(segs, 1)) },
  }

  let mat
  if (clay) {
    // Neutral gray Phong — read form only
    mat = new THREE.MeshPhongMaterial({
      color: 0xb6b6b2,
      specular: 0x3a3a38,
      shininess: 28,
      flatShading: false,
      side: THREE.FrontSide,
      depthWrite: true,
      depthTest: true,
      toneMapped: false,
    })
    Object.assign(mat.userData, sharedUD)
    attachDisplaceCompile(mat)
    mat.customProgramCacheKey = () => 'displace-clay-phong-v2'
    colorTex.dispose()
  } else {
    mat = new THREE.MeshBasicMaterial({
      map: colorTex,
      toneMapped: false,
      side: THREE.FrontSide,
      depthWrite: true,
      depthTest: true,
    })
    Object.assign(mat.userData, sharedUD)
    attachDisplaceCompile(mat)
    mat.customProgramCacheKey = () => 'displace-color-basic-v2'
  }

  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.z = -0.002
  mesh.userData.cardW = cardW
  mesh.userData.cardH = cardH
  mesh.userData.textures = clay ? [depthTex] : [colorTex, depthTex]
  mesh.userData.clay = clay
  return mesh
}

/**
 * Density & flow ∝ depth-gradient:
 *   steep depth → dense, fast backward drift
 *   below minGrad → no particles
 */
function buildParticleCloud(colorImg, depthImg, opts = {}) {
  const { maxSide = MAX_SIDE, cardH = 1.62, alphaCut = 8 } = opts
  const minGrad = opts.minGrad ?? state.minGrad

  const side = Math.min(MAX_SIDE, Math.max(180, Math.round(maxSide)))
  const srcW = colorImg.naturalWidth || colorImg.width
  const srcH = colorImg.naturalHeight || colorImg.height
  const scale = Math.min(1, side / Math.max(srcW, srcH))
  const w = Math.max(2, Math.round(srcW * scale))
  const h = Math.max(2, Math.round(srcH * scale))

  const colorCanvas = document.createElement('canvas')
  colorCanvas.width = w
  colorCanvas.height = h
  const cctx = colorCanvas.getContext('2d', { willReadFrequently: true })
  cctx.drawImage(colorImg, 0, 0, w, h)
  const colorData = cctx.getImageData(0, 0, w, h).data

  const invert = opts.invertDepth ?? state.invertDepth
  const depthField = depthImg
    ? readDepthField(depthImg, w, h, invert)
    : new Float32Array(w * h).fill(0.45)

  const sampleD = (x, y) => {
    x = Math.max(0, Math.min(w - 1, x | 0))
    y = Math.max(0, Math.min(h - 1, y | 0))
    return depthField[y * w + x]
  }

  const gradField = new Float32Array(w * h)
  let gradMax = 1e-5
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const g = Math.hypot(
        sampleD(x + 1, y) - sampleD(x - 1, y),
        sampleD(x, y + 1) - sampleD(x, y - 1),
      )
      gradField[y * w + x] = g
      if (g > gradMax) gradMax = g
    }
  }

  const aspect = srcW / srcH
  const cardW = cardH * aspect
  const positions = []
  const colors = []
  const sizes = []
  const seeds = []
  const depths = []
  const motions = []
  const speeds = []
  const scatters = []

  const cellX = cardW / w
  const cellY = cardH / h
  const pointPx = Math.max(1.5, Math.min(2.6, 700 / h))
  const depthScale = opts.depthScale ?? state.depthScale

  const pushParticle = ({ x, y, d, motion, speed, jitter = 0.08, sizeMul = 1 }) => {
    const i = (y * w + x) * 4
    const r = colorData[i]
    const g = colorData[i + 1]
    const b = colorData[i + 2]
    const u = (x + 0.5) / w
    const v = (y + 0.5) / h
    // Sit slightly in front of the displaced plate
    const px = (u - 0.5) * cardW + (Math.random() - 0.5) * cellX * jitter
    const py = (0.5 - v) * cardH + (Math.random() - 0.5) * cellY * jitter
    const pz = (d - 0.4) * depthScale + 0.012

    positions.push(px, py, pz)
    colors.push(r / 255, g / 255, b / 255)
    sizes.push(pointPx * sizeMul * (0.92 + d * 0.12))
    const seed = Math.random()
    seeds.push(seed)
    depths.push(d)
    motions.push(motion)
    speeds.push(speed)

    const ang = seed * Math.PI * 2
    const elev = (Math.random() - 0.35) * Math.PI * 0.5
    const dist = 0.45 + Math.random() * 1.05 + d * 0.35
    scatters.push(
      Math.cos(ang) * Math.cos(elev) * dist,
      Math.sin(elev) * dist * 0.75,
      Math.sin(ang) * Math.cos(elev) * dist * 0.5 + 0.15,
    )
  }

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4
      if (colorData[i + 3] < alphaCut) continue

      const u = (x + 0.5) / w
      const v = (y + 0.5) / h
      const nx = (u - 0.5) * 2
      const ny = (v - 0.5) * 2
      if (Math.abs(nx) ** 4 + Math.abs(ny) ** 4 > 1.0) continue

      const d = sampleD(x, y)
      const gNorm = Math.min(1, gradField[y * w + x] / (gradMax * 0.55))
      if (gNorm < minGrad) continue

      // Remap so minGrad → 0, 1 → 1 for density / speed
      const motion = Math.min(1, (gNorm - minGrad) / Math.max(1e-4, 1 - minGrad))
      const density = Math.pow(motion, 0.75)
      const keepProb = THREE.MathUtils.lerp(0.35, 1.0, density)
      if (Math.random() > keepProb) continue

      const speed = 0.5 + motion * 2.35
      pushParticle({
        x,
        y,
        d,
        motion: Math.max(0.12, motion),
        speed,
        jitter: 0.14 + motion * 0.3,
        sizeMul: 0.9 + motion * 0.22,
      })
      if (motion > 0.25 && Math.random() < 0.3 + motion * 0.55) {
        pushParticle({
          x,
          y,
          d,
          motion: Math.min(1, motion * 1.08),
          speed: speed * (0.9 + Math.random() * 0.45),
          jitter: 0.4,
          sizeMul: 0.72 + motion * 0.15,
        })
      }
      if (motion > 0.55 && Math.random() < 0.4) {
        pushParticle({
          x,
          y,
          d,
          motion: Math.min(1, motion * 1.12),
          speed: speed * (1.05 + Math.random() * 0.5),
          jitter: 0.55,
          sizeMul: 0.65,
        })
      }
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3))
  geo.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1))
  geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1))
  geo.setAttribute('aDepth', new THREE.Float32BufferAttribute(depths, 1))
  geo.setAttribute('aMotion', new THREE.Float32BufferAttribute(motions, 1))
  geo.setAttribute('aSpeed', new THREE.Float32BufferAttribute(speeds, 1))
  geo.setAttribute('aScatter', new THREE.Float32BufferAttribute(scatters, 3))

  const mat = new THREE.ShaderMaterial({
    // depthWrite must be on so nearer points occlude farther ones when orbiting.
    // Pair with hard alpha discard in the fragment shader (soft edges would fight the Z-buffer).
    transparent: true,
    depthWrite: true,
    depthTest: true,
    alphaTest: 0.55,
    toneMapped: false,
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uExplode: { value: 0 },
      uMouse: { value: new THREE.Vector2(0, 0) },
      uPointScale: { value: state.pointScale },
      uFlowSpeed: { value: state.flowSpeed },
      uSwirl: { value: state.swirl },
      uClay: { value: state.viewMode === 'clay' ? 1 : 0 },
      uScanOrigin: { value: new THREE.Vector2(0, 0) },
      uScanStart: { value: -1 },
      uScanSpeed: { value: 1.15 },
      uScanActive: { value: 0 },
    },
    vertexShader: cloudVertex,
    fragmentShader: cloudFragment,
  })

  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  points.userData.count = positions.length / 3
  points.userData.cardW = cardW
  points.userData.cardH = cardH
  return points
}

async function main() {
  setStatus(true, '加载卡面与深度图…')
  const assets = {
    color: await loadImage('/card.jpg'),
    depth: await loadImage('/depth.png').catch(() => null),
  }

  const previewColor = document.getElementById('preview-color')
  const previewDepth = document.getElementById('preview-depth')
  const importStatus = document.getElementById('import-status')

  function setImportStatus(text, busy = false) {
    if (!importStatus) return
    importStatus.textContent = text || ''
    importStatus.classList.toggle('busy', busy)
  }

  function refreshPreviews() {
    if (previewColor && assets.color) {
      previewColor.src = canvasToPreviewUrl(assets.color)
    }
    if (previewDepth && assets.depth) {
      previewDepth.src = canvasToPreviewUrl(assets.depth)
    }
  }

  refreshPreviews()

  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#f5f5f3')

  const camera = new THREE.PerspectiveCamera(
    state.fov,
    window.innerWidth / window.innerHeight,
    0.1,
    40,
  )
  camera.position.set(0, 0.04, state.camDist)

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setClearColor('#f5f5f3', 1)
  document.getElementById('app').appendChild(renderer.domElement)

  // Lights for clay Phong mode (ignored by MeshBasic color mode)
  const amb = new THREE.AmbientLight(0xffffff, 0.42)
  const key = new THREE.DirectionalLight(0xffffff, 0.95)
  key.position.set(2.4, 3.2, 4.2)
  const fill = new THREE.DirectionalLight(0xe8e8f0, 0.38)
  fill.position.set(-2.8, 1.0, 2.2)
  const rim = new THREE.DirectionalLight(0xffffff, 0.22)
  rim.position.set(0.2, -1.5, -3.0)
  scene.add(amb, key, fill, rim)

  const root = new THREE.Group()
  scene.add(root)

  // Invisible hit surface for click → card local XY (scan origin)
  const hitPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(1.2, 1.62),
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
  )
  root.add(hitPlane)
  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.88, 64),
    new THREE.MeshBasicMaterial({
      color: 0xc5c5c1,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    }),
  )
  shadow.rotation.x = -Math.PI / 2
  shadow.position.set(0, -1.02, 0)
  scene.add(shadow)

  let cloud = null
  let baseMesh = null
  let rebuildTimer = 0
  let rebuilding = false

  function disposeMesh(mesh) {
    if (!mesh) return
    root.remove(mesh)
    mesh.geometry?.dispose()
    if (mesh.userData.textures) {
      for (const t of mesh.userData.textures) t?.dispose?.()
      mesh.userData.textures = null
    }
    mesh.material?.dispose?.()
  }

  function applyLiveUniforms() {
    if (cloud) {
      const u = cloud.material.uniforms
      u.uPointScale.value = state.pointScale
      u.uPixelRatio.value = Math.min(window.devicePixelRatio, 2)
      u.uFlowSpeed.value = state.flowSpeed
      u.uSwirl.value = state.swirl
      u.uClay.value = state.viewMode === 'clay' ? 1 : 0
    }
    if (baseMesh?.material?.userData) {
      const u = baseMesh.material.userData
      if (u.uDisplace) u.uDisplace.value = state.depthScale
      if (u.uInvertDepth) u.uInvertDepth.value = state.invertDepth ? 1 : 0
    }
  }

  function syncViewModeUI() {
    document.querySelectorAll('input[name="view-mode"]').forEach((el) => {
      el.checked = el.value === state.viewMode
    })
    document.body.dataset.viewMode = state.viewMode
  }

  function applyCamera() {
    camera.fov = state.fov
    camera.updateProjectionMatrix()
  }

  function updateCount() {
    if (!cloud) return
    countLabel.textContent = `${cloud.userData.count.toLocaleString()} pts`
  }

  function rebuildCloud(showLoader = true) {
    if (rebuilding) return
    rebuilding = true
    if (showLoader) setStatus(true, '重建粒子云…')

    requestAnimationFrame(() => {
      disposeMesh(cloud)
      cloud = null
      disposeMesh(baseMesh)
      baseMesh = null

      const opts = {
        maxSide: Math.min(MAX_SIDE, state.maxSide),
        cardH: 1.62,
        depthScale: state.depthScale,
        invertDepth: state.invertDepth,
        minGrad: state.minGrad,
        viewMode: state.viewMode,
      }

      baseMesh = buildDisplaceBase(assets.color, assets.depth, opts)
      cloud = buildParticleCloud(assets.color, assets.depth, opts)
      root.add(baseMesh)
      root.add(cloud)

      hitPlane.geometry.dispose()
      hitPlane.geometry = new THREE.PlaneGeometry(
        cloud.userData.cardW * 1.02,
        cloud.userData.cardH * 1.02,
      )
      shadow.position.y = -cloud.userData.cardH * 0.5 - 0.08
      shadow.scale.setScalar(Math.max(cloud.userData.cardW, cloud.userData.cardH) * 0.7)
      applyLiveUniforms()
      updateCount()
      setStatus(false)
      rebuilding = false
    })
  }

  function scheduleRebuild() {
    window.clearTimeout(rebuildTimer)
    rebuildTimer = window.setTimeout(() => rebuildCloud(true), 280)
  }

  async function importColorFile(file) {
    try {
      setStatus(true, '读取图片…')
      setImportStatus('读取图片…', true)
      const img = await fileToImage(file)
      assets.color = img
      refreshPreviews()

      setStatus(true, '估算深度（首次较慢）…')
      setImportStatus('估算深度中…', true)
      const depthCanvas = await estimateDepthFromImage(img, (msg) => {
        setStatus(true, msg)
        setImportStatus(msg, true)
      })
      assets.depth = depthCanvas
      // Auto depth = white near
      state.invertDepth = false
      const inv = document.getElementById('p-invert')
      if (inv) inv.checked = false
      refreshPreviews()

      setStatus(true, '重建粒子云…')
      setImportStatus('重建粒子…', true)
      rebuildCloud(true)
      // rebuildCloud clears status asynchronously; mark import done shortly after
      setTimeout(() => setImportStatus('完成 · AI 深度（白近）'), 400)
    } catch (err) {
      console.error(err)
      setStatus(false)
      setImportStatus(`失败：${err.message || err}`)
    }
  }

  async function importDepthFile(file) {
    try {
      setImportStatus('读取深度图…', true)
      const img = await fileToImage(file)
      assets.depth = img
      // Custom depth often dark=near like the previous map — leave toggle to user
      refreshPreviews()
      rebuildCloud(true)
      setImportStatus('已替换深度图')
    } catch (err) {
      console.error(err)
      setImportStatus(`失败：${err.message || err}`)
    }
  }

  bindSlider('p-size', 'p-size-out', (v) => v.toFixed(2), (v) => {
    state.pointScale = v
    applyLiveUniforms()
  })
  bindSlider('p-flow', 'p-flow-out', (v) => v.toFixed(2), (v) => {
    state.flowSpeed = v
    applyLiveUniforms()
  })
  bindSlider('p-swirl', 'p-swirl-out', (v) => v.toFixed(2), (v) => {
    state.swirl = v
    applyLiveUniforms()
  })
  bindSlider('c-dist', 'c-dist-out', (v) => v.toFixed(2), (v) => {
    state.camDist = v
  })
  bindSlider('c-fov', 'c-fov-out', (v) => `${v.toFixed(1)}°`, (v) => {
    state.fov = v
    applyCamera()
  })
  bindSlider('c-yaw', 'c-yaw-out', (v) => `${v | 0}°`, (v) => {
    state.yawDeg = v
  })
  bindSlider('c-pitch', 'c-pitch-out', (v) => `${v | 0}°`, (v) => {
    state.pitchDeg = v
  })
  bindSlider(
    'p-side',
    'p-side-out',
    (v) => String(Math.min(MAX_SIDE, v | 0)),
    (v) => {
      state.maxSide = Math.min(MAX_SIDE, v)
      scheduleRebuild()
    },
    { fireInitial: false },
  )
  bindSlider(
    'p-depth',
    'p-depth-out',
    (v) => v.toFixed(2),
    (v) => {
      state.depthScale = v
      applyLiveUniforms()
      scheduleRebuild()
    },
    { fireInitial: false },
  )
  bindSlider(
    'p-mingrad',
    'p-mingrad-out',
    (v) => v.toFixed(2),
    (v) => {
      state.minGrad = v
      scheduleRebuild()
    },
    { fireInitial: false },
  )

  const invertEl = document.getElementById('p-invert')
  if (invertEl) {
    invertEl.checked = state.invertDepth
    invertEl.addEventListener('change', () => {
      state.invertDepth = invertEl.checked
      scheduleRebuild()
    })
  }

  document.querySelectorAll('input[name="view-mode"]').forEach((el) => {
    el.addEventListener('change', () => {
      if (!el.checked) return
      state.viewMode = el.value === 'clay' ? 'clay' : 'color'
      syncViewModeUI()
      scheduleRebuild()
    })
  })
  syncViewModeUI()

  const fileImage = document.getElementById('file-image')
  const fileDepth = document.getElementById('file-depth')
  const btnPickImage = document.getElementById('btn-pick-image')
  const btnPickDepth = document.getElementById('btn-pick-depth')
  const importZone = document.getElementById('import-zone')

  btnPickImage?.addEventListener('click', (e) => {
    e.stopPropagation()
    fileImage?.click()
  })
  btnPickDepth?.addEventListener('click', (e) => {
    e.stopPropagation()
    fileDepth?.click()
  })
  fileImage?.addEventListener('change', () => {
    const f = fileImage.files?.[0]
    if (f) importColorFile(f)
    fileImage.value = ''
  })
  fileDepth?.addEventListener('change', () => {
    const f = fileDepth.files?.[0]
    if (f) importDepthFile(f)
    fileDepth.value = ''
  })

  importZone?.addEventListener('click', (e) => {
    if (e.target.closest('button')) return
    fileImage?.click()
  })
  ;['dragenter', 'dragover'].forEach((type) => {
    importZone?.addEventListener(type, (e) => {
      e.preventDefault()
      e.stopPropagation()
      importZone.classList.add('dragover')
    })
  })
  ;['dragleave', 'drop'].forEach((type) => {
    importZone?.addEventListener(type, (e) => {
      e.preventDefault()
      e.stopPropagation()
      importZone.classList.remove('dragover')
    })
  })
  importZone?.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0]
    if (f) importColorFile(f)
  })

  const panel = document.getElementById('panel')
  panel?.addEventListener('pointerdown', (e) => e.stopPropagation())
  panel?.addEventListener('click', (e) => e.stopPropagation())

  setStatus(true, '装配粒子云…')
  rebuildCloud(false)
  const boot = setInterval(() => {
    if (cloud) {
      clearInterval(boot)
      setStatus(false)
      updateCount()
    }
  }, 50)

  const clock = new THREE.Clock()
  let explodePhase = 'idle'

  function triggerExplode() {
    if (explodePhase !== 'idle') return
    explodePhase = 'out'
  }

  function triggerScan(clientX, clientY) {
    if (!cloud) return
    ndc.set(
      (clientX / window.innerWidth) * 2 - 1,
      -((clientY / window.innerHeight) * 2 - 1),
    )
    raycaster.setFromCamera(ndc, camera)
    const hits = raycaster.intersectObject(hitPlane, false)
    if (!hits.length) return

    const local = root.worldToLocal(hits[0].point.clone())
    const u = cloud.material.uniforms
    u.uScanOrigin.value.set(local.x, local.y)
    u.uScanStart.value = clock.elapsedTime
    u.uScanActive.value = 1
    u.uScanSpeed.value = 1.05 + Math.random() * 0.25
  }

  window.addEventListener('pointermove', (e) => {
    if (e.target.closest?.('#panel')) return
    state.targetMouse.set(
      (e.clientX / window.innerWidth) * 2 - 1,
      -((e.clientY / window.innerHeight) * 2 - 1),
    )
  })

  renderer.domElement.addEventListener('click', (e) => {
    triggerScan(e.clientX, e.clientY)
  })

  // Optional: Shift+Click still does the old scatter burst
  renderer.domElement.addEventListener('dblclick', (e) => {
    e.preventDefault()
    if (explodePhase === 'idle') triggerExplode()
  })

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault()
      state.autoOrbit = !state.autoOrbit
    }
  })

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
    applyLiveUniforms()
  })

  function animate() {
    requestAnimationFrame(animate)
    if (!cloud) {
      renderer.render(scene, camera)
      return
    }

    const dt = Math.min(clock.getDelta(), 0.05)
    const t = clock.elapsedTime

    if (state.autoOrbit) {
      state.targetMouse.set(Math.sin(t * 0.55), Math.cos(t * 0.4) * 0.55)
    }
    state.mouse.lerp(state.targetMouse, 1 - Math.exp(-dt * 14))

    if (explodePhase === 'out') {
      state.explode = THREE.MathUtils.damp(state.explode, 1, 8.5, dt)
      if (state.explode > 0.97) {
        explodePhase = 'hold'
        state.holdUntil = t + 0.35
      }
    } else if (explodePhase === 'hold') {
      if (t > state.holdUntil) explodePhase = 'in'
    } else if (explodePhase === 'in') {
      state.explode = THREE.MathUtils.damp(state.explode, 0, 7.0, dt)
      if (state.explode < 0.012) {
        state.explode = 0
        explodePhase = 'idle'
      }
    }

    const yaw = THREE.MathUtils.degToRad(state.yawDeg)
    const pitch = THREE.MathUtils.degToRad(state.pitchDeg)
    root.rotation.y = state.mouse.x * yaw
    root.rotation.x = state.mouse.y * pitch

    cloud.material.uniforms.uTime.value = t
    cloud.material.uniforms.uExplode.value = state.explode
    cloud.material.uniforms.uMouse.value.copy(state.mouse)
    cloud.material.uniforms.uFlowSpeed.value = state.flowSpeed
    cloud.material.uniforms.uSwirl.value = state.swirl
    cloud.material.uniforms.uClay.value = state.viewMode === 'clay' ? 1 : 0

    shadow.material.opacity = 0.1 + (1 - state.explode) * 0.08
    shadow.scale.setScalar(1 + state.explode * 0.25)

    const orbitX = state.mouse.x * Math.sin(yaw) * state.camDist * 0.55
    const orbitY = state.mouse.y * Math.sin(pitch) * state.camDist * 0.35
    camera.position.x = orbitX
    camera.position.y = 0.04 + orbitY
    camera.position.z =
      state.camDist * Math.max(0.35, Math.cos(state.mouse.x * yaw * 0.85)) - state.explode * 0.15
    camera.lookAt(0, 0, 0)

    renderer.render(scene, camera)
  }

  animate()
}

main().catch((err) => {
  console.error(err)
  setStatus(true, `加载失败：${err.message}`)
})
