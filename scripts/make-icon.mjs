/**
 * Generate the bundle's original icon without an image dependency.
 * 128x128 RGBA PNG: violet-to-teal gradient with a white image-frame glyph.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const W = 128
const H = 128
const pixels = Buffer.alloc(W * H * 4)

function set(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= W || y >= H) return
  const i = (y * W + x) * 4
  pixels[i] = r
  pixels[i + 1] = g
  pixels[i + 2] = b
  pixels[i + 3] = 255
}

function inRect(x, y, x0, y0, x1, y1) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1
}

for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = (x + y) / (W + H)
    set(x, y, Math.round(43 + t * 20), Math.round(27 + t * 90), Math.round(90 + t * 70))
  }
}

// White image frame with a 6 px border.
for (let y = 30; y <= 94; y += 1) {
  for (let x = 24; x <= 104; x += 1) {
    const border = inRect(x, y, 24, 30, 104, 94) && !inRect(x, y, 30, 36, 98, 88)
    if (border) set(x, y, 245, 250, 255)
  }
}

// Sun.
for (let y = 40; y <= 50; y += 1) {
  for (let x = 38; x <= 48; x += 1) {
    if ((x - 43) ** 2 + (y - 45) ** 2 <= 25) set(x, y, 255, 214, 102)
  }
}

// Mountain silhouette inside the frame.
for (let y = 64; y <= 87; y += 1) {
  for (let x = 30; x <= 98; x += 1) {
    const left = 68 - (y - 64) * 1.7
    const right = 88 + (y - 64) * 0.9
    if (x >= left && x <= right) set(x, y, 245, 250, 255)
  }
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0)
  return Buffer.concat([length, name, data, crc])
}

const raw = Buffer.alloc((W * 4 + 1) * H)
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 4 + 1)] = 0
  pixels.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4)
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8
ihdr[9] = 6
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync('assets', { recursive: true })
writeFileSync('assets/icon.png', png)
console.log(`wrote assets/icon.png (${png.length} bytes)`)
