/**
 * Offline self-check for the Zhipu multimodal bundle.
 *
 * It never calls the real API and never reads ~/.glm/.env: credentials and
 * fetch are injected. Run with `node test/selfcheck.mjs`.
 */
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { tools } from '../lib/tools.js'
import { __setKeyResolver, getConfig } from '../lib/config.js'
import { __setFetch } from '../lib/http.js'
import { __setBreezeFetch } from '../lib/breeze.js'
import { createViduTask, generateVidu } from '../lib/api.js'
import { renderValue } from '../lib/schema.js'
import { markdownImage } from '../lib/format.js'

process.env.ZHIPU_DISABLE_ENV_FILE = '1'
process.env.ZHIPU_POLL_INTERVAL_MS = '10'
const BREEZE_AUDIO_DIR = path.join(os.tmpdir(), `dsh-breeze-selfcheck-${randomUUID()}`)
process.env.BREEZE_AUDIO_DIR = BREEZE_AUDIO_DIR
process.env.BREEZE_AUTOSTART = '0'

const calls = []
let scenario = null

/** @param {(url: string, init: object) => Promise<Response>} handler */
function mockFetch(handler) {
  scenario = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ url: String(url), method: init?.method ?? 'GET', body, headers: init?.headers })
    return handler(String(url), init, body)
  }
  __setFetch(scenario)
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function binary(bytes, contentType = 'audio/wav') {
  return new Response(bytes, { status: 200, headers: { 'content-type': contentType } })
}

/** A minimal WAV with the 0xFFFFFFFF lengths Breeze streams. */
function breezeWav(pcmLength = 16) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(0xffffffff, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(24_000, 24)
  header.writeUInt32LE(48_000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(0xffffffff, 40)
  return Buffer.concat([header, Buffer.alloc(pcmLength, 0x11)])
}

/** @param {string} name */
function tool(name) {
  const found = tools.find((item) => item.name === name)
  assert.ok(found, `tool ${name} is registered`)
  return found
}

/**
 * Minimal validator for the subset of JSON Schema used by output.schema.
 * @param {unknown} value
 * @param {object} schema
 * @param {string} [at]
 */
function validate(value, schema, at = '$') {
  if (schema.enum) {
    assert.ok(schema.enum.includes(value), `${at}: ${JSON.stringify(value)} is in enum`)
  }
  switch (schema.type) {
    case 'object': {
      assert.equal(typeof value, 'object', `${at}: is object`)
      assert.ok(value !== null && !Array.isArray(value), `${at}: is not array/null`)
      for (const key of schema.required ?? []) {
        assert.ok(Object.hasOwn(value, key), `${at}: required ${key}`)
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          assert.ok(schema.properties?.[key], `${at}: no additional property ${key}`)
        }
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (Object.hasOwn(value, key)) validate(value[key], child, `${at}.${key}`)
      }
      break
    }
    case 'array':
      assert.ok(Array.isArray(value), `${at}: is array`)
      for (const [index, item] of value.entries()) validate(item, schema.items ?? {}, `${at}[${index}]`)
      break
    case 'string':
      assert.equal(typeof value, 'string', `${at}: is string`)
      break
    case 'integer':
      assert.ok(Number.isInteger(value), `${at}: is integer`)
      break
    case 'number':
      assert.equal(typeof value, 'number', `${at}: is number`)
      break
    case 'boolean':
      assert.equal(typeof value, 'boolean', `${at}: is boolean`)
      break
    default:
      break
  }
}

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ✓ ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.error(`  ✗ ${name}\n    ${error instanceof Error ? error.stack : String(error)}`)
  }
}

function assertResult(value) {
  validate(value, tool('generate_image_glm').output.schema)
}

