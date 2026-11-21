import {
  IMAGE_URL_TTL_NOTE,
  dataUrlFromBase64,
  firstChoiceText,
  firstImage,
  firstVideo,
  makeAlt,
  markdownImage,
} from './format.js'
import {
  ZhipuError,
  ZhipuTimeoutError,
  pollAsync,
  requestJson,
  taskError,
  taskIdOf,
  taskStatus,
} from './http.js'

export const GLM_IMAGE_MODEL = 'glm-image'
export const COGVIDEO_MODEL = 'cogvideox-3'
export const VIDU_MODELS = Object.freeze({
  image: 'vidu2-image',
  reference: 'vidu2-reference',
  start_end: 'vidu2-start-end',
})

/**
 * @param {{url?: string, b64?: string}} image
 * @param {string} alt
 * @returns {{markdown?: string, url?: string, warning?: string}}
 */
function renderImageRef(image, alt) {
  let url = image.url
  let warning = ''
  if (!url && image.b64) {
    url = dataUrlFromBase64(image.b64)
    if (!url) {
      return { warning: 'API 返回的 base64 图片无法解码，已跳过内嵌。' }
    }
  }
  if (!url) return { warning: 'API 未返回图片 URL 或 base64 数据。' }
  const rendered = markdownImage(url, alt)
  if (!rendered.ok) return { url, warning: rendered.warning || rendered.reason }
  // A data URL is already fully present in markdown; do not duplicate the
  // multi-megabyte payload in output.url as well.
  return {
    markdown: rendered.markdown,
    ...(url.startsWith('data:') ? {} : { url }),
    warning,
  }
}

/**
 * Vidu2 accepts an HTTPS URL or an inline data URL, not a local path.
 * @param {string} value
 * @returns {boolean}
 */
function isRemoteImageRef(value) {
  if (value.startsWith('data:image/')) return /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/u.test(value)
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Text-to-image through the synchronous GLM-Image endpoint.
 * @param {{prompt: string, size?: string, quality?: 'hd', watermark?: boolean}} input
 * @param {object} cfg
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal}} [options]
 * @returns {Promise<{model: string, markdown?: string, url?: string, alt: string, warning?: string, note: string}>}
 */
export async function generateGlmImage(input, cfg, options = {}) {
  const body = {
    model: GLM_IMAGE_MODEL,
    prompt: input.prompt,
    size: input.size ?? '1280x1280',
  }
  if (input.quality === 'hd') body.quality = 'hd'
  if (typeof input.watermark === 'boolean') body.watermark_enabled = input.watermark

  const response = await requestJson(`${cfg.baseUrl}/images/generations`, {
    method: 'POST',
    key: cfg.apiKey,
    body,
    timeoutMs: cfg.requestTimeoutMs,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
  })
  const image = firstImage(response)
  const alt = makeAlt(input.prompt)
  const rendered = renderImageRef(image, alt)
  if (!rendered.markdown) {
    throw new ZhipuError(`GLM-Image 未返回可渲染的图片：${rendered.warning || '响应为空'}`, {
      retryable: false,
    })
  }
  return {
    model: GLM_IMAGE_MODEL,
    markdown: rendered.markdown,
    url: rendered.url,
    alt,
    ...(rendered.warning ? { warning: rendered.warning } : {}),
    note: IMAGE_URL_TTL_NOTE,
  }
}

/**
 * Create one Vidu2 asynchronous task. Text-to-video is intentionally absent:
 * the official vidu2-image model is image-to-video and requires image_url.
 * @param {{
 *   model: string,
 *   prompt: string,
 *   images: string[],
 *   size?: string,
 *   duration?: number,
 *   movementAmplitude?: string,
 *   withAudio?: boolean,
 *   aspectRatio?: string,
 *   seed?: number,
 * }} input
 * @param {object} cfg
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal}} [options]
 * @returns {Promise<{id: string, status: string, model: string}>}
 */
