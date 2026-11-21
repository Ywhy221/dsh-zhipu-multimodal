/**
 * Same-origin host routes for the Breeze sidebar.
 *
 * `/status`  — is the local server up? (no auto-start)
 * `/start`   — explicit "start it" button (auto-start + wait)
 * `/speech`  — POST JSON, returns a normalised WAV body
 * `/audio/*` — serves only the bridge's own saved WAVs
 *
 * Registering these on the Host avoids Breeze's CORS rules and keeps the
 * browser from talking to a second origin.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  BreezeError,
  breezeAudioPath,
  breezeConfig,
  breezeStatus,
  ensureBreeze,
  normalizeWav,
  requestBreezeSpeech,
} from './breeze.js'

const PREFIX = '/zhipu/breeze'
const MAX_BODY_BYTES = 512 * 1024

/** @param {import('node:http').IncomingMessage} req */
function originAllowed(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} value */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** @param {import('node:http').IncomingMessage} req */
async function readJson(req) {
  let total = 0
  const chunks = []
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new BreezeError('请求体过大（上限 512 KiB）。', { status: 413, code: 'breeze-body-too-large' })
    chunks.push(chunk)
  }
  if (total === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BreezeError('请求体不是合法 JSON。', { status: 400, code: 'breeze-bad-json' })
  }
}

/** @param {unknown} error */
function statusOf(error) {
  return error instanceof BreezeError && Number.isInteger(error.status) ? error.status : 503
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export function createBreezeHandler() {
  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  return async function breezeHandler(req, res) {
    if (!originAllowed(req)) {
      sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.slice(PREFIX.length) || '/'

    if (route === '/status' && req.method === 'GET') {
      try {
        const status = await breezeStatus()
        sendJson(res, 200, { ok: true, ...status, speech_path: `${PREFIX}/speech` })
      } catch (error) {
        sendJson(res, 503, { ok: false, error: messageOf(error) })
      }
      return
    }

    if (route === '/start' && req.method === 'POST') {
      try {
        const status = await ensureBreeze(breezeConfig())
        sendJson(res, 200, { ok: true, running: true, baseUrl: status.baseUrl })
      } catch (error) {
        sendJson(res, statusOf(error), { ok: false, error: messageOf(error) })
      }
      return
    }

    if (route === '/speech' && req.method === 'POST') {
      try {
        const payload = await readJson(req)
        const result = await requestBreezeSpeech({
          text: typeof payload.text === 'string' ? payload.text : '',
          instruction: typeof payload.instruction === 'string' ? payload.instruction : undefined,
          voice: typeof payload.voice === 'string' ? payload.voice : undefined,
          seed: Number.isFinite(Number(payload.seed)) ? Number(payload.seed) : undefined,
          cfgScale: Number.isFinite(Number(payload.cfg_scale)) ? Number(payload.cfg_scale) : undefined,
        })
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': result.bytes.length,
          'cache-control': 'no-store',
          'x-breeze-sample-rate': String(result.sampleRate),
        })
        res.end(result.bytes)
      } catch (error) {
        sendJson(res, statusOf(error), { ok: false, error: messageOf(error) })
      }
      return
    }

    if (route.startsWith('/audio/') && req.method === 'GET') {
      const name = decodeURIComponent(route.slice('/audio/'.length))
      if (name === '' || path.basename(name) !== name || !name.endsWith('.wav')) {
        sendJson(res, 400, { ok: false, error: 'invalid audio name' })
        return
      }
      try {
        const cfg = breezeConfig()
        const filePath = path.join(cfg.audioDir, name)
        const bytes = await readFile(filePath)
        const wav = normalizeWav(bytes)
        if (wav === null) {
          sendJson(res, 500, { ok: false, error: 'stored file is not a WAV' })
          return
        }
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': wav.length,
          'cache-control': 'private, max-age=3600',
          'content-disposition': `inline; filename="${name}"`,
        })
        res.end(wav)
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        sendJson(res, code === 'ENOENT' ? 404 : 500, { ok: false, error: 'audio not found' })
      }
      return
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': req.headers.origin ?? '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      })
      res.end()
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found', path: `${PREFIX}${route}` })
  }
}

export { PREFIX as BREEZE_ROUTE_PREFIX, breezeAudioPath }
