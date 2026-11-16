import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import {
  estimateDepthFromImage,
  fileToImage,
  canvasToPreviewUrl,
} from './depthEstimate.js'
import {
  createSpaceModel,
  placementOffset,
  newModelId,
  DEFAULT_MODEL_PARAMS,
} from './modelFactory.js'
import {
  serializeSpace,
  deserializeSpace,
  saveSpaceToDisk,
  openSpaceFromDisk,
  captureScreenshot,
} from './sceneDisk.js'

const loaderEl = document.getElementById('loader')
const loaderText = document.getElementById('loader-text')
const countLabel = document.getElementById('count-label')
const statusLine = document.getElementById('status-line')
const workTitleEl = document.getElementById('work-title')
const modelListEl = document.getElementById('model-list')
const modelEmptyEl = document.getElementById('model-empty')
const inspectorEl = document.getElementById('inspector')
const inspectorEmptyEl = document.getElementById('inspector-empty')

/** @type {ReturnType<typeof createSpaceModel>[]} */
let models = []
/** @type {ReturnType<typeof createSpaceModel> | null} */
let selected = null
let workName = '未命名作品'
let suppressInspector = false
let rebuildTimer = 0

const spaceState = {
  xformMode: 'translate',
}

function setStatus(loading, text) {
  if (text) loaderText.textContent = text
  loaderEl.classList.toggle('hide', !loading)
}

