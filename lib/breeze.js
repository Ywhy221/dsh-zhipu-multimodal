/**
 * Local Breeze-TTS-2 bridge.
 *
 * Breeze is a separate cpp-httplib server with an OpenAI-compatible
 * `/v1/audio/speech` endpoint. It speaks 16-bit mono 24 kHz WAV when asked for
 * `response_format: "wav"`. Its streaming WAV header deliberately writes
 * 0xFFFFFFFF into the RIFF/data length fields, so bytes are normalised before
 * they are saved or sent to a browser.
 *
 * Nothing here is imported by the model-facing tool definitions at load time;
 * all network and process work happens inside execute()/route handlers.
 */
import { spawn } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const DEFAULT_HOME = 'D:\\DeepSeek work\\Breeze-TTS-2.cpp'
const DEFAULT_BASE_URL = 'http://127.0.0.1:8080'
const DEFAULT_INSTRUCTION = 'Speak clearly and naturally.'

/** @typedef {{home:string, baseUrl:string, exe:string, model:string, autostart:boolean, audioDir:string, timeoutMs:number, startTimeoutMs:number}} BreezeConfig */

/** A Breeze failure that can be shown to a model/user without a stack trace. */
export class BreezeError extends Error {
  /** @param {string} message @param {{status?:number, code?:string}} [options] */
  constructor(message, options = {}) {
    super(message)
    this.name = 'BreezeError'
    this.status = options.status
    this.code = options.code
  }
}

let fetchImpl = globalThis.fetch
let starting = null

/** Test hook: replace fetch without touching the real local server. */
export function __setBreezeFetch(impl) {
  fetchImpl = impl ?? globalThis.fetch
}

/** @returns {BreezeConfig} */
export function breezeConfig() {
  const home = process.env.BREEZE_HOME?.trim() || DEFAULT_HOME
  const baseUrl = (process.env.BREEZE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/u, '')
  return {
    home,
    baseUrl,
    exe: process.env.BREEZE_EXE?.trim() || path.join(home, 'app', 'breeze-tts-2-v0.1.6-windows-x64-vulkan', 'breeze-server.exe'),
    model: process.env.BREEZE_MODEL?.trim() || path.join(home, 'models', 'breeze-tts-2-q8_0.gguf'),
    autostart: process.env.BREEZE_AUTOSTART !== '0',
    audioDir: process.env.BREEZE_AUDIO_DIR?.trim() || path.join(os.homedir(), '.dsh', 'cache', 'zhipu-multimodal', 'breeze'),
    timeoutMs: positiveInt(process.env.BREEZE_TIMEOUT_MS, 180_000),
    startTimeoutMs: positiveInt(process.env.BREEZE_START_TIMEOUT_MS, 60_000),
  }
}

