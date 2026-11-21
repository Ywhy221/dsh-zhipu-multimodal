/**
 * Zhipu HTTP plumbing: one authenticated JSON request, one binary request,
 * and one async-task poller. Every failure becomes a ZhipuError carrying a
 * human-readable message, so tools never leak an uncaught exception.
 */

/** @type {typeof fetch} */
let fetchImpl = globalThis.fetch

/** Test-only seam. @param {typeof fetch} impl */
export function __setFetch(impl) {
  fetchImpl = impl
}

export class ZhipuError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: string, taskId?: string, retryable?: boolean, cause?: unknown}} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ZhipuError'
    this.status = options.status ?? 0
    this.code = options.code ?? ''
    this.taskId = options.taskId ?? ''
    this.retryable = options.retryable ?? false
  }
}

export class ZhipuTimeoutError extends ZhipuError {
  /** @param {string} message @param {string} taskId */
  constructor(message, taskId) {
    super(message, { taskId, retryable: true })
    this.name = 'ZhipuTimeoutError'
    this.taskId = taskId
  }
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/**
 * Read an API error body into a concise message. Never echoes the API key.
 * @param {number} status
 * @param {string} text
 * @returns {string}
 */
export function apiErrorMessage(status, text) {
  let message = ''
  try {
    const body = JSON.parse(text)
    message = body?.error?.message
      ?? body?.error?.msg
      ?? body?.error
      ?? body?.message
      ?? body?.msg
      ?? ''
    if (typeof message !== 'string') message = JSON.stringify(message)
  } catch {
    message = String(text ?? '').trim()
  }
  if (message.length > 800) message = `${message.slice(0, 800)}…`
  if (message === '') message = '服务端未返回错误详情'
  return `智谱 API 返回 HTTP ${status}：${message}`
}

/**
 * @param {string} url
 * @param {{
 *   method?: string,
 *   key: string,
 *   body?: object,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<any>}
 */
export async function requestJson(url, options) {
  const doFetch = options.fetchImpl ?? fetchImpl
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error(`timeout after ${options.timeoutMs ?? 60_000}ms`)),
    options.timeoutMs ?? 60_000,
  )
  const abortFromCaller = () => controller.abort(options.signal?.reason ?? new Error('aborted'))
  if (options.signal) {
    if (options.signal.aborted) abortFromCaller()
    else options.signal.addEventListener('abort', abortFromCaller, { once: true })
  }

  let response
  try {
    response = await doFetch(url, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${options.key}`,
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason
      const text = reason instanceof Error && reason.message.startsWith('timeout')
        ? `请求超时（${options.timeoutMs ?? 60_000}ms）。`
        : '请求已取消。'
      throw new ZhipuError(`${text} 请检查网络或稍后重试。`, { retryable: true, cause: error })
    }
    throw new ZhipuError(
      `网络请求失败：${error instanceof Error ? error.message : String(error)}。请检查网络或代理设置。`,
      { retryable: true, cause: error },
    )
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abortFromCaller)
  }

  const text = await response.text()
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500
    throw new ZhipuError(apiErrorMessage(response.status, text), {
      status: response.status,
      retryable,
    })
  }
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ZhipuError('智谱 API 返回了非 JSON 内容，可能是网关错误。', {
      status: response.status,
      retryable: true,
    })
  }
}

/**
 * Binary download/response, used by GLM-TTS.
 * @param {string} url
 * @param {{method?: string, key: string, body?: object, timeoutMs?: number, signal?: AbortSignal, fetchImpl?: typeof fetch}} options
 * @returns {Promise<{bytes: Buffer, contentType: string, status: number}>}
 */
export async function requestBinary(url, options) {
  const doFetch = options.fetchImpl ?? fetchImpl
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error(`timeout after ${options.timeoutMs ?? 60_000}ms`)),
    options.timeoutMs ?? 60_000,
  )
  const abortFromCaller = () => controller.abort(options.signal?.reason ?? new Error('aborted'))
  if (options.signal) {
    if (options.signal.aborted) abortFromCaller()
    else options.signal.addEventListener('abort', abortFromCaller, { once: true })
  }
  try {
    const response = await doFetch(url, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${options.key}`,
        Accept: 'audio/wav, application/octet-stream, application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    })
    const contentType = response.headers.get('content-type') ?? ''
    if (!response.ok) {
      const text = await response.text()
      throw new ZhipuError(apiErrorMessage(response.status, text), {
        status: response.status,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      })
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (contentType.includes('application/json')) {
      throw new ZhipuError(
        `语音接口返回 JSON 而非音频：${bytes.toString('utf8').slice(0, 500)}`,
        { status: response.status },
      )
    }
    return { bytes, contentType, status: response.status }
  } catch (error) {
    if (error instanceof ZhipuError) throw error
    if (controller.signal.aborted) {
      throw new ZhipuError('语音请求超时或已取消，请稍后重试。', { retryable: true, cause: error })
    }
    throw new ZhipuError(
      `网络请求失败：${error instanceof Error ? error.message : String(error)}。`,
      { retryable: true, cause: error },
    )
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abortFromCaller)
  }
}

