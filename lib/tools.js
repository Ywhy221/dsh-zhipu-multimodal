import { defineTool, OUTPUT_SCHEMA, renderValue, resultFail, resultOk } from './schema.js'
import { getConfig, missingKeyMessage } from './config.js'
import { elapsedMs, makeAlt, truncateText, validateGlmSize, validateViduSize } from './format.js'
import { ZhipuError, ZhipuTimeoutError } from './http.js'
import { BreezeError, breezeAudioPath, breezeConfig, requestBreezeSpeech, saveBreezeAudio } from './breeze.js'
import {
  COGVIDEO_MODEL,
  GLM_IMAGE_MODEL,
  VIDU_MODELS,
  chatChar,
  checkZhipuTask,
  generateCogVideo,
  generateGlmImage,
  generateVidu,
} from './api.js'

const IMAGE_GUIDANCE = [
  '工具已经把 API 返回的图片 URL / base64 转成可直接渲染的 Markdown 图片行，放在 output.markdown_image 中。',
  '请把 markdown_image 的值原样放入回复正文（单独一行），不要放进代码块，不要加反引号、不要转义、不要改写 URL；这样图片才会随文显示。',
  '工具结果 cards 本身不会渲染 Markdown，只有助手回复正文会。',
].join('')

const VIDEO_GUIDANCE = [
  'Vidu2 是异步图生视频接口，不是文生图接口；调用会提交任务并轮询，或者用 wait=false 立即返回 task_id。',
  '成功时 output.markdown_image 是视频封面的 Markdown 图片行，请原样放入回复正文；output.video_url 是视频链接，请同时以普通链接展示。',
].join('')

/** @param {string} kind @param {string} model @param {string} message @param {object} [fields] */
function fail(kind, model, message, fields = {}) {
  return resultFail(kind, model, message, fields)
}

/** @param {object} cfg @param {string} kind @param {string} model */
function missingKey(cfg, kind, model) {
  return fail(kind, model, cfg.apiKeyError || missingKeyMessage, {
    note: '密钥缺失是配置问题，不是网络问题；设置后无需重启 Host，下一次调用会重新读取环境变量。',
  })
}

/** @param {unknown} value @param {string} fallback @param {number} max @param {string} label */
function promptOf(value, fallback, max, label = 'prompt') {
  const source = typeof value === 'string' && value.trim() !== '' ? value : fallback
  return truncateText(source, max, label)
}

/** @param {unknown} value @returns {string} */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Shared implementation for the two Vidu tools. The official Vidu2 models are
 * image-to-video; a text-only request is rejected by the API, so the tools say
 * so instead of pretending to be text-to-image.
 * @param {'generate_image_vidu'|'generate_video_vidu'} toolName
 * @param {object} args
 * @param {object} cfg
 */