function setLine(text, busy = false) {
  if (!statusLine) return
  statusLine.textContent = text || ''
  statusLine.classList.toggle('busy', busy)
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

function bindSlider(id, outId, format, onChange, { fireInitial = false } = {}) {
  const input = document.getElementById(id)
  if (!input) return null
  const out = document.getElementById(outId)
  const sync = (fire) => {
    const v = Number(input.value)
    if (out) out.textContent = format(v)
    if (fire) onChange(v)
  }
  input.addEventListener('input', () => sync(true))
  if (fireInitial) sync(true)
  else if (out) out.textContent = format(Number(input.value))
  return input
}

function setControl(id, value, outId, format) {
  const input = document.getElementById(id)
  if (!input) return
  input.value = String(value)
  const out = outId ? document.getElementById(outId) : null
  if (out && format) out.textContent = format(Number(value))
}

async function main() {
  setStatus(true, '初始化空间…')

  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#f5f5f3')

  const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 80)
  camera.position.set(2.8, 1.6, 5.2)

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setClearColor('#f5f5f3', 1)
  document.getElementById('app').appendChild(renderer.domElement)

  const amb = new THREE.AmbientLight(0xffffff, 0.45)
  const key = new THREE.DirectionalLight(0xffffff, 0.95)
  key.position.set(2.4, 3.2, 4.2)
  const fill = new THREE.DirectionalLight(0xe8e8f0, 0.35)
  fill.position.set(-2.8, 1.0, 2.2)
  scene.add(amb, key, fill)

  const root = new THREE.Group()
  scene.add(root)

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(6, 64),
    new THREE.MeshBasicMaterial({ color: 0xcfcfc9, transparent: true, opacity: 0.22, depthWrite: false }),
  )
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -1.35
  scene.add(ground)

  const orbit = new OrbitControls(camera, renderer.domElement)
  orbit.enableDamping = true
  orbit.dampingFactor = 0.08
  orbit.target.set(0, 0.2, 0)
  orbit.minDistance = 1.5
  orbit.maxDistance = 18

  const transform = new TransformControls(camera, renderer.domElement)
  const transformHelper = transform.getHelper()
  transform.setMode('translate')
  transform.setSize(0.85)
  transform.addEventListener('dragging-changed', (e) => {
    orbit.enabled = !e.value
  })
  const syncXformUi = () => {
    if (selected && !suppressInspector) syncTransformInspector()
  }
  transform.addEventListener('change', syncXformUi)
  transform.addEventListener('objectChange', syncXformUi)
  scene.add(transformHelper)

  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  const outlinePass = new OutlinePass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    scene,
    camera,
  )
  outlinePass.edgeStrength = 4.5
  outlinePass.edgeGlow = 0.35
  outlinePass.edgeThickness = 1.4
  outlinePass.pulsePeriod = 0
  outlinePass.visibleEdgeColor.set('#2f6bff')
  outlinePass.hiddenEdgeColor.set('#163a8c')
  composer.addPass(outlinePass)
  composer.addPass(new OutputPass())

  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const clock = new THREE.Clock()

  // Distinguish click-select vs orbit drag
  const pointerTrack = {
    downX: 0,
    downY: 0,
    moved: false,
    downOnCanvas: false,
  }
  const CLICK_MOVE_PX = 6

  function updateWorkTitle() {
    if (workTitleEl) workTitleEl.textContent = `${workName} · ${models.length} 个模型`
    if (countLabel) countLabel.textContent = `${models.length} models`
  }

  function refreshModelList() {
    if (!modelListEl) return
    modelListEl.innerHTML = ''
    modelEmptyEl.hidden = models.length > 0
    for (const m of models) {
      const row = document.createElement('div')
      row.className = 'model-item' + (selected?.id === m.id ? ' active' : '')
      row.dataset.id = m.id
      row.innerHTML = `
        <div>
          <strong>${escapeHtml(m.name)}</strong>
          <span>${m.params.particlesEnabled ? `${m.particleCount} pts` : '粒子关'} · ${m.params.viewMode === 'clay' ? '白模' : '彩图'}</span>
        </div>
        <button type="button" data-act="del">删</button>
      `
      modelListEl.appendChild(row)
    }
    updateWorkTitle()
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function setXformMode(mode) {
    spaceState.xformMode = mode
    transform.setMode(mode)
    document.querySelectorAll('[data-xform]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.xform === mode)
    })
    document.querySelectorAll('.xform-pane').forEach((pane) => {
      pane.hidden = pane.dataset.pane !== mode
    })
    syncTransformInspector()
  }

  function syncTransformInspector() {
    if (!selected) return
    suppressInspector = true
    const g = selected.group
    setControl('t-px', g.position.x, 't-px-out', (v) => v.toFixed(2))
    setControl('t-py', g.position.y, 't-py-out', (v) => v.toFixed(2))
    setControl('t-pz', g.position.z, 't-pz-out', (v) => v.toFixed(2))
    setControl('t-rx', THREE.MathUtils.radToDeg(g.rotation.x), 't-rx-out', (v) => `${v | 0}°`)
    setControl('t-ry', THREE.MathUtils.radToDeg(g.rotation.y), 't-ry-out', (v) => `${v | 0}°`)
    setControl('t-rz', THREE.MathUtils.radToDeg(g.rotation.z), 't-rz-out', (v) => `${v | 0}°`)
    setControl('t-sx', g.scale.x, 't-sx-out', (v) => v.toFixed(2))
    setControl('t-sy', g.scale.y, 't-sy-out', (v) => v.toFixed(2))
    setControl('t-sz', g.scale.z, 't-sz-out', (v) => v.toFixed(2))
    const sc = (g.scale.x + g.scale.y + g.scale.z) / 3
    setControl('t-sc', sc, 't-sc-out', (v) => v.toFixed(2))
    suppressInspector = false
  }

  function updateOutline() {
    const objs = []
    if (selected?.base) objs.push(selected.base)
    outlinePass.selectedObjects = objs
  }

  function syncReliefInspector() {
    if (!selected) return
    suppressInspector = true
    const p = selected.params
    setControl('p-depth', p.depthScale, 'p-depth-out', (v) => v.toFixed(2))
    setControl('p-size', p.pointScale, 'p-size-out', (v) => v.toFixed(2))
    setControl('p-mingrad', p.minGrad, 'p-mingrad-out', (v) => v.toFixed(2))
    setControl('p-flow', p.flowSpeed, 'p-flow-out', (v) => v.toFixed(2))
    setControl('p-swirl', p.swirl, 'p-swirl-out', (v) => v.toFixed(2))
    const inv = document.getElementById('p-invert')
    if (inv) inv.checked = !!p.invertDepth
    const parts = document.getElementById('p-particles')
    if (parts) parts.checked = !!p.particlesEnabled
    document.querySelectorAll('input[name="view-mode"]').forEach((el) => {
      el.checked = el.value === p.viewMode
    })
    document.getElementById('particle-ctrls')?.classList.toggle('off', !p.particlesEnabled)
    suppressInspector = false
  }

  function showInspector(on) {
    if (inspectorEl) inspectorEl.hidden = !on
    if (inspectorEmptyEl) inspectorEmptyEl.hidden = on
  }

  function selectModel(model) {
    selected = model || null
    if (selected) {
      transform.attach(selected.group)
      transformHelper.visible = true
      showInspector(true)
      setXformMode(spaceState.xformMode || 'translate')
      syncReliefInspector()
    } else {
      transform.detach()
      transformHelper.visible = false
      showInspector(false)
    }
    updateOutline()
    refreshModelList()
  }

  function pickModelAt(clientX, clientY) {
    ndc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1)
    raycaster.setFromCamera(ndc, camera)
    const hitMeshes = []
    for (const m of models) {
      m.group.traverse((obj) => {
        if (obj.isMesh) hitMeshes.push(obj)
      })
    }
    const hits = raycaster.intersectObjects(hitMeshes, false)
    if (!hits.length) return null
    let obj = hits[0].object
    while (obj && !obj.userData?.isSpaceModel) obj = obj.parent
    if (!obj?.userData?.modelId) return null
    return models.find((x) => x.id === obj.userData.modelId) || null
  }

  function handleCanvasSelect(clientX, clientY) {
    if (transform.dragging) return
    const m = pickModelAt(clientX, clientY)
    if (!m) {
      selectModel(null)
      return
    }
    // Click same model again → deselect
    if (selected?.id === m.id) {
      selectModel(null)
      return
    }
    selectModel(m)
  }

  function addModelToSpace(model, { select = true } = {}) {
    models.push(model)
    root.add(model.group)
    model.applyLiveUniforms()
    if (select) selectModel(model)
    else refreshModelList()
    setLine(`已加入「${model.name}」`)
  }

  function removeModel(id) {
    const idx = models.findIndex((m) => m.id === id)
    if (idx < 0) return
    const m = models[idx]
    if (selected?.id === id) selectModel(null)
    root.remove(m.group)
    m.dispose()
    models.splice(idx, 1)
    refreshModelList()
    setLine(`已删除「${m.name}」`)
  }

  function clearSpace() {
    selectModel(null)
    for (const m of models) {
      root.remove(m.group)
      m.dispose()
    }
    models = []
    refreshModelList()
  }

  function scheduleReliefRebuild() {
    window.clearTimeout(rebuildTimer)
    rebuildTimer = window.setTimeout(() => {
      if (!selected) return
      setLine('重建浮雕…', true)
      selected.rebuildRelief()
      selected.applyLiveUniforms()
      updateOutline()
      refreshModelList()
      setLine(`已更新「${selected.name}」`)
    }, 220)
  }

  async function addImageFile(file) {
    try {
      setStatus(true, '读取图片…')
      setLine('读取图片…', true)
      const img = await fileToImage(file)
      setStatus(true, '估算深度…')
      setLine('估算深度中…', true)
      const depth = await estimateDepthFromImage(img, (msg) => {
        setStatus(true, msg)
        setLine(msg, true)
      })
      const idx = models.length
      const pos = placementOffset(idx)
      const model = createSpaceModel({
        id: newModelId(),
        name: file.name?.replace(/\.[^.]+$/, '') || `模型 ${idx + 1}`,
        colorImg: img,
        depthImg: depth,
        params: {
          ...DEFAULT_MODEL_PARAMS,
          invertDepth: false,
          particlesEnabled: false,
        },
        transform: { position: [pos.x, pos.y, pos.z], rotation: [0, 0, 0], scale: [1, 1, 1] },
      })
      addModelToSpace(model)
      setStatus(false)
      setLine(`完成 · 「${model.name}」已放入空间（粒子默认关闭）`)
    } catch (err) {
      console.error(err)
      setStatus(false)
      setLine(`失败：${err.message || err}`)
    }
  }

  async function saveWork() {
    if (!models.length) {
      setLine('空间为空，先添加模型')
      return
    }
    // 不在保存前用 prompt，以免打断用户手势导致系统保存框失败 / 写出空文件
    try {
      setLine('正在写入磁盘…', true)
      const doc = serializeSpace({
        name: workName,
        models,
        camera: {
          position: camera.position.toArray(),
          target: orbit.target.toArray(),
        },
      })
      const res = await saveSpaceToDisk(doc, workName)
      if (res.method === 'cancelled') {
        setLine('已取消保存')
        return
      }
      if (res.name) {
        const bare = String(res.name)
          .replace(/\.depthspace\.json$/i, '')
          .replace(/\.json$/i, '')
        if (bare) {
          workName = bare
          updateWorkTitle()
        }
      }
      setLine(`作品已保存 · ${res.name}`)
    } catch (err) {
      console.error(err)
      setLine(`保存失败：${err.message || err}`)
    }
  }

  async function openWork() {
    try {
      setLine('选择作品文件…（可选 .json）', true)
      const picked = await openSpaceFromDisk()
      if (!picked) {
        setLine('已取消打开')
        return
      }
      setStatus(true, `读取 ${picked.name}…`)
      setLine(`读取 ${picked.name}…`, true)
      const data = await deserializeSpace(picked.doc, {
        onProgress: (msg) => {
          setStatus(true, msg)
          setLine(msg, true)
        },
      })
      clearSpace()
      workName = data.name || picked.name.replace(/\.depthspace\.json$/i, '').replace(/\.json$/i, '') || workName
      for (let i = 0; i < data.models.length; i++) {
        const item = data.models[i]
        setStatus(true, `放入场景 ${i + 1}/${data.models.length}…`)
        setLine(`放入场景 ${i + 1}/${data.models.length}…`, true)
        const model = createSpaceModel({
          id: item.id || newModelId(),
          name: item.name,
          colorImg: item.colorImg,
          depthImg: item.depthImg,
          params: item.params,
          transform: item.transform,
        })
        addModelToSpace(model, { select: false })
        // 让出主线程，避免 16 个模型同步建网格时界面假死
        await new Promise((r) => requestAnimationFrame(r))
      }
      if (data.camera?.position) camera.position.fromArray(data.camera.position)
      if (data.camera?.target) orbit.target.fromArray(data.camera.target)
      orbit.update()
      selectModel(models[0] || null)
      setStatus(false)
      setLine(`已打开「${workName}」· ${models.length} 个模型`)
      updateWorkTitle()
    } catch (err) {
      console.error(err)
      setStatus(false)
      setLine(`打开失败：${err.message || err}`)
    }
  }

  async function takeShot() {
    try {
      const prevHelper = transformHelper.visible
      const prevOutline = outlinePass.selectedObjects
      transformHelper.visible = false
      outlinePass.selectedObjects = []
      composer.render()
      const stamp = new Date()
      const p = (n) => String(n).padStart(2, '0')
      const filename = `${workName.replace(/[\\/:*?"<>|]/g, '_')}_${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}_${p(stamp.getHours())}${p(stamp.getMinutes())}.png`
      const res = await captureScreenshot(renderer, filename)
      transformHelper.visible = prevHelper
      outlinePass.selectedObjects = prevOutline
      if (res.method === 'cancelled') setLine('已取消截图')
      else setLine(`截图已保存 · ${res.name}`)
    } catch (err) {
      console.error(err)
      setLine(`截图失败：${err.message || err}`)
    }
  }

  // Bootstrap: load default card as first model
  try {
    const color = await loadImage('/card.jpg')
    const depth = await loadImage('/depth.png').catch(() => null)
    if (depth) {
      const model = createSpaceModel({
        name: '示例卡面',
        colorImg: color,
        depthImg: depth,
        params: { ...DEFAULT_MODEL_PARAMS, invertDepth: true, particlesEnabled: false },
        transform: { position: [0, 0.15, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      })
      addModelToSpace(model)
    }
  } catch (err) {
    console.warn(err)
  }
  setStatus(false)
  setLine('就绪 · 添加图片放入空间，选中后可变换')
  showInspector(!!selected)
  refreshModelList()

  // UI bindings
  const fileImage = document.getElementById('file-image')
  document.getElementById('btn-add-image')?.addEventListener('click', () => fileImage?.click())
  fileImage?.addEventListener('change', () => {
    const f = fileImage.files?.[0]
    if (f) addImageFile(f)
    fileImage.value = ''
  })
  document.getElementById('btn-save-space')?.addEventListener('click', () => saveWork())
  document.getElementById('btn-open-space')?.addEventListener('click', () => openWork())
  document.getElementById('btn-shot')?.addEventListener('click', () => takeShot())

  document.querySelectorAll('[data-xform]').forEach((btn) => {
    btn.addEventListener('click', () => setXformMode(btn.dataset.xform))
  })

  modelListEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act="del"]')
    const row = e.target.closest('.model-item')
    if (!row) return
    const id = row.dataset.id
    if (btn) {
      e.stopPropagation()
      if (window.confirm('从空间删除该模型？')) removeModel(id)
      return
    }
    const m = models.find((x) => x.id === id)
    if (!m) return
    if (selected?.id === m.id) selectModel(null)
    else selectModel(m)
  })

  bindSlider('t-px', 't-px-out', (v) => v.toFixed(2), (v) => {
    if (!selected || suppressInspector) return
    selected.group.position.x = v
  })
  bindSlider('t-py', 't-py-out', (v) => v.toFixed(2), (v) => {
    if (!selected || suppressInspector) return
    selected.group.position.y = v
  })
  bindSlider('t-pz', 't-pz-out', (v) => v.toFixed(2), (v) => {
    if (!selected || suppressInspector) return
    selected.group.position.z = v
  })
  bindSlider('t-rx', 't-rx-out', (v) => `${v | 0}°`, (v) => {
    if (!selected || suppressInspector) return
    selected.group.rotation.x = THREE.MathUtils.degToRad(v)
  })
  bindSlider('t-ry', 't-ry-out', (v) => `${v | 0}°`, (v) => {
    if (!selected || suppressInspector) return
    selected.group.rotation.y = THREE.MathUtils.degToRad(v)
  })
  bindSlider('t-rz', 't-rz-out', (v) => `${v | 0}°`, (v) => {
    if (!selected || suppressInspector) return
    selected.group.rotation.z = THREE.MathUtils.degToRad(v)
  })
  bindSlider('t-sx', 't-sx-out', (v) => v.toFixed(2), (v) => {
    if (!selected || suppressInspector) return
    selected.group.scale.x = v
  })
  bindSlider('t-sy', 't-sy-out', (v) => v.toFixed(2), (v) => {
    if (!selected || suppressInspector) return
    selected.group.scale.y = v
  })
  bindSlider('t-sz', 't-sz-out', (v) => v.toFixed(2), (v) => {
    if (!selected || suppressInspector) return
    selected.group.scale.z = v
  })
  bindSlider('t-sc', 't-sc-out', (v) => v.toFixed(2), (v) => {
    if (!selected || suppressInspector) return
    selected.group.scale.setScalar(v)
    syncTransformInspector()
  })

  bindSlider('p-depth', 'p-depth-out', (v) => v.toFixed(2), (v) => {
    if (!selected || suppressInspector) return
    selected.params.depthScale = v
    selected.applyLiveUniforms()
    scheduleReliefRebuild()
  })
  bindSlider('p-size', 'p-size-out', (v) => v.toFixed(2), (v) => {
    if (!selected || suppressInspector) return
    selected.params.pointScale = v
    selected.applyLiveUniforms()
  })
  bindSlider('p-mingrad', 'p-mingrad-out', (v) => v.toFixed(2), (v) => {
    if (!selected || suppressInspector) return
    selected.params.minGrad = v
    if (selected.params.particlesEnabled) scheduleReliefRebuild()
  })
  bindSlider('p-flow', 'p-flow-out', (v) => v.toFixed(2), (v) => {
    if (!selected || suppressInspector) return
    selected.params.flowSpeed = v
    selected.applyLiveUniforms()
  })
  bindSlider('p-swirl', 'p-swirl-out', (v) => v.toFixed(2), (v) => {
    if (!selected || suppressInspector) return
    selected.params.swirl = v
    selected.applyLiveUniforms()
  })

  document.getElementById('p-invert')?.addEventListener('change', (e) => {
    if (!selected || suppressInspector) return
    selected.params.invertDepth = e.target.checked
    scheduleReliefRebuild()
  })
  document.getElementById('p-particles')?.addEventListener('change', (e) => {
    if (!selected || suppressInspector) return
    setLine(e.target.checked ? '生成粒子…' : '关闭粒子…', true)
    selected.setParticlesEnabled(e.target.checked)
    selected.applyLiveUniforms()
    refreshModelList()
    syncReliefInspector()
    setLine(e.target.checked ? `粒子已开 · ${selected.particleCount} pts` : '粒子已关')
  })
  document.querySelectorAll('input[name="view-mode"]').forEach((el) => {
    el.addEventListener('change', () => {
      if (!el.checked || !selected || suppressInspector) return
      selected.params.viewMode = el.value === 'clay' ? 'clay' : 'color'
      scheduleReliefRebuild()
    })
  })

  const panel = document.getElementById('panel')
  panel?.addEventListener('pointerdown', (e) => e.stopPropagation())
  document.getElementById('toolbar')?.addEventListener('pointerdown', (e) => e.stopPropagation())

  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    pointerTrack.downX = e.clientX
    pointerTrack.downY = e.clientY
    pointerTrack.moved = false
    pointerTrack.downOnCanvas = true
  })
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (!pointerTrack.downOnCanvas) return
    const dx = e.clientX - pointerTrack.downX
    const dy = e.clientY - pointerTrack.downY
    if (dx * dx + dy * dy > CLICK_MOVE_PX * CLICK_MOVE_PX) pointerTrack.moved = true
  })
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (e.button !== 0 || !pointerTrack.downOnCanvas) return
    const wasClick = !pointerTrack.moved && !transform.dragging
    pointerTrack.downOnCanvas = false
    // Orbit / transform drag → keep selection; only short click changes it
    if (!wasClick) return
    handleCanvasSelect(e.clientX, e.clientY)
  })
  renderer.domElement.addEventListener('pointercancel', () => {
    pointerTrack.downOnCanvas = false
  })

  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input,textarea')) return
    if (e.key === 'g' || e.key === 'G') setXformMode('translate')
    if (e.key === 'r' || e.key === 'R') setXformMode('rotate')
    if (e.key === 's' || e.key === 'S') setXformMode('scale')
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault()
      removeModel(selected.id)
    }
    if (e.key === 'Escape') selectModel(null)
  })

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
    composer.setSize(window.innerWidth, window.innerHeight)
    outlinePass.resolution.set(window.innerWidth, window.innerHeight)
    for (const m of models) m.applyLiveUniforms()
  })

  // Drag-drop images onto canvas
  ;['dragenter', 'dragover'].forEach((type) => {
    window.addEventListener(type, (e) => {
      e.preventDefault()
    })
  })
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    if (e.target.closest?.('#panel,#toolbar')) return
    const f = e.dataTransfer?.files?.[0]
    if (f && f.type.startsWith('image/')) addImageFile(f)
  })

  function animate() {
    requestAnimationFrame(animate)
    const t = clock.elapsedTime
    orbit.update()
    for (const m of models) m.tick(t)
    // Keep inspector live while dragging gizmo / after orbit
    if (selected && transform.dragging) syncTransformInspector()
    composer.render()
  }
  animate()
}

main().catch((err) => {
  console.error(err)
  setStatus(true, `启动失败：${err.message}`)
})
