import { pathToFileURL } from 'node:url'

/** Temporary Zhipu image links are documented as valid for about 30 days. */
export const IMAGE_URL_TTL_NOTE = '智谱返回的是临时图片链接（通常约 30 天有效）；需要长期保存时请及时转存。'

const GLM_PRESET_SIZES = new Set([
  '1280x1280',
  '1568x1056',
  '1056x1568',
  '1472x1088',
  '1088x1472',
  '1728x960',
  '960x1728',
])

/** Guard against putting a multi-megabyte base64 payload into a chat message. */
const MAX_DATA_URL_CHARS = 6_000_000

/**
 * Trim and, when necessary, truncate by Unicode code point.
 * @param {unknown} value
 * @param {number} max
 * @param {string} label
 * @returns {{text: string, note: string}}
 */
export function truncateText(value, max, label = 'prompt') {
  const text = typeof value === 'string' ? value.trim() : ''
  const chars = Array.from(text)
  if (chars.length <= max) return { text, note: '' }
  return {
    text: chars.slice(0, max).join(''),
    note: `${label} 超过 ${max} 字符上限，已截断（原长 ${chars.length} 字符）。`,
  }
}

/**
 * Validate a GLM-Image size. The API accepts seven presets and custom sizes
 * from 512 to 2048 px, each side a multiple of 32, at most 2^22 pixels.
 * @param {unknown} raw
 * @returns {{ok: true, size: string} | {ok: false, error: string}}
 */
export function validateGlmSize(raw) {
  const size = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : '1280x1280'
  if (GLM_PRESET_SIZES.has(size)) return { ok: true, size }
  const match = /^(\d{3,4})x(\d{3,4})$/u.exec(size)
  if (!match) {
    return {
      ok: false,
      error: `size "${size}" 不合法。推荐使用 1280x1280、1568x1056、1056x1568、1472x1088、1088x1472、1728x960 或 960x1728；自定义格式为 宽x高。`,
    }
  }
  const width = Number(match[1])
  const height = Number(match[2])
  if (width < 512 || width > 2048 || height < 512 || height > 2048) {
    return { ok: false, error: `size "${size}" 超出范围：宽高必须在 512-2048 像素之间。` }
  }
  if (width % 32 !== 0 || height % 32 !== 0) {
    return { ok: false, error: `size "${size}" 不合法：宽高必须是 32 的整数倍。` }
  }
  if (width * height > 4_194_304) {
    return { ok: false, error: `size "${size}" 像素过多：最大 2^22（4194304）像素。` }
  }
  return { ok: true, size }
}

/** @param {unknown} raw @returns {{ok: true, size: string} | {ok: false, error: string}} */
export function validateViduSize(raw) {
  const size = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : '1280x720'
  if (size === '1280x720' || size === '480x360') return { ok: true, size }
  return { ok: false, error: `Vidu2 的 size 只支持 1280x720 或 480x360，收到 "${size}"。` }
}

/**
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function makeAlt(text, limit = 80) {
  const compact = String(text ?? '')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/[[\]]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return (compact || '生成图片').slice(0, limit)
}

/**
 * Convert one API image reference into safe Markdown image syntax.
 *
 * Only HTTPS and data:image URLs are embedded. Plain HTTP is reported as a
 * warning (never silently loaded by the chat renderer), and any other scheme
 * is rejected. The returned markdown is the exact line the model should paste.
 * @param {unknown} rawUrl
 * @param {string} alt
 * @returns {{ok: true, markdown: string, url: string} | {ok: false, reason: string, warning: string}}
 */
export function markdownImage(rawUrl, alt = '生成图片') {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { ok: false, reason: '图片 URL 为空。', warning: '' }
  }
  const url = rawUrl.trim()
  const safeAlt = makeAlt(alt)

  if (url.startsWith('data:image/')) {
    if (!/^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/u.test(url)) {
      return { ok: false, reason: '不支持的 data URL 图片格式（仅支持 PNG/JPEG/WebP/GIF base64）。', warning: '' }
    }
    if (url.length > MAX_DATA_URL_CHARS) {
      return {
        ok: false,
        reason: `base64 图片过大（${Math.round(url.length / 1024)} KiB 字符），为避免撑爆对话已拒绝内嵌。`,
        warning: '',
      }
    }
    return { ok: true, markdown: `![${safeAlt}](${url})`, url }
  }

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: '图片地址不是合法 URL。', warning: '' }
  }
  if (parsed.protocol !== 'https:') {
    const warning = `API 返回了非 HTTPS 图片地址（${parsed.protocol}），为避免不安全加载，未生成 markdown 图片。请手动检查或转存该地址。`
    return { ok: false, reason: warning, warning }
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: '图片 URL 含有用户名/密码，已拒绝内嵌。', warning: '' }
  }
  if (url.length > 16_000) {
    return { ok: false, reason: '图片 URL 过长，已拒绝内嵌。', warning: '' }
  }
  if (/[<>\r\n]/u.test(url)) {
    return { ok: false, reason: '图片 URL 含有不安全字符，已拒绝内嵌。', warning: '' }
  }
  // Parentheses and whitespace are legal in a URL but break the Markdown
  // destination; angle brackets are the CommonMark form for such URLs.
  const destination = /[()\s]/u.test(url) ? `<${url}>` : url
  return { ok: true, markdown: `![${safeAlt}](${destination})`, url }
}

