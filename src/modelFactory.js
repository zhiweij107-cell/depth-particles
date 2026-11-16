import * as THREE from 'three'
import {
  baseDisplaceVertexChunk,
  baseAlphaDitherHelpers,
  baseAlphaDitherInline,
  cloudVertex,
  cloudFragment,
} from './shaders.js'

export const MAX_SIDE = 680

export const DEFAULT_MODEL_PARAMS = {
  pointScale: 1.75,
  maxSide: MAX_SIDE,
  depthScale: 0.22,
  minGrad: 0.22,
  invertDepth: true,
  viewMode: 'color',
  flowSpeed: 1.0,
  swirl: 1.0,
  particlesEnabled: false,
  cardH: 1.62,
}

export function newModelId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
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

function makeCardTextures(colorImg, depthImg) {
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
  return { colorTex, depthTex }
}

function attachDisplaceCompile(mat) {
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

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${baseAlphaDitherHelpers}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        ${baseAlphaDitherInline}`,
      )
  }
}

function disposeObject3D(obj) {
  if (!obj) return
  obj.geometry?.dispose?.()
  if (obj.material) {
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const m of mats) {
      if (obj.userData?.textures) {
        /* textures owned by model */
      }
      m.dispose?.()
    }
  }
  if (obj.userData?.textures) {
    for (const t of obj.userData.textures) t?.dispose?.()
    obj.userData.textures = null
  }
}

export function buildDisplaceBase(colorImg, depthImg, opts = {}) {
  const cardH = opts.cardH ?? DEFAULT_MODEL_PARAMS.cardH
  const srcW = colorImg.naturalWidth || colorImg.width
  const srcH = colorImg.naturalHeight || colorImg.height
  const aspect = srcW / srcH
  const cardW = cardH * aspect
  const depthScale = opts.depthScale ?? DEFAULT_MODEL_PARAMS.depthScale
  const invert = opts.invertDepth ?? DEFAULT_MODEL_PARAMS.invertDepth
  const clay = (opts.viewMode ?? DEFAULT_MODEL_PARAMS.viewMode) === 'clay'
  const { colorTex, depthTex } = makeCardTextures(colorImg, depthImg)

  const segs = Math.min(280, Math.max(120, Math.round(Math.max(srcW, srcH) / 3.5)))
  const geo = new THREE.PlaneGeometry(cardW, cardH, segs, segs)

  const sharedUD = {
    uDepth: { value: depthTex },
    uDisplace: { value: depthScale },
    uInvertDepth: { value: invert ? 1 : 0 },
    uCardSize: { value: new THREE.Vector2(cardW, cardH) },
    uDepthTexel: { value: new THREE.Vector2(1 / Math.max(segs, 1), 1 / Math.max(segs, 1)) },
  }

  // Keep color map in both modes: RGB for color / alpha for cutout+dither.
  // Material stays opaque + depthWrite; transparency is simulated by discard dither.
  sharedUD.uClayShade = { value: clay ? 1 : 0 }

  let mat
  if (clay) {
    mat = new THREE.MeshPhongMaterial({
      map: colorTex,
      color: 0xffffff,
      specular: 0x3a3a38,
      shininess: 28,
      flatShading: false,
      side: THREE.FrontSide,
      transparent: false,
      depthWrite: true,
      depthTest: true,
      toneMapped: false,
    })
    Object.assign(mat.userData, sharedUD)
    attachDisplaceCompile(mat)
    mat.customProgramCacheKey = () => 'displace-clay-phong-dither-v5'
  } else {
    mat = new THREE.MeshBasicMaterial({
      map: colorTex,
      toneMapped: false,
      side: THREE.FrontSide,
      transparent: false,
      depthWrite: true,
      depthTest: true,
    })
    Object.assign(mat.userData, sharedUD)
    attachDisplaceCompile(mat)
    mat.customProgramCacheKey = () => 'displace-color-basic-dither-v5'
  }

  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.z = -0.002
  mesh.userData.cardW = cardW
  mesh.userData.cardH = cardH
  mesh.userData.textures = [colorTex, depthTex]
  mesh.userData.clay = clay
  mesh.userData.isReliefBase = true
  return mesh
}

export function buildParticleCloud(colorImg, depthImg, opts = {}) {
  const { maxSide = MAX_SIDE, cardH = 1.62, alphaCut = 8 } = opts
  const minGrad = opts.minGrad ?? DEFAULT_MODEL_PARAMS.minGrad

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

  const invert = opts.invertDepth ?? DEFAULT_MODEL_PARAMS.invertDepth
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
  const depthScale = opts.depthScale ?? DEFAULT_MODEL_PARAMS.depthScale

  const pushParticle = ({ x, y, d, motion, speed, jitter = 0.08, sizeMul = 1 }) => {
    const i = (y * w + x) * 4
    const r = colorData[i]
    const g = colorData[i + 1]
    const b = colorData[i + 2]
    const u = (x + 0.5) / w
    const v = (y + 0.5) / h
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

  if (!positions.length) {
    positions.push(0, 0, 0)
    colors.push(0.7, 0.7, 0.7)
    sizes.push(1)
    seeds.push(0)
    depths.push(0.5)
    motions.push(0)
    speeds.push(0.01)
    scatters.push(0, 0, 0)
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
      uPointScale: { value: opts.pointScale ?? DEFAULT_MODEL_PARAMS.pointScale },
      uFlowSpeed: { value: opts.flowSpeed ?? DEFAULT_MODEL_PARAMS.flowSpeed },
      uSwirl: { value: opts.swirl ?? DEFAULT_MODEL_PARAMS.swirl },
      uClay: { value: (opts.viewMode ?? DEFAULT_MODEL_PARAMS.viewMode) === 'clay' ? 1 : 0 },
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
  points.userData.count = Math.floor(positions.length / 3)
  points.userData.cardW = cardW
  points.userData.cardH = cardH
  points.userData.isParticleCloud = true
  return points
}

/**
 * A placeable relief model in the space.
 */
export function createSpaceModel({
  id = newModelId(),
  name = '模型',
  colorImg,
  depthImg,
  params = {},
  transform = null,
} = {}) {
  const p = { ...DEFAULT_MODEL_PARAMS, ...params }
  const group = new THREE.Group()
  group.name = name
  group.userData.modelId = id
  group.userData.isSpaceModel = true

  const base = buildDisplaceBase(colorImg, depthImg, p)
  group.add(base)

  let cloud = null
  if (p.particlesEnabled) {
    cloud = buildParticleCloud(colorImg, depthImg, p)
    group.add(cloud)
  }

  if (transform) {
    if (transform.position) group.position.fromArray(transform.position)
    if (transform.rotation) group.rotation.set(transform.rotation[0], transform.rotation[1], transform.rotation[2])
    if (transform.scale) {
      if (typeof transform.scale === 'number') group.scale.setScalar(transform.scale)
      else group.scale.fromArray(transform.scale)
    }
  }

  return {
    id,
    name,
    group,
    base,
    cloud,
    colorImg,
    depthImg,
    params: p,
    get particleCount() {
      return this.cloud?.userData?.count || 0
    },
    applyLiveUniforms() {
      if (this.cloud?.material?.uniforms) {
        const u = this.cloud.material.uniforms
        u.uPointScale.value = this.params.pointScale
        u.uFlowSpeed.value = this.params.flowSpeed
        u.uSwirl.value = this.params.swirl
        u.uClay.value = this.params.viewMode === 'clay' ? 1 : 0
        u.uPixelRatio.value = Math.min(window.devicePixelRatio, 2)
      }
      if (this.base?.material?.userData) {
        const u = this.base.material.userData
        if (u.uDisplace) u.uDisplace.value = this.params.depthScale
        if (u.uInvertDepth) u.uInvertDepth.value = this.params.invertDepth ? 1 : 0
      }
    },
    setParticlesEnabled(on) {
      this.params.particlesEnabled = !!on
      if (!on) {
        if (this.cloud) {
          this.group.remove(this.cloud)
          disposeObject3D(this.cloud)
          this.cloud = null
        }
        return
      }
      if (this.cloud) return
      this.cloud = buildParticleCloud(this.colorImg, this.depthImg, this.params)
      this.group.add(this.cloud)
    },
    rebuildRelief() {
      if (this.base) {
        this.group.remove(this.base)
        disposeObject3D(this.base)
      }
      this.base = buildDisplaceBase(this.colorImg, this.depthImg, this.params)
      this.group.add(this.base)
      if (this.params.particlesEnabled) {
        if (this.cloud) {
          this.group.remove(this.cloud)
          disposeObject3D(this.cloud)
        }
        this.cloud = buildParticleCloud(this.colorImg, this.depthImg, this.params)
        this.group.add(this.cloud)
      }
    },
    tick(t) {
      if (this.cloud?.material?.uniforms?.uTime) {
        this.cloud.material.uniforms.uTime.value = t
      }
    },
    getTransform() {
      return {
        position: this.group.position.toArray(),
        rotation: [this.group.rotation.x, this.group.rotation.y, this.group.rotation.z],
        scale: this.group.scale.toArray(),
      }
    },
    dispose() {
      if (this.cloud) {
        this.group.remove(this.cloud)
        disposeObject3D(this.cloud)
        this.cloud = null
      }
      if (this.base) {
        this.group.remove(this.base)
        disposeObject3D(this.base)
        this.base = null
      }
    },
  }
}

export function placementOffset(index) {
  const col = index % 4
  const row = Math.floor(index / 4)
  return {
    x: (col - 1.5) * 1.35,
    y: (1 - row) * 1.1,
    z: 0,
  }
}