// ---------------------------------------------------------------------------
console.log('1. 注册、schema 与密钥边界')
await check('七个工具注册且 schema 完整', () => {
  const names = tools.map((item) => item.name).sort()
  assert.deepEqual(names, [
    'chat_char',
    'check_zhipu_task',
    'generate_image_glm',
    'generate_image_vidu',
    'generate_video_cogvideo',
    'generate_video_vidu',
    'generate_voice_breeze',
  ])
  for (const item of tools) {
    assert.equal(item.parameters.type, 'object', `${item.name} parameters is object schema`)
    assert.equal(item.parameters.additionalProperties, false, `${item.name} parameters closed`)
    assert.equal(typeof item.output.render, 'function', `${item.name} has render`)
    assert.equal(item.output.schema.type, 'object', `${item.name} output schema is object`)
    assert.ok(item.description.length > 40, `${item.name} has a real description`)
  }
  const image = tool('generate_image_glm')
  assert.ok(image.description.includes('原样放入回复正文'))
  assert.ok(!image.description.includes('反引号包裹图片'), 'guidance tells the model not to wrap in code')
  assert.ok(tool('generate_video_vidu').parameters.required.includes('model'))
  assert.deepEqual(tool('generate_video_cogvideo').parameters.properties.duration.enum, [5, 10])
  assert.equal(tool('generate_video_cogvideo').parameters.properties.with_audio.type, 'boolean')
  assert.ok(tool('generate_video_cogvideo').timeoutMs >= 500_000, 'CogVideoX has budget for long renders')
  assert.ok(tool('chat_char').timeoutMs >= 120_000, 'chat has budget for primary + fallback')
  assert.ok(tool('generate_voice_breeze').timeoutMs >= 240_000, 'Breeze has budget for a cold model load')
})

await check('schema 和描述中不出现 API Key', () => {
  const serialized = JSON.stringify(tools)
  assert.ok(!/sk-[A-Za-z0-9]{10,}/u.test(serialized))
  assert.ok(!serialized.includes('ZHIPU_API_KEY='), 'no credential assignment in schema')
})

await check('缺少 API Key 时返回可读提示且不访问网络', async () => {
  __setKeyResolver(async () => ({ key: undefined, source: 'none', error: '未找到 ZHIPU_API_KEY。' }))
  calls.length = 0
  mockFetch(async () => json({ error: { message: 'should not be called' } }))
  const result = await tool('generate_image_glm').execute({ prompt: '一只猫' })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'image')
  assert.match(result.error, /ZHIPU_API_KEY/u)
  assert.equal(calls.length, 0)
  assertResult(result)
})

// ---------------------------------------------------------------------------
console.log('2. GLM-Image 同步链路与 URL 安全')
__setKeyResolver(async () => ({ key: 'test-key', source: 'test' }))

