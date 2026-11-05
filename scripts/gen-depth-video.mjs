/**
 * Per-frame depth for card.mp4 → public/depth.mp4 (+ optional PNG sequence)
 *
 *   node scripts/gen-depth-video.mjs
 *
 * Uses Depth Anything V2 small. Processes under C:\temp\angelvid to avoid
 * non-ASCII path issues with some native deps, then copies depth.mp4 back.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const publicDir = path.join(root, 'public')

const work = 'C:\\temp\\angelvid'
const videoIn = path.join(work, 'card.mp4')
const framesDir = path.join(work, 'frames')
const depthsDir = path.join(work, 'depths')
const depthVideoOut = path.join(work, 'depth.mp4')
const depthVideoPublic = path.join(publicDir, 'depth.mp4')

fs.mkdirSync(framesDir, { recursive: true })
fs.mkdirSync(depthsDir, { recursive: true })

if (!fs.existsSync(videoIn)) {
  const src = path.join(publicDir, 'card.mp4')
  if (!fs.existsSync(src)) throw new Error('Missing public/card.mp4')
  fs.copyFileSync(src, videoIn)
}

// 1) Extract frames with OpenCV via python (reliable on this machine)
console.log('Extracting frames…')
const extract = spawnSync(
  'python',
  [
    '-c',
    `
import cv2, os
src = r'${videoIn.replace(/\\/g, '\\\\')}'
out = r'${framesDir.replace(/\\/g, '\\\\')}'
os.makedirs(out, exist_ok=True)
c = cv2.VideoCapture(src)
n = int(c.get(cv2.CAP_PROP_FRAME_COUNT))
fps = c.get(cv2.CAP_PROP_FPS) or 24
w = int(c.get(cv2.CAP_PROP_FRAME_WIDTH))
h = int(c.get(cv2.CAP_PROP_FRAME_HEIGHT))
i = 0
while True:
    ok, frame = c.read()
    if not ok: break
    cv2.imwrite(os.path.join(out, f'{i:04d}.jpg'), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    i += 1
c.release()
open(os.path.join(r'${work.replace(/\\/g, '\\\\')}', 'meta.txt'), 'w').write(f'{i},{fps},{w},{h}')
print('frames', i, 'fps', fps, 'size', w, h)
`,
  ],
  { encoding: 'utf8' },
)
if (extract.status !== 0) {
  console.error(extract.stdout, extract.stderr)
  process.exit(1)
}
console.log(extract.stdout)

const meta = fs.readFileSync(path.join(work, 'meta.txt'), 'utf8').trim().split(',')
const frameCount = Number(meta[0])
const fps = Number(meta[1]) || 24
const width = Number(meta[2])
const height = Number(meta[3])

// 2) Depth Anything per frame
const { pipeline, RawImage } = await import('@huggingface/transformers')
console.log('Loading Depth Anything V2 small…')
const estimator = await pipeline(
  'depth-estimation',
  'onnx-community/depth-anything-v2-small',
  { dtype: 'fp32' },
)

for (let i = 0; i < frameCount; i++) {
  const framePath = path.join(framesDir, `${String(i).padStart(4, '0')}.jpg`)
  const outPath = path.join(depthsDir, `${String(i).padStart(4, '0')}.png`)
  if (fs.existsSync(outPath)) {
    if (i % 30 === 0) console.log(`skip existing ${i}/${frameCount}`)
    continue
  }
  const image = await RawImage.read(framePath)
  const { depth } = await estimator(image)
  await sharp(Buffer.from(depth.data), {
    raw: { width: depth.width, height: depth.height, channels: 1 },
  })
    .resize(width, height, { kernel: 'lanczos3' })
    .png()
    .toFile(outPath)
  if (i % 10 === 0 || i === frameCount - 1) {
    console.log(`depth ${i + 1}/${frameCount}`)
  }
}

// 3) Encode browser-playable H.264 depth video via bundled ffmpeg
console.log('Encoding depth.mp4 (libx264)…')
const encode = spawnSync(
  'python',
  [
    '-c',
    `
import imageio_ffmpeg, subprocess, os
ff = imageio_ffmpeg.get_ffmpeg_exe()
depths = r'${depthsDir.replace(/\\/g, '\\\\')}'
out = r'${depthVideoOut.replace(/\\/g, '\\\\')}'
fps = ${fps}
cmd = [ff, '-y', '-framerate', str(fps), '-i', os.path.join(depths, '%04d.png'),
       '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-an', out]
print(' '.join(cmd))
subprocess.check_call(cmd)
print('wrote', out)
`,
  ],
  { encoding: 'utf8' },
)
if (encode.status !== 0) {
  console.error(encode.stdout, encode.stderr)
  process.exit(1)
}
console.log(encode.stdout)

fs.copyFileSync(depthVideoOut, depthVideoPublic)
console.log('Copied →', depthVideoPublic)

// Manifest for the app
fs.writeFileSync(
  path.join(publicDir, 'depth-meta.json'),
  JSON.stringify({ frameCount, fps, width, height, invert: false }, null, 2),
)
console.log('Done.')