/** @param {any} body @returns {string} */
export function taskStatus(body) {
  const raw = body?.task_status
    ?? body?.status
    ?? body?.data?.task_status
    ?? body?.data?.status
    ?? ''
  return String(raw).toUpperCase()
}

/** @param {any} body @returns {string} */
export function taskError(body) {
  const raw = body?.error?.message
    ?? body?.error
    ?? body?.fail_reason
    ?? body?.message
    ?? body?.data?.error
    ?? ''
  return typeof raw === 'string' ? raw : JSON.stringify(raw)
}

/** @param {any} body @returns {string} */
export function taskIdOf(body) {
  const raw = body?.id ?? body?.task_id ?? body?.data?.id ?? body?.data?.task_id ?? ''
  return typeof raw === 'string' ? raw : ''
}

/**
 * Poll GET /async-result/{id} until SUCCESS, FAIL, or the deadline.
 * Sleeps between requests, so it yields to the Host event loop.
 * @param {string} id
 * @param {{baseUrl: string, apiKey: string, pollIntervalMs?: number, pollTimeoutMs?: number}} cfg
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal, timeoutMs?: number, intervalMs?: number, onStatus?: (status: string, body: any) => void}} [options]
 * @returns {Promise<any>}
 */
export async function pollAsync(id, cfg, options = {}) {
  const intervalMs = options.intervalMs ?? cfg.pollIntervalMs ?? 3_000
  const timeoutMs = options.timeoutMs ?? cfg.pollTimeoutMs ?? 180_000
  const deadline = Date.now() + timeoutMs
  let lastStatus = ''

  for (;;) {
    const body = await requestJson(`${cfg.baseUrl}/async-result/${encodeURIComponent(id)}`, {
      key: cfg.apiKey,
      timeoutMs: Math.min(cfg.requestTimeoutMs ?? 60_000, Math.max(1_000, deadline - Date.now())),
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    })
    const status = taskStatus(body) || 'PROCESSING'
    lastStatus = status
    options.onStatus?.(status, body)
    if (status === 'SUCCESS') return body
    if (status === 'FAIL' || status === 'FAILED' || status === 'CANCELED' || status === 'CANCELLED') {
      throw new ZhipuError(`异步任务 ${id} 失败：${taskError(body) || `状态 ${status}`}`, {
        taskId: id,
        status: 0,
      })
    }
    if (Date.now() + intervalMs >= deadline) {
      throw new ZhipuTimeoutError(
        `异步任务 ${id} 在 ${Math.round(timeoutMs / 1000)} 秒内未完成（最后状态：${lastStatus}）。可调用 check_zhipu_task 继续查询。`,
        id,
      )
    }
    await sleep(intervalMs)
  }
}