/** @param {string|undefined} raw @param {number} fallback */
function positiveInt(raw, fallback) {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** @param {string} file */
async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

/**
 * Probe `/health`. It answers only after the model has loaded, which is why a
 * failed probe is also the signal that an auto-start is still warming up.
 * @param {BreezeConfig} cfg
 * @param {{timeoutMs?:number}} [options]
 */
export async function checkBreezeHealth(cfg = breezeConfig(), options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_500)
  try {
    const response = await fetchImpl(`${cfg.baseUrl}/health`, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      return { ok: false, baseUrl: cfg.baseUrl, error: `HTTP ${response.status}` }
    }
    const data = await response.json().catch(() => null)
    return { ok: true, baseUrl: cfg.baseUrl, data }
  } catch (error) {
    return { ok: false, baseUrl: cfg.baseUrl, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** @param {string} baseUrl */
function isLocalBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl)
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

/**
 * Make sure Breeze is up. Existing servers are reused. A local server that is
 * down is started from BREEZE_EXE/BREEZE_MODEL once, with a shared promise so
 * concurrent tool calls cannot launch two models.
 * @param {BreezeConfig} cfg
 * @param {{autostart?:boolean}} [options]
 */
export async function ensureBreeze(cfg = breezeConfig(), options = {}) {
  const health = await checkBreezeHealth(cfg)
  if (health.ok) return health

  if (options.autostart === false || !cfg.autostart) {
    throw new BreezeError('Breeze 本地服务未启动。请先运行 Breeze-TTS-2.cpp\\start-breeze-server.cmd，或设置 BREEZE_AUTOSTART=1 让插件自动启动。', { code: 'breeze-offline' })
  }
  if (!isLocalBaseUrl(cfg.baseUrl)) {
    throw new BreezeError(`无法连接 Breeze 服务 ${cfg.baseUrl}。非本机地址不会自动启动，请自行启动服务或检查 BREEZE_BASE_URL。`, { code: 'breeze-remote-offline' })
  }
  if (starting !== null) return starting

  starting = (async () => {
    if (!(await exists(cfg.exe))) {
      throw new BreezeError(`找不到 Breeze 服务程序：${cfg.exe}。请设置 BREEZE_HOME 或 BREEZE_EXE。`, { code: 'breeze-exe-missing' })
    }
    if (!(await exists(cfg.model))) {
      throw new BreezeError(`找不到 Breeze 模型：${cfg.model}。请设置 BREEZE_HOME 或 BREEZE_MODEL。`, { code: 'breeze-model-missing' })
    }

    const port = new URL(cfg.baseUrl).port || '8080'
    let spawnError = null
    const child = spawn(cfg.exe, [cfg.model, '--webui', '--port', port], {
      cwd: path.dirname(cfg.exe),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', (error) => {
      spawnError = error
    })
    child.unref()

    const deadline = Date.now() + cfg.startTimeoutMs
    while (Date.now() < deadline) {
      if (spawnError !== null) {
        throw new BreezeError(`无法启动 Breeze：${spawnError.message}`, { code: 'breeze-spawn-failed' })
      }
      await sleep(500)
      const probe = await checkBreezeHealth(cfg, { timeoutMs: 2_000 })
      if (probe.ok) return probe
    }
    throw new BreezeError(`Breeze 启动超时（${Math.round(cfg.startTimeoutMs / 1000)} 秒）。模型较大，首次加载可能较慢；可查看 Breeze 控制台或手动运行 start-breeze-server.cmd。`, { code: 'breeze-start-timeout' })
  })()

  try {
    return await starting
  } finally {
    starting = null
  }
}

/**
 * Read the Breeze binary as a normalised WAV buffer.
 * @param {unknown} value
 * @returns {Buffer|null}
 */
export function normalizeWav(value) {
  if (!Buffer.isBuffer(value) || value.length < 44) return null
  if (value.subarray(0, 4).toString('latin1') !== 'RIFF') return null
  if (value.subarray(8, 12).toString('latin1') !== 'WAVE') return null

  let offset = 12
  while (offset + 8 <= value.length) {
    const id = value.subarray(offset, offset + 4).toString('latin1')
    const size = value.readUInt32LE(offset + 4)
    if (id === 'data') {
      const actual = value.length - (offset + 8)
      if (size === 0xffffffff || size > actual) value.writeUInt32LE(actual, offset + 4)
      break
    }
    if (size === 0xffffffff || size === 0) break
    offset += 8 + size + (size % 2)
  }
  value.writeUInt32LE(value.length - 8, 4)
  return value
}

/** @param {string} text @param {number} max */
function clip(text, max) {
  const chars = Array.from(text)
  return chars.length > max ? chars.slice(0, max).join('') : text
}

/**
 * Request one WAV from Breeze. Buffers the whole response so the WAV lengths
 * can be corrected and the browser gets an honest Content-Length.
 * @param {{text:string, instruction?:string, voice?:string, seed?:number, cfgScale?:number}} input
 * @param {BreezeConfig} cfg
 */
export async function requestBreezeSpeech(input, cfg = breezeConfig()) {
  await ensureBreeze(cfg)

  const text = clip(String(input.text ?? '').trim(), 4_000)
  if (text === '') throw new BreezeError('text 不能为空。', { status: 400, code: 'breeze-empty-text' })

  const payload = {
    model: 'tts-1',
    input: text,
    instructions: input.instruction?.trim() || DEFAULT_INSTRUCTION,
    response_format: 'wav',
    stream_format: 'audio',
    seed: Number.isFinite(input.seed) ? input.seed : 42,
    cfg_scale: Number.isFinite(input.cfgScale) ? input.cfgScale : 1,
  }
  const voice = input.voice?.trim()
  if (voice) payload.voice = voice

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
  try {
    const response = await fetchImpl(`${cfg.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/wav, audio/*' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      let message = raw.trim()
      try {
        const parsed = JSON.parse(raw)
        message = parsed?.error?.message || parsed?.error || parsed?.message || message
      } catch {
        // Keep the plain-text body.
      }
      const friendly = response.status === 404
        ? 'Breeze 不认识这个音色；留空可让 Breeze 根据 instructions 设计音色。'
        : response.status === 409
          ? 'Breeze 正忙（所有生成槽位已占用），请稍后重试。'
          : message || `Breeze 返回 HTTP ${response.status}`
      throw new BreezeError(friendly, { status: response.status, code: 'breeze-speech-failed' })
    }
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('audio/')) {
      throw new BreezeError(`Breeze 返回了非音频响应（${contentType || '无 Content-Type'}）。`, { code: 'breeze-not-audio' })
    }
    const bytes = normalizeWav(Buffer.from(await response.arrayBuffer()))
    if (bytes === null) {
      throw new BreezeError('Breeze 返回的音频不是有效的 RIFF/WAVE。', { code: 'breeze-invalid-wav' })
    }
    return { bytes, contentType: 'audio/wav', sampleRate: 24_000, text }
  } catch (error) {
    if (error instanceof BreezeError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new BreezeError(`Breeze 合成超时（${Math.round(cfg.timeoutMs / 1000)} 秒）。`, { code: 'breeze-timeout' })
    }
    throw new BreezeError(`无法连接 Breeze：${error instanceof Error ? error.message : String(error)}`, { code: 'breeze-network' })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Persist a WAV under the bridge's cache directory.
 * @param {Buffer} bytes
 * @param {BreezeConfig} cfg
 */
export async function saveBreezeAudio(bytes, cfg = breezeConfig()) {
  await mkdir(cfg.audioDir, { recursive: true })
  const fileName = `breeze-${Date.now()}-${randomUUID().slice(0, 8)}.wav`
  const filePath = path.join(cfg.audioDir, fileName)
  await writeFile(filePath, bytes)
  return { filePath, fileName }
}

/** @param {string} fileName */
export function breezeAudioPath(fileName) {
  return `/zhipu/breeze/audio/${encodeURIComponent(fileName)}`
}

/**
 * Status for the sidebar and diagnostics. Does not auto-start the model.
 * @param {BreezeConfig} cfg
 */
export async function breezeStatus(cfg = breezeConfig()) {
  const [health, exeExists, modelExists] = await Promise.all([
    checkBreezeHealth(cfg),
    exists(cfg.exe),
    exists(cfg.model),
  ])
  return {
    running: health.ok,
    baseUrl: cfg.baseUrl,
    health: health.ok ? health.data : undefined,
    error: health.ok ? undefined : health.error,
    autostart: cfg.autostart,
    exeExists,
    modelExists,
    exe: cfg.exe,
    model: cfg.model,
  }
}
