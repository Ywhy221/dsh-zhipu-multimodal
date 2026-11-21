import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
const ENV_FILE = path.join(os.homedir(), '.glm', '.env')
const MISSING_KEY_MESSAGE = [
  '未找到 ZHIPU_API_KEY。',
  '请设置环境变量 ZHIPU_API_KEY，或在 ~/.glm/.env 中写入一行 ZHIPU_API_KEY=你的密钥。',
  '密钥只从运行环境读取，本插件不会把密钥写入代码、工具 schema、日志或结果。',
].join('')

/** @type {null | (() => Promise<{key?: string, source?: string, error?: string}>)} */
let keyResolver = null

/**
 * Test-only seam: replace credential resolution without touching the real
 * environment or the user's ~/.glm/.env.
 * @param {null | (() => Promise<{key?: string, source?: string, error?: string}>)} resolver
 */
export function __setKeyResolver(resolver) {
  keyResolver = resolver
}

/**
 * Parse a dotenv-style file conservatively. Values may be quoted; `export` is
 * accepted. Duplicate keys resolve to the last one, as dotenv does.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvText(text) {
  const out = {}
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[match[1]] = value
  }
  return out
}

/**
 * Resolve the API key from the process environment first, then ~/.glm/.env.
 * The returned object never contains a log-safe representation of the key.
 * @returns {Promise<{key?: string, source?: string, error?: string}>}
 */
export async function resolveApiKey() {
  if (keyResolver !== null) return keyResolver()

  const fromEnv = process.env.ZHIPU_API_KEY?.trim()
  if (fromEnv) return { key: fromEnv, source: 'env' }

  if (process.env.ZHIPU_DISABLE_ENV_FILE === '1') {
    return { key: undefined, source: 'none', error: MISSING_KEY_MESSAGE }
  }

  try {
    const text = await readFile(ENV_FILE, 'utf8')
    const parsed = parseEnvText(text)
    const key = parsed.ZHIPU_API_KEY?.trim()
    if (key) return { key, source: '~/.glm/.env' }
    return { key: undefined, source: '~/.glm/.env', error: MISSING_KEY_MESSAGE }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { key: undefined, source: 'none', error: MISSING_KEY_MESSAGE }
    }
    return {
      key: undefined,
      source: '~/.glm/.env',
      error: `${MISSING_KEY_MESSAGE} 读取 ~/.glm/.env 失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * @param {string} name
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function envInt(name, fallback, min, max) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback
  return Math.round(parsed)
}

/**
 * Read runtime configuration at call time. Credentials are intentionally not
 * cached, so a key added to the environment while the Host is running is seen
 * by the next call.
 * @returns {Promise<object>}
 */
export async function getConfig() {
  const credential = await resolveApiKey()
  const baseUrl = (process.env.ZHIPU_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/u, '')
  return {
    apiKey: credential.key,
    apiKeySource: credential.source ?? 'none',
    apiKeyError: credential.error,
    baseUrl,
    charEndpoint: process.env.ZHIPU_CHAR_ENDPOINT?.trim() || `${baseUrl}/chat/completions`,
    charFallbackEndpoint: process.env.ZHIPU_CHAR_FALLBACK_ENDPOINT?.trim() || `${baseUrl}/chat/completions`,
    charModel: process.env.ZHIPU_CHAR_MODEL?.trim() || 'charglm-4',
    charFallbackModel: process.env.ZHIPU_CHAR_FALLBACK_MODEL?.trim() || 'glm-4-flash',
    requestTimeoutMs: envInt('ZHIPU_REQUEST_TIMEOUT_MS', 60_000, 1_000, 300_000),
    pollIntervalMs: envInt('ZHIPU_POLL_INTERVAL_MS', 3_000, 10, 60_000),
    pollTimeoutMs: envInt('ZHIPU_VIDU_TIMEOUT_MS', 180_000, 1_000, 600_000),
  }
}

export const missingKeyMessage = MISSING_KEY_MESSAGE