await check('HTTPS URL 转换为可直接粘贴的 markdown 图片', async () => {
  mockFetch(async () => json({ created: 1, data: [{ url: 'https://example.com/a.png' }] }))
  const result = await tool('generate_image_glm').execute({ prompt: '赛博朋克城市' })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'image')
  assert.equal(result.markdown_image, '![赛博朋克城市](https://example.com/a.png)')
  assert.match(result.note, /30 天/u)
  assertResult(result)
  const rendered = renderValue({}, result)
  assert.equal(rendered.length, 1)
  assert.match(rendered[0].text, /!\[赛博朋克城市\]\(https:\/\/example\.com\/a\.png\)/u)
  assert.doesNotMatch(rendered[0].text, /```/u, 'render does not wrap the image in a code fence')
})

await check('b64_json 转换为 data URL 图片', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
  mockFetch(async () => json({ data: [{ b64_json: png }] }))
  const result = await tool('generate_image_glm').execute({ prompt: '小方块' })
  assert.equal(result.ok, true)
  assert.match(result.markdown_image, /^!\[小方块\]\(data:image\/png;base64,/u)
  assert.equal(result.url, undefined, 'data URL is not duplicated in output.url')
  assertResult(result)
})

await check('HTTP 400 包装为模型可读文本而不是抛出', async () => {
  mockFetch(async () => json({ error: { message: 'prompt is too long' } }, 400))
  const result = await tool('generate_image_glm').execute({ prompt: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.error, /HTTP 400/u)
  assert.match(result.error, /prompt is too long/u)
  assertResult(result)
})

await check('非 HTTPS 图片地址被过滤并给出警告', async () => {
  mockFetch(async () => json({ data: [{ url: 'http://example.com/a.png' }] }))
  const result = await tool('generate_image_glm').execute({ prompt: '不安全的图' })
  assert.equal(result.ok, false)
  assert.match(result.error, /HTTPS/u)
  assert.equal(result.markdown_image, undefined)
  assertResult(result)
})

await check('data URL 中的换行/空白被拒绝', () => {
  const rendered = markdownImage('data:image/png;base64,AAAA\nBBBB')
  assert.equal(rendered.ok, false)
  assert.match(rendered.reason, /data URL/u)
})

await check('超长 prompt 截断到 1000 字符并请求 API', async () => {
  mockFetch(async (_url, _init, body) => {
    assert.equal(body.prompt.length, 1000)
    return json({ data: [{ url: 'https://example.com/long.png' }] })
  })
  const result = await tool('generate_image_glm').execute({ prompt: 'x'.repeat(1200) })
  assert.equal(result.ok, true)
  assert.match(result.warning, /截断/u)
  assert.equal(result.prompt.length, 1000)
  assertResult(result)
})

// ---------------------------------------------------------------------------
console.log('3. Vidu2 异步轮询、超时与失败')
await check('提交 → PROCESSING → SUCCESS 并返回封面 markdown', async () => {
  let polls = 0
  mockFetch(async (url) => {
    if (url.endsWith('/videos/generations')) {
      return json({ id: 'task-ok', task_status: 'PROCESSING' })
    }
    polls += 1
    if (polls === 1) return json({ task_status: 'PROCESSING' })
    return json({
      task_status: 'SUCCESS',
      video_result: [{ url: 'https://example.com/v.mp4', cover_image_url: 'https://example.com/cover.jpg' }],
    })
  })
  const result = await tool('generate_image_vidu').execute({
    prompt: '镜头缓慢推进',
    images: ['https://example.com/ref.png'],
    timeout_seconds: 5,
  })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'video')
  assert.equal(result.task_id, 'task-ok')
  assert.equal(result.video_url, 'https://example.com/v.mp4')
  assert.match(result.markdown_image, /!\[镜头缓慢推进（封面）\]\(https:\/\/example\.com\/cover\.jpg\)/u)
  assert.ok(polls >= 2, 'polled until success')
  assertResult(result)
})

await check('FAIL 状态返回明确错误与 task_id', async () => {
  mockFetch(async (url) => {
    if (url.endsWith('/videos/generations')) return json({ id: 'task-fail', task_status: 'PROCESSING' })
    return json({ task_status: 'FAIL', error: { message: 'reference image rejected' } })
  })
  const result = await tool('generate_image_vidu').execute({
    prompt: '测试失败',
    images: ['https://example.com/ref.png'],
    timeout_seconds: 5,
  })
  assert.equal(result.ok, false)
  assert.equal(result.task_id, 'task-fail')
  assert.match(result.error, /reference image rejected/u)
  assertResult(result)
})

await check('轮询超时抛出带 task_id 的 ZhipuTimeoutError', async () => {
  mockFetch(async (url) => {
    if (url.endsWith('/videos/generations')) return json({ id: 'task-timeout', task_status: 'PROCESSING' })
    return json({ task_status: 'PROCESSING' })
  })
  const cfg = await getConfig()
  await assert.rejects(
    generateVidu(
      { model: 'vidu2-image', prompt: 'x', images: ['https://example.com/a.png'], size: '1280x720' },
      cfg,
      { timeoutMs: 60 },
    ),
    (error) => error.name === 'ZhipuTimeoutError' && error.taskId === 'task-timeout',
  )
})

await check('wait=false 立即返回 task_id 而不轮询', async () => {
  mockFetch(async () => json({ id: 'task-later', task_status: 'PROCESSING' }))
  const result = await tool('generate_image_vidu').execute({
    prompt: '稍后',
    images: ['https://example.com/a.png'],
    wait: false,
  })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'task')
  assert.equal(result.task_id, 'task-later')
  assert.equal(result.status, 'PROCESSING')
  assertResult(result)
})

await check('Vidu 超长 prompt 截断到 512 并写入 warning', async () => {
  calls.length = 0
  mockFetch(async () => json({ id: 'task-long', task_status: 'PROCESSING' }))
  const result = await tool('generate_image_vidu').execute({
    prompt: '动'.repeat(600),
    images: ['https://example.com/a.png'],
    wait: false,
  })
  assert.equal(result.ok, true)
  assert.match(result.warning, /512/u)
  assert.equal(Array.from(calls[0].body.prompt).length, 512)
  assertResult(result)
})

await check('没有参考图时拒绝提交，不伪造文生图', async () => {
  calls.length = 0
  mockFetch(async () => json({}))
  const result = await tool('generate_image_vidu').execute({ prompt: '无图' })
  assert.equal(result.ok, false)
  assert.match(result.error, /图生视频/u)
  assert.equal(calls.length, 0)
  assertResult(result)
})

await check('本地路径/HTTP 参考图在本地被拒绝', async () => {
  calls.length = 0
  mockFetch(async () => json({}))
  const result = await tool('generate_image_vidu').execute({
    prompt: '本地图',
    images: ['C:\\tmp\\ref.png'],
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /HTTPS URL/u)
  assert.equal(calls.length, 0)
  assertResult(result)
})

await check('Vidu 空 images 直接调用返回可读错误而不是 TypeError', async () => {
  const cfg = await getConfig()
  await assert.rejects(
    createViduTask({ model: 'vidu2-image', prompt: 'x', images: [] }, cfg),
    /恰好 1 张/u,
  )
})

await check('480x360 仅允许 vidu2-start-end', async () => {
  calls.length = 0
  mockFetch(async () => json({}))
  const result = await tool('generate_image_vidu').execute({
    prompt: '小尺寸',
    images: ['https://example.com/ref.png'],
    size: '480x360',
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /480x360/u)
  assert.equal(calls.length, 0)
  assertResult(result)
})

await check('CANCELED 状态按失败处理', async () => {
  mockFetch(async (url) => {
    if (url.endsWith('/videos/generations')) return json({ id: 'task-cancel', task_status: 'PROCESSING' })
    return json({ task_status: 'CANCELED' })
  })
  const cfg = await getConfig()
  await assert.rejects(
    generateVidu(
      { model: 'vidu2-image', prompt: 'x', images: ['https://example.com/a.png'], size: '1280x720' },
      cfg,
      { timeoutMs: 500 },
    ),
    /CANCELED/u,
  )
})

// ---------------------------------------------------------------------------
console.log('4. CogVideoX-3 文生视频/图生视频/首尾帧')

await check('CogVideoX-3 文生视频轮询成功并返回封面 markdown', async () => {
  calls.length = 0
  let polls = 0
  mockFetch(async (url) => {
    if (url.endsWith('/videos/generations')) {
      return json({ id: 'cog-ok', task_status: 'PROCESSING' })
    }
    polls += 1
    if (polls === 1) return json({ task_status: 'PROCESSING' })
    return json({
      task_status: 'SUCCESS',
      video_result: [{ url: 'https://example.com/cog.mp4', cover_image_url: 'https://example.com/cog.jpg' }],
    })
  })
  const result = await tool('generate_video_cogvideo').execute({
    prompt: '一只橘猫在月球上跳跃',
    size: '1280x720',
    fps: 30,
    duration: 5,
    timeout_seconds: 5,
  })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'video')
  assert.equal(result.task_id, 'cog-ok')
  assert.equal(result.video_url, 'https://example.com/cog.mp4')
  assert.equal(result.markdown_image, '![一只橘猫在月球上跳跃（封面）](https://example.com/cog.jpg)')
  assert.equal(calls[0].body.model, 'cogvideox-3')
  assert.equal(calls[0].body.image_url, undefined)
  assert.equal(calls[0].body.with_audio, false)
  assert.equal(calls[0].body.duration, 5)
  assert.ok(polls >= 2, 'polled until success')
  assertResult(result)
})

await check('CogVideoX-3 单图生视频把 image_url 作为字符串提交', async () => {
  calls.length = 0
  mockFetch(async () => json({ id: 'cog-one', task_status: 'PROCESSING' }))
  const result = await tool('generate_video_cogvideo').execute({
    prompt: '镜头缓慢推进',
    images: ['https://example.com/first.png'],
    wait: false,
  })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'task')
  assert.equal(result.task_id, 'cog-one')
  assert.equal(calls[0].body.image_url, 'https://example.com/first.png')
  assertResult(result)
})

await check('CogVideoX-3 首尾帧把 image_url 作为 2 张数组提交', async () => {
  calls.length = 0
  mockFetch(async () => json({ id: 'cog-two', task_status: 'PROCESSING' }))
  const result = await tool('generate_video_cogvideo').execute({
    prompt: '从白天过渡到夜晚',
    images: ['https://example.com/first.png', 'https://example.com/last.png'],
    wait: false,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls[0].body.image_url, [
    'https://example.com/first.png',
    'https://example.com/last.png',
  ])
  assertResult(result)
})

await check('CogVideoX-3 prompt 与 images 都为空时拒绝且不发请求', async () => {
  calls.length = 0
  mockFetch(async () => json({}))
  const result = await tool('generate_video_cogvideo').execute({})
  assert.equal(result.ok, false)
  assert.match(result.error, /prompt 或 images/u)
  assert.equal(calls.length, 0)
  assertResult(result)
})

await check('CogVideoX-3 超长 prompt 截断到 512 并写 warning', async () => {
  calls.length = 0
  mockFetch(async () => json({ id: 'cog-long', task_status: 'PROCESSING' }))
  const result = await tool('generate_video_cogvideo').execute({
    prompt: '动'.repeat(600),
    images: ['https://example.com/first.png'],
    wait: false,
  })
  assert.equal(result.ok, true)
  assert.match(result.warning, /512/u)
  assert.equal(Array.from(calls[0].body.prompt).length, 512)
  assertResult(result)
})

await check('CogVideoX-3 非法 duration 在本地拒绝', async () => {
  calls.length = 0
  mockFetch(async () => json({}))
  const result = await tool('generate_video_cogvideo').execute({
    prompt: '测试',
    duration: 7,
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /5 或 10/u)
  assert.equal(calls.length, 0)
  assertResult(result)
})

await check('CogVideoX-3 FAIL 返回明确错误与 task_id', async () => {
  mockFetch(async (url) => {
    if (url.endsWith('/videos/generations')) return json({ id: 'cog-fail', task_status: 'PROCESSING' })
    return json({ task_status: 'FAIL', error: { message: 'content policy rejected' } })
  })
  const result = await tool('generate_video_cogvideo').execute({
    prompt: '测试失败',
    timeout_seconds: 5,
  })
  assert.equal(result.ok, false)
  assert.equal(result.task_id, 'cog-fail')
  assert.match(result.error, /content policy rejected/u)
  assertResult(result)
})

await check('CogVideoX-3 本地路径图片被拒绝且不发请求', async () => {
  calls.length = 0
  mockFetch(async () => json({}))
  const result = await tool('generate_video_cogvideo').execute({
    prompt: '本地图',
    images: ['C:\\\\tmp\\\\first.png'],
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /HTTPS URL/u)
  assert.equal(calls.length, 0)
  assertResult(result)
})

await check('check_zhipu_task 可复用 CogVideoX 视频结果', async () => {
  mockFetch(async () => json({
    task_status: 'SUCCESS',
    video_result: [{ url: 'https://example.com/check.mp4', cover_image_url: 'https://example.com/check.jpg' }],
  }))
  const result = await tool('check_zhipu_task').execute({ task_id: 'cog-check' })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'video')
  assert.equal(result.video_url, 'https://example.com/check.mp4')
  assert.ok(result.markdown_image.includes('check.jpg'))
  assertResult(result)
})

// ---------------------------------------------------------------------------
console.log('5. check_zhipu_task 与结果复用')
await check('查询 PROCESSING 返回状态', async () => {
  mockFetch(async () => json({ task_status: 'PROCESSING' }))
  const result = await tool('check_zhipu_task').execute({ task_id: 'task-p' })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'task')
  assert.equal(result.status, 'PROCESSING')
  assertResult(result)
})

await check('查询 SUCCESS 提取图片 markdown', async () => {
  mockFetch(async () => json({
    task_status: 'SUCCESS',
    image_result: [{ url: 'https://example.com/async.png' }],
  }))
  const result = await tool('check_zhipu_task').execute({ task_id: 'task-img' })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'image')
  assert.equal(result.markdown_image, '![生成图片](https://example.com/async.png)')
  assertResult(result)
})

// ---------------------------------------------------------------------------
console.log('6. CharGLM-4 与降级')
await check('CharGLM-4 正常文本回复', async () => {
  calls.length = 0
  mockFetch(async () => json({ choices: [{ message: { content: '我一直在等你。' } }] }))
  const result = await tool('chat_char').execute({ prompt: '你好', system_role: '冷静的侦探' })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'text')
  assert.equal(result.text, '我一直在等你。')
  assert.equal(result.model, 'charglm-4')
  assert.equal(result.degraded, false)
  assert.equal(calls[0].body.meta.bot_info, '冷静的侦探')
  assertResult(result)
})

await check('CharGLM-4 404 时降级到 GLM-4-Flash 并标注', async () => {
  calls.length = 0
  mockFetch(async (_url, _init, body) => {
    if (body.model === 'charglm-4') return json({ error: { message: 'model not found' } }, 404)
    return json({ choices: [{ message: { content: '降级后的回答。' } }] })
  })
  const result = await tool('chat_char').execute({ prompt: '在吗', system_role: '温柔的朋友' })
  assert.equal(result.ok, true)
  assert.equal(result.degraded, true)
  assert.equal(result.model, 'glm-4-flash')
  assert.match(result.warning, /降级/u)
  assert.equal(calls.length, 2)
  assert.ok(calls[1].body.messages.some((message) => message.role === 'system'))
  assertResult(result)
})

await check('401 不降级，直接返回鉴权错误', async () => {
  calls.length = 0
  mockFetch(async () => json({ error: { message: 'invalid api key' } }, 401))
  const result = await tool('chat_char').execute({ prompt: '你好' })
  assert.equal(result.ok, false)
  assert.match(result.error, /401/u)
  assert.equal(calls.length, 1)
  assertResult(result)
})

await check('400 的鉴权错误不触发降级', async () => {
  calls.length = 0
  mockFetch(async () => json({ error: { message: 'invalid api key' } }, 400))
  const result = await tool('chat_char').execute({ prompt: '你好' })
  assert.equal(result.ok, false)
  assert.match(result.error, /api key/u)
  assert.equal(calls.length, 1)
  assertResult(result)
})

await check('history 按顺序传入多轮对话', async () => {
  calls.length = 0
  mockFetch(async () => json({ choices: [{ message: { content: '记得。' } }] }))
  const result = await tool('chat_char').execute({
    prompt: '还记得吗？',
    history: [
      { role: 'user', content: '我叫阿远。' },
      { role: 'assistant', content: '你好，阿远。' },
    ],
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls[0].body.messages.map((message) => message.role), ['user', 'assistant', 'user'])
  assert.equal(calls[0].body.messages[2].content, '还记得吗？')
  assertResult(result)
})

// ---------------------------------------------------------------------------
console.log('7. Breeze 本地语音')

await check('Breeze 合成成功并把流式 WAV 长度修正后保存', async () => {
  const breezeCalls = []
  __setBreezeFetch(async (url, init) => {
    breezeCalls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : undefined })
    if (String(url).endsWith('/health')) return json({ status: 'ok', sample_rate: 24000 })
    if (String(url).endsWith('/v1/audio/speech')) return binary(breezeWav(32))
    return json({ error: 'unexpected' }, 500)
  })
  const result = await tool('generate_voice_breeze').execute({
    prompt: '你好，我是 Breeze。',
    instruction: '温柔、清晰',
    seed: 7,
  })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'voice')
  assert.equal(result.engine, 'breeze-tts-2')
  assert.match(result.markdown_audio, /^\[播放\/下载语音\]\(\/zhipu\/breeze\/audio\/breeze-.*\.wav\)$/u)
  const speech = breezeCalls.find((item) => item.url.endsWith('/v1/audio/speech'))
  assert.ok(speech, 'speech endpoint was called')
  assert.equal(speech.init.headers['content-type'], 'application/json')
  assert.equal(speech.body.response_format, 'wav')
  assert.equal(speech.body.input, '你好，我是 Breeze。')
  const bytes = await readFile(result.audio_path)
  assert.equal(bytes.length, 44 + 32)
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8)
  assert.equal(bytes.readUInt32LE(40), 32)
  assertResult(result)
})

await check('Breeze 超长文本截断到 4000 字符并写 warning', async () => {
  const breezeCalls = []
  __setBreezeFetch(async (url, init) => {
    breezeCalls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : undefined })
    if (String(url).endsWith('/health')) return json({ status: 'ok', sample_rate: 24000 })
    return binary(breezeWav(8))
  })
  const result = await tool('generate_voice_breeze').execute({ prompt: '读'.repeat(4_100) })
  assert.equal(result.ok, true)
  assert.equal(Array.from(result.prompt).length, 4_000)
  assert.match(result.warning, /截断/u)
  const speech = breezeCalls.find((item) => item.url.endsWith('/v1/audio/speech'))
  assert.equal(Array.from(speech.body.input).length, 4_000)
  assertResult(result)
})

await check('Breeze 离线且禁用自动启动时返回可读错误', async () => {
  __setBreezeFetch(async () => json({ error: 'down' }, 503))
  const result = await tool('generate_voice_breeze').execute({ prompt: '离线测试' })
  assert.equal(result.ok, false)
  assert.match(result.error, /Breeze 本地服务未启动/u)
  assert.match(result.note, /start-breeze-server\.cmd/u)
  assertResult(result)
})

// ---------------------------------------------------------------------------
console.log('8. 并发/多模型共存与统计')
await check('先后调用 GLM-Image 与 CharGLM-4 不污染 schema', async () => {
  mockFetch(async (url) => {
    if (url.endsWith('/images/generations')) return json({ data: [{ url: 'https://example.com/one.png' }] })
    return json({ choices: [{ message: { content: '文本回复' } }] })
  })
  const image = await tool('generate_image_glm').execute({ prompt: '第一张' })
  const text = await tool('chat_char').execute({ prompt: '第二段' })
  assert.equal(image.kind, 'image')
  assert.equal(text.kind, 'text')
  assert.equal(tool('generate_image_glm').output.schema.properties.kind.enum.includes('image'), true)
  assertResult(image)
  assertResult(text)
})

await rm(BREEZE_AUDIO_DIR, { recursive: true, force: true })
const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.error('FAILED:')
  for (const item of failed) console.error(`- ${item.name}`)
  process.exitCode = 1
}