async function runVidu(toolName, args, cfg) {
  const started = Date.now()
  const modelName = toolName === 'generate_image_vidu' ? VIDU_MODELS.image : textOf(args.model) || VIDU_MODELS.image
  if (!Object.values(VIDU_MODELS).includes(modelName)) {
    return fail('video', modelName || 'unknown', `不支持的 Vidu2 模型 "${modelName}"。可选：vidu2-image、vidu2-reference、vidu2-start-end。`)
  }
  const model = modelName
  const truncated = promptOf(args.prompt, '一段简短的视频', 512, 'Vidu prompt')
  if (!truncated.text) return fail('video', model, 'prompt 不能为空。')

  const images = Array.isArray(args.images)
    ? args.images.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : []
  if (images.length === 0) {
    return fail('video', model, 'Vidu2 是图生视频接口，必须提供 images（1-3 张 HTTPS 图片 URL 或 data URL）。纯文生图请调用 generate_image_glm。', {
      prompt: truncated.text,
      note: '官方 vidu2-image 的 image_url 为必填；本插件不伪造文生视频能力。',
    })
  }
  const size = validateViduSize(args.size)
  if (!size.ok) return fail('video', model, size.error, { prompt: truncated.text })

  const wait = args.wait !== false
  const requestedSeconds = Number.isFinite(Number(args.timeout_seconds)) ? Number(args.timeout_seconds) : 120
  const timeoutMs = Math.min(180_000, Math.max(5_000, requestedSeconds * 1000))
  const prompt = truncated.text
  const warning = truncated.note || undefined

  try {
    const result = await generateVidu(
      {
        model,
        prompt,
        images,
        size: size.size,
        duration: args.duration ?? 4,
        movementAmplitude: textOf(args.movement_amplitude) || 'auto',
        withAudio: args.with_audio !== false,
        aspectRatio: textOf(args.aspect_ratio) || undefined,
      },
      cfg,
      { wait, timeoutMs },
    )

    if (result.status !== 'SUCCESS') {
      return resultOk('task', model, {
        task_id: result.taskId,
        status: result.status,
        prompt,
        text: `Vidu2 任务已提交，任务 ID：${result.taskId}`,
        note: result.note || '稍后调用 check_zhipu_task 查询结果。',
        warning,
        elapsed_ms: elapsedMs(started),
      })
    }

    return resultOk('video', model, {
      task_id: result.taskId,
      status: 'SUCCESS',
      prompt,
      video_url: result.videoUrl,
      cover_url: result.coverUrl,
      url: result.coverUrl,
      markdown_image: result.markdown,
      alt: result.alt,
      text: `Vidu2 视频已生成${result.coverUrl ? '，封面见上方图片' : ''}。视频链接有效期约 1 天，请及时转存。`,
      warning: [warning, result.warning].filter(Boolean).join(' ') || undefined,
      note: '视频无法直接嵌入 DSH 对话，请以链接形式提供；封面图请把 markdown_image 原样放入回复正文。',
      elapsed_ms: elapsedMs(started),
    })
  } catch (error) {
    if (error instanceof ZhipuTimeoutError) {
      return fail('task', model, error.message, {
        task_id: error.taskId,
        status: 'PROCESSING',
        prompt,
        note: '任务没有被取消，仍在服务端处理。请稍后调用 check_zhipu_task，传入同一个 task_id。',
        warning,
        elapsed_ms: elapsedMs(started),
      })
    }
    return fail(wait ? 'video' : 'task', model, error instanceof Error ? error.message : String(error), {
      task_id: error instanceof ZhipuError ? error.taskId || undefined : undefined,
      prompt,
      warning,
      elapsed_ms: elapsedMs(started),
    })
  }
}

