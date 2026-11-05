/**
 * Depth map generation
 *   npm run gen-depth              heuristic
 *   npm run gen-depth -- --ai      Depth Anything V2 small on card.jpg
 *   npm run gen-depth -- --ai --base
 *   npm run gen-depth -- --ai --from clay   estimate from GPT clay guide
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const cardPath = path.join(root, 'public', 'card.jpg')
const clayPath = path.join(root, 'public', 'depth-gpt-clay.jpg')
const output = path.join(root, 'public', 'depth.png')

const args = new Set(process.argv.slice(2))
const useAi = args.has('--ai')
const useBase = args.has('--base')
const fromClay = args.has('--from') && process.argv.includes('clay')

async function heuristicDepth(input) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height } = info
  const out = Buffer.alloc(width * height)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const a = data[i + 3] / 255
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      const nx = x / width
      const ny = y / height

      const handBlob = Math.exp(-((nx - 0.72) ** 2) / 0.07 - ((ny - 0.38) ** 2) / 0.09)
      const faceBlob = Math.exp(-((nx - 0.48) ** 2) / 0.05 - ((ny - 0.42) ** 2) / 0.06)
      const bodyBlob = Math.exp(-((nx - 0.48) ** 2) / 0.08 - ((ny - 0.58) ** 2) / 0.12)
      const wingBlob = Math.exp(-((nx - 0.5) ** 2) / 0.18 - ((ny - 0.45) ** 2) / 0.16) * 0.55
      const edge = Math.min(nx, 1 - nx, ny, 1 - ny)
      const frameFar = edge < 0.06 ? 0.15 : 0

      let depth =
        0.18 + lum * 0.28 + handBlob * 0.55 + faceBlob * 0.38 + bodyBlob * 0.28 + wingBlob * 0.18 - frameFar

      const goldish = r > 160 && g > 120 && b < 120 && lum > 0.45
      if (goldish && (ny > 0.78 || (nx < 0.18 && ny < 0.18) || (nx > 0.82 && ny > 0.78))) {
        depth = 0.42 + lum * 0.08
      }

      out[y * width + x] = Math.round(Math.max(0, Math.min(1, depth)) * a * 255)
    }
  }

  await sharp(out, { raw: { width, height, channels: 1 } }).png().toFile(output)
  console.log(`Heuristic depth → ${output}`)
}

/** Boost outstretched-hand near plane; flatten card chrome a bit. */
async function refineDepth(depthPath, targetW, targetH) {
  const { data, info } = await sharp(depthPath)
    .resize(targetW, targetH, { kernel: 'lanczos3' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { width, height } = info
  const out = Buffer.alloc(width * height)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      let d = data[i] / 255
      const nx = x / width
      const ny = y / height

      // Hand reaching toward camera (upper-right foreshortening in this card).
      const hand = Math.exp(-((nx - 0.7) ** 2) / 0.06 - ((ny - 0.36) ** 2) / 0.08)
      d = Math.min(1, d + hand * 0.28)

      // Bottom nameplate / gems stay nearer to card plane.
      if (ny > 0.78) d = d * 0.72 + 0.28 * 0.45
      // Far corners / vignette
      const edge = Math.min(nx, 1 - nx, ny, 1 - ny)
      if (edge < 0.05) d *= 0.75

      out[i] = Math.round(Math.max(0, Math.min(1, d)) * 255)
    }
  }

  await sharp(out, { raw: { width, height, channels: 1 } }).png().toFile(output)
  console.log(`Refined depth → ${output} (${width}x${height})`)
}

async function aiDepth(inputPath) {
  const model = useBase
    ? 'onnx-community/depth-anything-v2-base'
    : 'onnx-community/depth-anything-v2-small'
  const { pipeline, RawImage } = await import('@huggingface/transformers')
  console.log(`Loading ${model}…`)
  const estimator = await pipeline('depth-estimation', model, { dtype: 'fp32' })

  const image = await RawImage.read(inputPath)
  console.log(`Estimating depth for ${image.width}x${image.height}…`)
  const { depth } = await estimator(image)

  const tmp = path.join(root, 'public', '_depth_raw.png')
  await sharp(Buffer.from(depth.data), {
    raw: { width: depth.width, height: depth.height, channels: 1 },
  })
    .png()
    .toFile(tmp)

  const meta = await sharp(cardPath).metadata()
  await refineDepth(tmp, meta.width, meta.height)
  fs.unlinkSync(tmp)
}

const input = fromClay && fs.existsSync(clayPath) ? clayPath : cardPath
if (fromClay && input === clayPath) console.log('Using GPT clay guide as depth source…')

try {
  if (useAi) await aiDepth(input)
  else await heuristicDepth(cardPath)
} catch (err) {
  console.error('Primary depth path failed:', err)
  console.log('Falling back to heuristic…')
  await heuristicDepth(cardPath)
}

if (!fs.existsSync(output)) process.exit(1)
