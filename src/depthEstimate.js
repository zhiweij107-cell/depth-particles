/**
 * Browser-side monocular depth via Depth Anything V2 (Transformers.js).
 * First run downloads ~100MB model (cached afterwards).
 */

let estimatorPromise = null

async function getEstimator(onProgress) {
  if (!estimatorPromise) {
    onProgress?.('首次需下载深度模型，请稍候…')
    const { pipeline } = await import('@huggingface/transformers')
    estimatorPromise = pipeline(
      'depth-estimation',
      'onnx-community/depth-anything-v2-small',
      { device: 'wasm' },
    )
  }
  return estimatorPromise
}

function depthTensorToCanvas(depth, targetW, targetH) {
  const src = document.createElement('canvas')
  src.width = depth.width
  src.height = depth.height
  const ctx = src.getContext('2d')
  const imageData = ctx.createImageData(depth.width, depth.height)
  const n = depth.width * depth.height
  for (let i = 0; i < n; i++) {
    const v = depth.data[i]
    const o = i * 4
    imageData.data[o] = v
    imageData.data[o + 1] = v
    imageData.data[o + 2] = v
    imageData.data[o + 3] = 255
  }
  ctx.putImageData(imageData, 0, 0)

  if (targetW === depth.width && targetH === depth.height) return src

  const out = document.createElement('canvas')
  out.width = targetW
  out.height = targetH
  const octx = out.getContext('2d')
  octx.imageSmoothingEnabled = true
  octx.imageSmoothingQuality = 'high'
  octx.drawImage(src, 0, 0, targetW, targetH)
  return out
}

/**
 * @param {CanvasImageSource & { naturalWidth?: number, naturalHeight?: number, width?: number, height?: number }} image
 * @param {(msg: string) => void} [onProgress]
 * @returns {Promise<HTMLCanvasElement>} grayscale depth, white = near
 */
export async function estimateDepthFromImage(image, onProgress) {
  const { RawImage } = await import('@huggingface/transformers')
  const estimator = await getEstimator(onProgress)

  const srcW = image.naturalWidth || image.videoWidth || image.width
  const srcH = image.naturalHeight || image.videoHeight || image.height
  const maxInfer = 768
  const scale = Math.min(1, maxInfer / Math.max(srcW, srcH))
  const iw = Math.max(2, Math.round(srcW * scale))
  const ih = Math.max(2, Math.round(srcH * scale))

  const inferCanvas = document.createElement('canvas')
  inferCanvas.width = iw
  inferCanvas.height = ih
  inferCanvas.getContext('2d').drawImage(image, 0, 0, iw, ih)

  onProgress?.('正在估算深度图…')
  const raw = await RawImage.fromCanvas(inferCanvas)
  const { depth } = await estimator(raw)

  onProgress?.('深度图就绪')
  return depthTensorToCanvas(depth, srcW, srcH)
}

/** Load file → canvas (stable source for particles + preview). */
export function fileToImage(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      reject(new Error('请选择图片文件'))
      return
    }
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      canvas.getContext('2d').drawImage(img, 0, 0)
      URL.revokeObjectURL(url)
      resolve(canvas)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片读取失败'))
    }
    img.src = url
  })
}

export function canvasToPreviewUrl(source, maxSide = 120) {
  const sw = source.naturalWidth || source.width
  const sh = source.naturalHeight || source.height
  const scale = Math.min(1, maxSide / Math.max(sw, sh))
  const w = Math.max(1, Math.round(sw * scale))
  const h = Math.max(1, Math.round(sh * scale))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  c.getContext('2d').drawImage(source, 0, 0, w, h)
  return c.toDataURL('image/jpeg', 0.85)
}