/**
 * Convert a base64 payload to a data URL, sniffing the image MIME from its
 * magic bytes. Returns undefined when the payload is not valid base64.
 * @param {unknown} raw
 * @param {string} [fallbackMime]
 * @returns {string | undefined}
 */
export function dataUrlFromBase64(raw, fallbackMime = 'image/png') {
  if (typeof raw !== 'string') return undefined
  let value = raw.trim()
  if (value.startsWith('data:')) return value
  value = value.replace(/\s+/gu, '')
  if (value === '' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return undefined
  let bytes
  try {
    bytes = Buffer.from(value, 'base64')
  } catch {
    return undefined
  }
  if (bytes.length === 0) return undefined
  const mime = sniffImageMime(bytes) ?? fallbackMime
  return `data:${mime};base64,${value}`
}

/**
 * @param {Buffer|Uint8Array} bytes
 * @returns {string | undefined}
 */
export function sniffImageMime(bytes) {
  if (!bytes || bytes.length < 12) return undefined
  const b = Buffer.from(bytes)
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

/**
 * Turn a local file into a clickable Markdown link. DSH's chat content blocks
 * are text/image only, so audio is delivered as a file link plus transcript.
 * @param {string} filePath
 * @param {string} [label]
 * @returns {string}
 */
export function markdownFileLink(filePath, label = '播放/下载语音') {
  return `[${label}](${pathToFileURL(filePath).href})`
}

/**
 * Extract the first usable image reference from the several shapes the Zhipu
 * image/video APIs use.
 * @param {unknown} body
 * @returns {{url?: string, b64?: string, revisedPrompt?: string}}
 */
export function firstImage(body) {
  const root = body && typeof body === 'object' ? body : {}
  const candidates = []
  if (Array.isArray(root.data)) candidates.push(...root.data)
  if (Array.isArray(root.image_result)) candidates.push(...root.image_result)
  if (Array.isArray(root.images)) candidates.push(...root.images)
  if (Array.isArray(root.result?.images)) candidates.push(...root.result.images)
  const first = candidates.find((item) => item && typeof item === 'object') ?? {}
  return {
    url: typeof first.url === 'string' ? first.url : undefined,
    b64: typeof first.b64_json === 'string' ? first.b64_json : typeof first.base64 === 'string' ? first.base64 : undefined,
    revisedPrompt: typeof first.revised_prompt === 'string' ? first.revised_prompt : undefined,
  }
}

/**
 * @param {unknown} body
 * @returns {{url?: string, cover?: string, id?: string}}
 */
export function firstVideo(body) {
  const root = body && typeof body === 'object' ? body : {}
  const list = []
  if (Array.isArray(root.video_result)) list.push(...root.video_result)
  if (Array.isArray(root.data)) list.push(...root.data)
  if (Array.isArray(root.videos)) list.push(...root.videos)
  if (Array.isArray(root.result?.videos)) list.push(...root.result.videos)
  const first = list.find((item) => item && typeof item === 'object') ?? {}
  return {
    url: typeof first.url === 'string' ? first.url : typeof first.video_url === 'string' ? first.video_url : undefined,
    cover: typeof first.cover_image_url === 'string'
      ? first.cover_image_url
      : typeof first.cover_url === 'string'
        ? first.cover_url
        : undefined,
    id: typeof first.id === 'string' ? first.id : undefined,
  }
}

/**
 * @param {unknown} body
 * @returns {string}
 */
export function firstChoiceText(body) {
  const choice = body?.choices?.[0]
  const content = choice?.message?.content ?? choice?.delta?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim()
  }
  return ''
}

/**
 * @param {number} startedAt
 * @returns {number}
 */
export function elapsedMs(startedAt) {
  return Math.max(0, Math.round(Date.now() - startedAt))
}