export const tools = [
  defineTool({
    name: 'generate_image_glm',
    description: [
      '用 GLM-Image（glm-image）根据文字生成一张图片。同步接口，通常几十秒内返回。',
      IMAGE_GUIDANCE,
      'prompt 最多 1000 字符，超出会被工具截断并在 warning 中说明；size 可用 1280x1280、1568x1056、1056x1568、1472x1088、1088x1472、1728x960、960x1728，或 512-2048 之间且为 32 倍数的自定义宽高。',
    ].join('\n'),
    parameters: {
      prompt: { type: 'string', required: true, description: '图片描述，最多 1000 字符。' },
      size: { type: 'string', description: '图片尺寸，默认 1280x1280。' },
      quality: { type: 'string', enum: ['hd'], description: '可选 hd 高质量模式。' },
      watermark: { type: 'boolean', description: '是否添加水印，默认由服务端决定。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    timeoutMs: 90_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const started = Date.now()
      const cfg = await getConfig()
      if (!cfg.apiKey) return missingKey(cfg, 'image', GLM_IMAGE_MODEL)
      const truncated = promptOf(args.prompt, '', 1000)
      if (!truncated.text) return fail('image', GLM_IMAGE_MODEL, 'prompt 不能为空。')
      const size = validateGlmSize(args.size)
      if (!size.ok) return fail('image', GLM_IMAGE_MODEL, size.error, { prompt: truncated.text })
      try {
        const result = await generateGlmImage(
          { prompt: truncated.text, size: size.size, quality: args.quality, watermark: args.watermark },
          cfg,
        )
        return resultOk('image', GLM_IMAGE_MODEL, {
          prompt: truncated.text,
          markdown_image: result.markdown,
          url: result.url,
          alt: result.alt,
          warning: [truncated.note, result.warning].filter(Boolean).join(' ') || undefined,
          note: result.note,
          elapsed_ms: elapsedMs(started),
        })
      } catch (error) {
        return fail('image', GLM_IMAGE_MODEL, error instanceof Error ? error.message : String(error), {
          prompt: truncated.text,
          warning: truncated.note || undefined,
          elapsed_ms: elapsedMs(started),
        })
      }
    },
  }),

  defineTool({
    name: 'generate_image_vidu',
    description: [
      '用 Vidu2（vidu2-image）从一张参考图生成一段短视频。异步接口：提交任务后默认在工具内轮询到 SUCCESS/FAIL，最长约 3 分钟；wait=false 可立即返回 task_id。',
      VIDEO_GUIDANCE,
      '重要：Vidu2 官方模型是图生视频，不是文生图；images 必须提供 1 张 HTTPS 图片 URL 或 data URL。若用户只要静态图片，请改用 generate_image_glm。',
    ].join('\n'),
    parameters: {
      prompt: { type: 'string', required: true, description: '视频动作/镜头描述，最多 512 字符。' },
      images: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 1,
        required: true,
        description: '1 张参考图的 HTTPS URL 或 data URL；vidu2-image 必须且只能 1 张。',
      },
      size: { type: 'string', enum: ['1280x720', '480x360'], description: '视频尺寸，默认 1280x720。' },
      duration: { type: 'integer', enum: [4], description: '时长，Vidu2 当前为 4 秒。' },
      movement_amplitude: { type: 'string', enum: ['auto', 'small', 'medium', 'large'], description: '运动幅度。' },
      with_audio: { type: 'boolean', description: '是否生成音频，默认 true。' },
      wait: { type: 'boolean', description: '是否在工具内等待完成，默认 true；false 时返回 task_id。' },
      timeout_seconds: { type: 'integer', minimum: 5, maximum: 180, description: '等待上限秒数，默认 120。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    timeoutMs: 240_000,
    async execute(args) {
      const cfg = await getConfig()
      if (!cfg.apiKey) return missingKey(cfg, 'video', VIDU_MODELS.image)
      return runVidu('generate_image_vidu', args, cfg)
    },
  }),

  defineTool({
    name: 'generate_video_vidu',
    description: [
      '用 Vidu2 做图生视频：支持 vidu2-image（单图）、vidu2-reference（1-3 张参考图）和 vidu2-start-end（首尾帧 1-2 张）。异步接口，默认轮询到 SUCCESS/FAIL，wait=false 立即返回 task_id。',
      VIDEO_GUIDANCE,
      'images 必须是 HTTPS 图片 URL 或 data URL，不支持本地文件路径。纯文字生成静态图片请用 generate_image_glm。',
    ].join('\n'),
    parameters: {
      model: {
        type: 'string',
        required: true,
        enum: ['vidu2-image', 'vidu2-reference', 'vidu2-start-end'],
        description: 'Vidu2 模型：单图生视频 / 参考图生视频 / 首尾帧生视频。',
      },
      prompt: { type: 'string', required: true, description: '视频动作/镜头描述，最多 512 字符。' },
      images: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 3,
        required: true,
        description: '1-3 张 HTTPS 图片 URL 或 data URL；vidu2-image 只能 1 张，reference 最多 3 张，start-end 最多 2 张。',
      },
      aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1'], description: '仅 vidu2-reference 使用。' },
      size: { type: 'string', enum: ['1280x720', '480x360'], description: '视频尺寸，默认 1280x720。' },
      duration: { type: 'integer', enum: [4], description: '时长，Vidu2 当前为 4 秒。' },
      movement_amplitude: { type: 'string', enum: ['auto', 'small', 'medium', 'large'], description: '运动幅度。' },
      with_audio: { type: 'boolean', description: '是否生成音频，默认 true。' },
      wait: { type: 'boolean', description: '是否在工具内等待完成，默认 true；false 时返回 task_id。' },
      timeout_seconds: { type: 'integer', minimum: 5, maximum: 180, description: '等待上限秒数，默认 120。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    timeoutMs: 240_000,
    async execute(args) {
      const cfg = await getConfig()
      if (!cfg.apiKey) return missingKey(cfg, 'video', textOf(args.model) || VIDU_MODELS.image)
      return runVidu('generate_video_vidu', args, cfg)
    },
  }),

  defineTool({
    name: 'chat_char',
    description: [
      '与 CharGLM-4 角色模型进行人设对话，纯文本输出。system_role 描述角色人设，user_info/bot_info 作为 CharacterGLM 的 meta 信息。',
      '可用 history 传入之前的 user/assistant 轮次来维持多轮对话；不要用它生成图片或语音，它不会返回 markdown 媒体。',
      '若 CharGLM-4 当前账号不可用，工具会自动降级到 GLM-4-Flash，并在 output.degraded=true 和 warning 中明确标注；不是静默替换。',
    ].join('\n'),
    parameters: {
      prompt: { type: 'string', required: true, description: '用户这一轮说的话，最多 4000 字符。' },
      system_role: { type: 'string', description: '角色设定，例如“你是冷静的侦探林默，说话简短”。' },
      user_info: { type: 'string', description: '用户身份/背景，写入 CharGLM meta.user_info。' },
      bot_info: { type: 'string', description: '角色身份/背景，写入 CharGLM meta.bot_info；不填则用 system_role。' },
      history: {
        type: 'array',
        maxItems: 20,
        description: '之前的对话轮次，按时间顺序；用于多轮角色对话。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            role: { type: 'string', enum: ['user', 'assistant'] },
            content: { type: 'string' },
          },
          required: ['role', 'content'],
        },
      },
      temperature: { type: 'number', minimum: 0, maximum: 1, description: '采样温度，默认由服务端决定。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    timeoutMs: 150_000,
    async execute(args) {
      const started = Date.now()
      const cfg = await getConfig()
      if (!cfg.apiKey) return missingKey(cfg, 'text', cfg.charModel)
      const truncated = promptOf(args.prompt, '', 4000)
      if (!truncated.text) return fail('text', cfg.charModel, 'prompt 不能为空。')
      const systemTruncated = truncateText(textOf(args.system_role), 2000, 'system_role')
      const userTruncated = truncateText(textOf(args.user_info), 1000, 'user_info')
      const botTruncated = truncateText(textOf(args.bot_info), 2000, 'bot_info')
      const history = []
      let historyTruncated = false
      if (Array.isArray(args.history)) {
        for (const entry of args.history.slice(0, 20)) {
          const role = entry?.role === 'assistant' ? 'assistant' : entry?.role === 'user' ? 'user' : ''
          const content = truncateText(textOf(entry?.content), 2000, 'history content')
          if (!role || !content.text) continue
          if (content.note) historyTruncated = true
          history.push({ role, content: content.text })
        }
      }
      try {
        const result = await chatChar(
          {
            prompt: truncated.text,
            systemRole: systemTruncated.text,
            userInfo: userTruncated.text,
            botInfo: botTruncated.text,
            history,
            temperature: typeof args.temperature === 'number' ? args.temperature : undefined,
          },
          cfg,
        )
        return resultOk('text', result.model, {
          prompt: truncated.text,
          text: result.text,
          degraded: result.degraded,
          warning: [
            truncated.note,
            systemTruncated.note,
            userTruncated.note,
            botTruncated.note,
            historyTruncated ? '部分 history 内容超过 2000 字符，已截断。' : '',
            result.warning,
          ]
            .filter(Boolean)
            .join(' ') || undefined,
          note: result.degraded ? '本次回答由降级模型生成，人设由 system message 承载。' : undefined,
          elapsed_ms: elapsedMs(started),
        })
      } catch (error) {
        return fail('text', cfg.charModel, error instanceof Error ? error.message : String(error), {
          prompt: truncated.text,
          elapsed_ms: elapsedMs(started),
        })
      }
    },
  }),

  defineTool({
    name: 'generate_video_cogvideo',
    description: [
      '用智谱 CogVideoX-3（cogvideox-3）生成 5 秒或 10 秒视频：支持纯文本、单图生视频、首尾帧（2 张图）。异步接口，默认在工具内轮询到 SUCCESS/FAIL，最长约 10 分钟；wait=false 会立即返回 task_id，之后用 check_zhipu_task 查询。',
      'CogVideoX-3 是视频生成，不是图片生成。成功时 output.markdown_image 是视频封面的 Markdown 图片行，请原样放入回复正文；output.video_url 是视频链接，请同时以普通链接展示。视频 URL 是临时链接，约 1 天有效。',
      'prompt 最多 512 字符；prompt 与 images 至少提供一项。images 可为 1 张首帧，或恰好 2 张首尾帧，必须是 HTTPS 图片 URL 或 data URL，不支持本地路径。纯文字生成静态图片请用 generate_image_glm。',
    ].join('\\n'),
    parameters: {
      prompt: { type: 'string', description: '视频动作/镜头描述，最多 512 字符；与 images 至少提供一项。' },
      images: {
        type: 'array',
        items: { type: 'string' },
        minItems: 0,
        maxItems: 2,
        description: '可选：1 张首帧，或恰好 2 张首尾帧；HTTPS URL 或 data URL，不支持本地文件路径。',
      },
      size: {
        type: 'string',
        enum: ['1280x720', '720x1280', '1024x1024', '1920x1080', '1080x1920', '2048x1080', '3840x2160'],
        description: '视频分辨率，默认 1920x1080。',
      },
      fps: { type: 'integer', enum: [30, 60], description: '帧率，默认 30。' },
      duration: { type: 'integer', enum: [5, 10], description: '时长（秒），默认 5。' },
      quality: { type: 'string', enum: ['speed', 'quality'], description: 'speed 更快，quality 画质更好；默认 speed。' },
      with_audio: { type: 'boolean', description: '是否生成音频，默认 false。' },
      watermark: { type: 'boolean', description: '是否添加水印，默认由服务端决定。' },
      wait: { type: 'boolean', description: '是否在工具内等待完成，默认 true；false 时立即返回 task_id。' },
      timeout_seconds: { type: 'integer', minimum: 5, maximum: 540, description: '等待上限秒数，默认 300。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    timeoutMs: 600_000,
    async execute(args) {
      const started = Date.now()
      const cfg = await getConfig()
      if (!cfg.apiKey) return missingKey(cfg, 'video', COGVIDEO_MODEL)

      const truncated = promptOf(args.prompt, '', 512, 'CogVideoX prompt')
      const images = Array.isArray(args.images)
        ? args.images.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
        : []
      if (!truncated.text && images.length === 0) {
        return fail('video', COGVIDEO_MODEL, 'CogVideoX-3 需要 prompt 或 images 至少一个。', {
          note: '纯文本用 prompt；图生视频用 1 张首帧；首尾帧用 2 张图片。',
        })
      }
      if (images.length > 2) {
        return fail('video', COGVIDEO_MODEL, 'CogVideoX-3 最多支持 2 张图片：1 张首帧，或 2 张首尾帧。', {
          prompt: truncated.text,
        })
      }

      const sizes = new Set(['1280x720', '720x1280', '1024x1024', '1920x1080', '1080x1920', '2048x1080', '3840x2160'])
      const size = textOf(args.size) || '1920x1080'
      if (!sizes.has(size)) {
        return fail('video', COGVIDEO_MODEL, `不支持的 CogVideoX-3 尺寸 "${size}"。`, { prompt: truncated.text })
      }
      const fps = args.fps === undefined ? 30 : Number(args.fps)
      if (fps !== 30 && fps !== 60) {
        return fail('video', COGVIDEO_MODEL, 'fps 只能是 30 或 60。', { prompt: truncated.text })
      }
      const duration = args.duration === undefined ? 5 : Number(args.duration)
      if (duration !== 5 && duration !== 10) {
        return fail('video', COGVIDEO_MODEL, 'duration 只能是 5 或 10 秒。', { prompt: truncated.text })
      }
      const quality = textOf(args.quality) || 'speed'
      if (quality !== 'speed' && quality !== 'quality') {
        return fail('video', COGVIDEO_MODEL, 'quality 只能是 speed 或 quality。', { prompt: truncated.text })
      }

      const wait = args.wait !== false
      const requestedSeconds = Number.isFinite(Number(args.timeout_seconds)) ? Number(args.timeout_seconds) : 300
      const timeoutMs = Math.min(540_000, Math.max(5_000, requestedSeconds * 1000))
      const prompt = truncated.text

      try {
        const result = await generateCogVideo(
          {
            prompt,
            images,
            size,
            fps,
            duration,
            quality,
            withAudio: args.with_audio === true,
            watermark: typeof args.watermark === 'boolean' ? args.watermark : undefined,
          },
          cfg,
          { wait, timeoutMs },
        )
        if (result.status !== 'SUCCESS') {
          return resultOk('task', COGVIDEO_MODEL, {
            prompt: prompt || undefined,
            task_id: result.taskId,
            status: result.status,
            text: `CogVideoX-3 任务已提交：${result.taskId}（${result.status}）`,
            note: result.note,
            warning: truncated.note || undefined,
            elapsed_ms: elapsedMs(started),
          })
        }
        return resultOk('video', COGVIDEO_MODEL, {
          prompt: prompt || undefined,
          task_id: result.taskId,
          status: 'SUCCESS',
          video_url: result.videoUrl,
          cover_url: result.coverUrl,
          url: result.coverUrl,
          markdown_image: result.markdown,
          alt: result.alt || makeAlt(prompt || 'CogVideoX-3 视频封面'),
          text: 'CogVideoX-3 视频已生成。',
          warning: [truncated.note, result.warning].filter(Boolean).join(' ') || undefined,
          note: '视频链接为临时链接，约 1 天有效，请及时转存。',
          elapsed_ms: elapsedMs(started),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const taskId = error instanceof ZhipuError ? error.taskId : undefined
        const timedOut = error instanceof ZhipuTimeoutError
        return fail(timedOut ? 'task' : 'video', COGVIDEO_MODEL, message, {
          prompt: prompt || undefined,
          task_id: taskId,
          status: timedOut ? 'PROCESSING' : undefined,
          note: timedOut
            ? `任务 ${taskId ?? ''} 可能仍在服务端处理；请用 check_zhipu_task 查询，不要重复提交。`
            : '视频生成会消耗资源；失败后请检查提示词、图片格式和账户额度。',
          elapsed_ms: elapsedMs(started),
        })
      }
    },
  }),

  defineTool({
    name: 'check_zhipu_task',
    description: [
      '查询智谱异步任务（Vidu2、CogVideoX-3、GLM-Image 异步等）的状态。PROCESSING 时返回 task_id/status；SUCCESS 时会自动把图片或视频封面转成 output.markdown_image，并给出视频链接。',
      '当 generate_image_vidu / generate_video_vidu / generate_video_cogvideo 超时或使用 wait=false 时，用这个工具继续查询；不要重复提交同一个任务。',
    ].join('\n'),
    parameters: {
      task_id: { type: 'string', required: true, description: '提交异步任务时返回的 task id。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const started = Date.now()
      const cfg = await getConfig()
      const taskId = textOf(args.task_id)
      if (!taskId) return fail('task', 'unknown', 'task_id 不能为空。')
      if (!cfg.apiKey) return missingKey(cfg, 'task', 'unknown')
      try {
        const result = await checkZhipuTask(taskId, cfg)
        if (result.status !== 'SUCCESS') {
          return resultOk('task', 'unknown', {
            task_id: taskId,
            status: result.status,
            text: `任务 ${taskId} 当前状态：${result.status}`,
            note: result.note,
            elapsed_ms: elapsedMs(started),
          })
        }
        const kind = result.videoUrl ? 'video' : result.markdown ? 'image' : 'task'
        return resultOk(kind, result.model || 'unknown', {
          task_id: taskId,
          status: 'SUCCESS',
          video_url: result.videoUrl,
          cover_url: result.coverUrl,
          url: result.url,
          markdown_image: result.markdown,
          alt: result.alt || makeAlt(''),
          text: result.text || (result.videoUrl ? '任务成功，视频已生成。' : '任务成功。'),
          warning: result.warning,
          note: result.videoUrl ? '视频链接有效期约 1 天，请及时转存。' : undefined,
          elapsed_ms: elapsedMs(started),
        })
      } catch (error) {
        return fail('task', 'unknown', error instanceof Error ? error.message : String(error), {
          task_id: taskId,
          elapsed_ms: elapsedMs(started),
        })
      }
    },
  }),

  defineTool({
    name: 'generate_voice_breeze',
    description: [
      '用本机部署的 Breeze-TTS-2 把文字合成为语音（本地模型，不需要 ZHIPU_API_KEY，不上传文本）。',
      '需要 Breeze 服务在 http://127.0.0.1:8080 运行；未运行时工具会自动尝试启动 Breeze-TTS-2.cpp（首次加载模型可能需要几十秒），也可以用 BREEZE_AUTOSTART=0 关闭自动启动。',
      '成功时 WAV 会保存到本机，output.markdown_audio 是 [播放/下载语音](/zhipu/breeze/audio/...) 的 Markdown 链接；请把 markdown_audio 原样放入回复正文，不要放进代码块。',
      'prompt 最多 4000 字符；voice_id 留空时由 instruction 描述音色，填写时必须是 Breeze 已保存的音色 id。',
    ].join('\n'),
    parameters: {
      prompt: { type: 'string', required: true, description: '要朗读的文字，最多 4000 字符。' },
      instruction: { type: 'string', description: '音色/语气描述，例如“温柔、清晰、稍慢的年轻女声”；留空使用 Breeze 默认值。' },
      voice_id: { type: 'string', description: 'Breeze 已保存的音色 id；留空则按 instruction 设计音色。' },
      seed: { type: 'integer', minimum: 0, maximum: 2_147_483_647, description: '随机种子，默认 42；同一种子便于复现。' },
      cfg_scale: { type: 'number', minimum: 0.1, maximum: 3, description: '引导强度，默认 1；越高越贴近 instruction，但更慢。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    timeoutMs: 300_000,
    async execute(args) {
      const started = Date.now()
      const cfg = breezeConfig()
      const truncated = promptOf(args.prompt, '', 4_000, 'prompt')
      if (!truncated.text) return fail('voice', 'breeze-tts-2', 'prompt 不能为空。')
      const seed = args.seed === undefined ? undefined : Number(args.seed)
      if (seed !== undefined && (!Number.isInteger(seed) || seed < 0)) {
        return fail('voice', 'breeze-tts-2', 'seed 必须是非负整数。', { prompt: truncated.text })
      }
      const cfgScale = args.cfg_scale === undefined ? undefined : Number(args.cfg_scale)
      if (cfgScale !== undefined && (!Number.isFinite(cfgScale) || cfgScale < 0.1 || cfgScale > 3)) {
        return fail('voice', 'breeze-tts-2', 'cfg_scale 必须在 0.1-3 之间。', { prompt: truncated.text })
      }
      try {
        const result = await requestBreezeSpeech({
          text: truncated.text,
          instruction: textOf(args.instruction) || undefined,
          voice: textOf(args.voice_id) || undefined,
          seed,
          cfgScale,
        }, cfg)
        const saved = await saveBreezeAudio(result.bytes, cfg)
        return resultOk('voice', 'breeze-tts-2', {
          prompt: truncated.text,
          transcript: truncated.text,
          audio_path: saved.filePath,
          markdown_audio: `[播放/下载语音](${breezeAudioPath(saved.fileName)})`,
          engine: 'breeze-tts-2',
          note: '本地 Breeze 生成，WAV 已保存到本机；markdown_audio 通过 DSH Host 的同源路由播放。',
          warning: truncated.note || undefined,
          elapsed_ms: elapsedMs(started),
        })
      } catch (error) {
        const message = error instanceof BreezeError
          ? error.message
          : `Breeze 合成失败：${error instanceof Error ? error.message : String(error)}`
        return fail('voice', 'breeze-tts-2', message, {
          prompt: truncated.text,
          transcript: truncated.text,
          note: 'Breeze 是本地独立服务；确认 start-breeze-server.cmd 正在运行，或设置 BREEZE_HOME、BREEZE_BASE_URL 后重试。',
          elapsed_ms: elapsedMs(started),
        })
      }
    },
  }),
]