export async function createViduTask(input, cfg, options = {}) {
  const model = input.model
  if (!Object.values(VIDU_MODELS).includes(model)) {
    throw new ZhipuError(`不支持的 Vidu2 模型 "${model}"。可选：vidu2-image、vidu2-reference、vidu2-start-end。`)
  }
  const images = (Array.isArray(input.images) ? input.images : []).filter(
    (item) => typeof item === 'string' && item.trim() !== '',
  )
  if (model === VIDU_MODELS.image && images.length !== 1) {
    throw new ZhipuError('vidu2-image（图生视频）需要恰好 1 张 image_url。')
  }
  if (model === VIDU_MODELS.reference && (images.length < 1 || images.length > 3)) {
    throw new ZhipuError('vidu2-reference（参考生视频）需要 1-3 张参考图。')
  }
  if (model === VIDU_MODELS.start_end && (images.length < 1 || images.length > 2)) {
    throw new ZhipuError('vidu2-start-end（首尾帧）需要 1-2 张图片。')
  }
  for (const image of images) {
    if (!isRemoteImageRef(image)) {
      throw new ZhipuError('Vidu2 的图片必须是 HTTPS URL 或 data:image/...;base64 数据，不支持本地文件路径或 HTTP。')
    }
  }
  if (input.size === '480x360' && model !== VIDU_MODELS.start_end) {
    throw new ZhipuError('Vidu2 的 480x360 尺寸仅支持 vidu2-start-end（首尾帧）模型。')
  }

  const body = {
    model,
    prompt: input.prompt,
    image_url: model === VIDU_MODELS.image ? images[0] : images,
    duration: input.duration ?? 4,
    size: input.size ?? '1280x720',
    movement_amplitude: input.movementAmplitude ?? 'auto',
    with_audio: input.withAudio ?? true,
  }
  if (model === VIDU_MODELS.reference && input.aspectRatio) body.aspect_ratio = input.aspectRatio
  if (input.seed !== undefined) body.seed = input.seed

  const response = await requestJson(`${cfg.baseUrl}/videos/generations`, {
    method: 'POST',
    key: cfg.apiKey,
    body,
    timeoutMs: cfg.requestTimeoutMs,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
  })
  const id = taskIdOf(response)
  if (!id) throw new ZhipuError('Vidu2 提交成功但响应中没有 task id。')
  return { id, status: taskStatus(response) || 'PROCESSING', model }
}

/**
 * Create one CogVideoX-3 asynchronous task.
 *
 * CogVideoX-3 supports three modes:
 * - text-to-video: prompt only;
 * - image-to-video: exactly one image_url (first frame);
 * - first/last-frame: exactly two image_url values.
 *
 * @param {{
 *   prompt?: string,
 *   images?: string[],
 *   size?: string,
 *   fps?: number,
 *   duration?: number,
 *   quality?: 'speed'|'quality',
 *   withAudio?: boolean,
 *   watermark?: boolean,
 * }} input
 * @param {object} cfg
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal}} [options]
 * @returns {Promise<{id: string, status: string, model: string}>}
 */
export async function createCogVideoTask(input, cfg, options = {}) {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  const images = (Array.isArray(input.images) ? input.images : []).filter(
    (item) => typeof item === 'string' && item.trim() !== '',
  )
  if (!prompt && images.length === 0) {
    throw new ZhipuError('CogVideoX-3 需要 prompt 或 image_url 至少一个。')
  }
  if (images.length > 2) {
    throw new ZhipuError('CogVideoX-3 最多支持 2 张图片：1 张首帧，或 2 张首尾帧。')
  }
  for (const image of images) {
    if (!isRemoteImageRef(image)) {
      throw new ZhipuError('CogVideoX-3 的图片必须是 HTTPS URL 或 data:image/...;base64 数据，不支持本地文件路径或 HTTP。')
    }
  }

  const body = {
    model: COGVIDEO_MODEL,
  }
  if (prompt) body.prompt = prompt
  if (images.length === 1) body.image_url = images[0]
  if (images.length === 2) body.image_url = images
  if (input.size) body.size = input.size
  if (input.fps !== undefined) body.fps = input.fps
  if (input.duration !== undefined) body.duration = input.duration
  if (input.quality) body.quality = input.quality
  if (typeof input.withAudio === 'boolean') body.with_audio = input.withAudio
  if (typeof input.watermark === 'boolean') body.watermark_enabled = input.watermark

  const response = await requestJson(`${cfg.baseUrl}/videos/generations`, {
    method: 'POST',
    key: cfg.apiKey,
    body,
    timeoutMs: cfg.requestTimeoutMs,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
  })
  const id = taskIdOf(response)
  if (!id) throw new ZhipuError('CogVideoX-3 提交成功但响应中没有 task id。')
  return { id, status: taskStatus(response) || 'PROCESSING', model: COGVIDEO_MODEL }
}

/**
 * Submit and (by default) poll a CogVideoX-3 task to completion.
 * @param {object} input
 * @param {object} cfg
 * @param {{wait?: boolean, fetchImpl?: typeof fetch, signal?: AbortSignal, timeoutMs?: number}} [options]
 * @returns {Promise<object>}
 */
