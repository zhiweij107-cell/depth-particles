/**
 * Save / load interactive space works to local disk.
 * Format: single .depthspace.json (images as data URLs).
 * Color must be PNG to keep alpha for cutout dither.
 */

function canvasToDataUrl(source, type = 'image/png', quality) {
  const w = source.naturalWidth || source.width
  const h = source.naturalHeight || source.height
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { alpha: true })
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(source, 0, 0)
  return type === 'image/jpeg' ? c.toDataURL(type, quality ?? 0.9) : c.toDataURL('image/png')
}

function dataUrlToCanvas(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const ctx = c.getContext('2d', { alpha: true })
      ctx.clearRect(0, 0, c.width, c.height)
      ctx.drawImage(img, 0, 0)
      resolve(c)
    }
    img.onerror = () => reject(new Error('作品图像解码失败'))
    img.src = dataUrl
  })
}

export function serializeSpace({ name, models, camera }) {
  return {
    version: 2,
    kind: 'depth-particles-space',
    name: name || '未命名作品',
    savedAt: Date.now(),
    camera: camera || null,
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      params: { ...m.params },
      transform: m.getTransform(),
      // PNG keeps cutout alpha; JPEG would bake transparency into black
      colorDataUrl: canvasToDataUrl(m.colorImg, 'image/png'),
      depthDataUrl: canvasToDataUrl(m.depthImg, 'image/png'),
    })),
  }
}

export async function deserializeSpace(doc, { onProgress } = {}) {
  if (!doc || typeof doc !== 'object') {
    throw new Error('作品文件无效或为空')
  }
  if (doc.kind !== 'depth-particles-space') {
    throw new Error('不是有效的空间作品文件（需要 Depth Space 导出的 JSON）')
  }
  const list = doc.models || []
  if (!list.length) throw new Error('作品里没有模型')
  const models = []
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    onProgress?.(`解码图像 ${i + 1}/${list.length}…`)
    if (!item?.colorDataUrl || !item?.depthDataUrl) {
      throw new Error(`模型「${item?.name || i + 1}」缺少图像数据`)
    }
    try {
      const [colorImg, depthImg] = await Promise.all([
        dataUrlToCanvas(item.colorDataUrl),
        dataUrlToCanvas(item.depthDataUrl),
      ])
      models.push({
        id: item.id,
        name: item.name,
        params: item.params || {},
        transform: item.transform || null,
        colorImg,
        depthImg,
      })
    } catch (err) {
      throw new Error(`模型「${item?.name || i + 1}」图像解码失败：${err.message || err}`)
    }
  }
  return {
    name: doc.name || '未命名作品',
    camera: doc.camera || null,
    models,
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

/** Save JSON work to disk (File System Access API or download fallback). */
export async function saveSpaceToDisk(doc, suggestedName) {
  const text = JSON.stringify(doc)
  const blob = new Blob([text], { type: 'application/json' })
  const filename = `${(suggestedName || doc.name || 'space').replace(/[\\/:*?"<>|]/g, '_')}.depthspace.json`

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        excludeAcceptAllOption: false,
        types: [
          {
            description: 'Depth Space 作品',
            accept: {
              'application/json': ['.json', '.depthspace.json'],
            },
          },
        ],
      })
      try {
        const writable = await handle.createWritable()
        await writable.write(blob)
        await writable.close()
        return { method: 'picker', name: handle.name || filename }
      } catch (writeErr) {
        // 系统对话框可能已建出空文件；再用下载补一份完整内容
        downloadBlob(blob, handle.name || filename)
        return { method: 'download-fallback', name: handle.name || filename, error: writeErr }
      }
    } catch (err) {
      if (err?.name === 'AbortError') return { method: 'cancelled' }
      // NotAllowedError 等：手势失效时回退下载
      downloadBlob(blob, filename)
      return { method: 'download', name: filename }
    }
  }

  downloadBlob(blob, filename)
  return { method: 'download', name: filename }
}

async function readSpaceFile(file) {
  if (!file) return null
  if (file.size === 0) throw new Error(`文件为空：${file.name}`)
  const text = await file.text()
  if (!text.trim()) throw new Error(`文件为空：${file.name}`)
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    throw new Error(`JSON 解析失败：${file.name}`)
  }
  return { doc, name: file.name }
}

function pickFileWithInput() {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.depthspace.json,application/json,text/plain'
    input.style.display = 'none'
    const cleanup = () => {
      input.remove()
    }
    input.addEventListener('change', () => {
      const file = input.files?.[0] || null
      cleanup()
      resolve(file)
    }, { once: true })
    // 取消选择时部分浏览器不触发 change，用 focus 兜底
    window.addEventListener(
      'focus',
      () => {
        window.setTimeout(() => {
          if (!input.isConnected) return
          if (!input.files?.length) {
            cleanup()
            resolve(null)
          }
        }, 300)
      },
      { once: true },
    )
    document.body.appendChild(input)
    input.click()
  })
}

/** Open a space file via input[type=file] (avoids File System Access getFile permission errors). */
export async function openSpaceFromDisk() {
  const file = await pickFileWithInput()
  if (!file) return null
  return readSpaceFile(file)
}

/** Capture renderer canvas as PNG download. Caller should render once first. */
export async function captureScreenshot(renderer, filename = 'depth-space.png') {
  const canvas = renderer.domElement
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('截图失败')

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'PNG Image', accept: { 'image/png': ['.png'] } }],
      })
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return { method: 'picker', name: handle.name || filename }
    } catch (err) {
      if (err?.name === 'AbortError') return { method: 'cancelled' }
    }
  }

  downloadBlob(blob, filename)
  return { method: 'download', name: filename }
}