export async function generateCogVideo(input, cfg, options = {}) {
  const created = await createCogVideoTask(input, cfg, options)
  if (options.wait === false) {
    return {
      taskId: created.id,
      model: created.model,
      status: created.status,
      note: '任务已提交但未等待完成。稍后调用 check_zhipu_task（task_id 参数）查询。',
    }
  }
  const body = await pollAsync(created.id, cfg, {
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  })
  return normalizeSuccess(body, input.prompt ?? '', created.model, created.id)
}

/**
 * @param {{url?: string, cover?: string}} video
 * @param {string} prompt
 * @returns {{videoUrl?: string, coverUrl?: string, markdown?: string, alt: string, warning?: string}}
 */
function renderVideoRef(video, prompt) {
  const alt = makeAlt(prompt || '生成视频')
  if (!video.url) return { alt, warning: '任务成功但响应中没有视频 URL。' }
  let videoUrl = video.url
  let warning = ''
  // Only expose HTTPS video links. A plain http link can be downgraded or
  // intercepted, and DSH would otherwise render it as a clickable result.
  if (!/^https:\/\//iu.test(videoUrl)) {
    warning = '视频 URL 不是 HTTPS，已隐藏该链接；封面图仍会在可用时显示。'
    videoUrl = undefined
  }
  let markdown
  if (video.cover) {
    const cover = markdownImage(video.cover, `${alt}（封面）`)
    if (cover.ok) markdown = cover.markdown
    else warning = [warning, `视频封面无法内嵌：${cover.reason}`].filter(Boolean).join('；')
  }
  return {
    ...(videoUrl ? { videoUrl } : {}),
    ...(video.cover && /^https:\/\//iu.test(video.cover) ? { coverUrl: video.cover } : {}),
    ...(markdown ? { markdown } : {}),
    alt,
    ...(warning ? { warning } : {}),
  }
}

/**
 * @param {any} body
 * @returns {{kind: 'video'|'image'|'text'|'unknown', video?: any, image?: any, text?: string}}
 */
function classifyAsyncBody(body) {
  if (Array.isArray(body?.video_result)) {
    return { kind: 'video', video: firstVideo(body) }
  }
  if (Array.isArray(body?.image_result)) {
    return { kind: 'image', image: firstImage(body) }
  }
  if (Array.isArray(body?.choices)) {
    return { kind: 'text', text: firstChoiceText(body) }
  }
  if (Array.isArray(body?.data)) {
    const hasVideoShape = body.data.some((item) => item && (item.video_url || item.cover_image_url))
    return hasVideoShape
      ? { kind: 'video', video: firstVideo(body) }
      : { kind: 'image', image: firstImage(body) }
  }
  return { kind: 'unknown' }
}

/**
 * @param {any} body
 * @param {string} prompt
 * @param {string} model
 * @param {string} taskId
 * @returns {object}
 */
function normalizeSuccess(body, prompt, model, taskId) {
  const classified = classifyAsyncBody(body)
  if (classified.kind === 'video') {
    const rendered = renderVideoRef(classified.video ?? {}, prompt)
    return { taskId, model, status: 'SUCCESS', ...rendered }
  }
  if (classified.kind === 'image') {
    const alt = makeAlt(prompt)
    const rendered = renderImageRef(classified.image ?? {}, alt)
    if (!rendered.markdown) {
      throw new ZhipuError(`异步任务 ${taskId} 成功，但图片结果无法渲染：${rendered.warning || '响应为空'}`)
    }
    return {
      taskId,
      model,
      status: 'SUCCESS',
      url: rendered.url,
      markdown: rendered.markdown,
      alt,
      ...(rendered.warning ? { warning: rendered.warning } : {}),
    }
  }
  if (classified.kind === 'text') {
    return { taskId, model, status: 'SUCCESS', text: classified.text }
  }
  throw new ZhipuError(`异步任务 ${taskId} 成功，但响应中没有可识别的结果。`)
}

/**
 * Submit and (by default) poll a Vidu2 task to completion.
 * @param {object} input
 * @param {object} cfg
 * @param {{wait?: boolean, fetchImpl?: typeof fetch, signal?: AbortSignal, timeoutMs?: number}} [options]
 * @returns {Promise<object>}
 */
export async function generateVidu(input, cfg, options = {}) {
  const created = await createViduTask(input, cfg, options)
  if (options.wait === false) {
    return {
      taskId: created.id,
      model: created.model,
      status: created.status,
      note: '任务已提交但未等待完成。稍后调用 check_zhipu_task（task_id 参数）查询。',
    }
  }
  const body = await pollAsync(created.id, cfg, {
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  })
  return normalizeSuccess(body, input.prompt, created.model, created.id)
}

/**
 * Look up one asynchronous Vidu2/GLM-Image task.
 * @param {string} taskId
 * @param {object} cfg
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal}} [options]
 * @returns {Promise<object>}
 */
export async function checkZhipuTask(taskId, cfg, options = {}) {
  const body = await requestJson(`${cfg.baseUrl}/async-result/${encodeURIComponent(taskId)}`, {
    key: cfg.apiKey,
    timeoutMs: cfg.requestTimeoutMs,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
  })
  const status = taskStatus(body) || 'PROCESSING'
  if (status === 'FAIL' || status === 'FAILED' || status === 'CANCELED' || status === 'CANCELLED') {
    throw new ZhipuError(`异步任务 ${taskId} 失败：${taskError(body) || `状态 ${status}`}`, { taskId })
  }
  if (status !== 'SUCCESS') {
    return { taskId, status, note: '任务仍在处理中，请稍后再次查询。' }
  }
  return normalizeSuccess(body, '', 'unknown', taskId)
}

/**
 * Character chat. Tries the configured CharGLM endpoint first, then falls
 * back to a standard GLM chat model with the persona moved into a system
 * message. Auth and rate-limit errors are not "model unavailable" and are
 * surfaced directly.
 * @param {{prompt: string, systemRole?: string, userInfo?: string, botInfo?: string, temperature?: number, history?: {role: string, content: string}[]}} input
 * @param {object} cfg
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal}} [options]
 * @returns {Promise<object>}
 */
export async function chatChar(input, cfg, options = {}) {
  const persona = input.systemRole?.trim() || ''
  const botInfo = input.botInfo?.trim() || persona
  const userInfo = input.userInfo?.trim() || ''
  const history = Array.isArray(input.history) ? input.history : []
  const meta = {}
  if (botInfo) meta.bot_info = botInfo
  if (userInfo) meta.user_info = userInfo

  const primaryBody = {
    model: cfg.charModel,
    messages: [...history, { role: 'user', content: input.prompt }],
    stream: false,
  }
  if (Object.keys(meta).length > 0) primaryBody.meta = meta
  if (typeof input.temperature === 'number') primaryBody.temperature = input.temperature

  try {
    const response = await requestJson(cfg.charEndpoint, {
      method: 'POST',
      key: cfg.apiKey,
      body: primaryBody,
      timeoutMs: cfg.requestTimeoutMs,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    })
    const text = firstChoiceText(response)
    if (!text) throw new ZhipuError('CharGLM 返回了空文本。')
    return { text, model: cfg.charModel, degraded: false, prompt: input.prompt }
  } catch (error) {
    if (!(error instanceof ZhipuError) || !shouldFallbackChar(error)) throw error

    const system = persona || '你正在扮演一个角色，请始终保持人设与语气。'
    const fallbackBody = {
      model: cfg.charFallbackModel,
      messages: [
        { role: 'system', content: system },
        ...history,
        { role: 'user', content: input.prompt },
      ],
      stream: false,
    }
    if (typeof input.temperature === 'number') fallbackBody.temperature = input.temperature
    try {
      const response = await requestJson(cfg.charFallbackEndpoint || cfg.charEndpoint, {
        method: 'POST',
        key: cfg.apiKey,
        body: fallbackBody,
        timeoutMs: cfg.requestTimeoutMs,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
      })
      const text = firstChoiceText(response)
      if (!text) throw new ZhipuError('降级模型返回了空文本。')
      return {
        text,
        model: cfg.charFallbackModel,
        degraded: true,
        prompt: input.prompt,
        warning: `CharGLM-4（${cfg.charModel}）不可用，已降级到 ${cfg.charFallbackModel}，人设由 system message 承载。原始错误：${error.message}`,
      }
    } catch (fallbackError) {
      const second = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      throw new ZhipuError(
        `CharGLM-4 及其降级模型均不可用。CharGLM 错误：${error.message}；降级错误：${second}`,
        { cause: fallbackError },
      )
    }
  }
}

/**
 * A 400/404/422 from a character endpoint usually means the model or meta
 * shape is unsupported, which is exactly the case the fallback exists for.
 * @param {ZhipuError} error
 * @returns {boolean}
 */
function shouldFallbackChar(error) {
  if (error.status === 401 || error.status === 403 || error.status === 429) return false
  if (/api.?key|authentication|unauthori[sz]ed|鉴权|密钥/iu.test(error.message)) return false
  if (error.status === 404 || error.status === 422) return true
  if (error.status === 400) {
    return /model|meta|parameter|unsupported|invalid|not found|不存在|不支持|参数/iu.test(error.message)
  }
  return false
}
