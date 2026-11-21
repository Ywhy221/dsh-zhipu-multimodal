/**
 * Small, dependency-free subset of the Host's defineTool contract.
 *
 * A profile bundle cannot reliably import `@deepseek-ai/dsh-tools`: the
 * package is supplied by the Host process, not by the profile's node_modules.
 * This helper builds the same registry-ready object shape (name, description,
 * full JSON-Schema parameters, output.schema/render, execute) without a bare
 * Host import. Keeping it local is what lets the bundle survive profile moves,
 * `link:` installs and Host upgrades.
 */

/**
 * Build an object-rooted JSON Schema from per-property author definitions.
 * `required: true` on a property is moved to the object's `required` array.
 * @param {Record<string, object>} properties
 * @param {{additionalProperties?: boolean, required?: string[]}} [options]
 * @returns {object}
 */
export function objectSchema(properties = {}, options = {}) {
  const props = {}
  const required = [...(options.required ?? [])]
  for (const [key, spec] of Object.entries(properties)) {
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error(`schema property "${key}" must be an object`)
    }
    const { required: isRequired, ...rest } = spec
    props[key] = rest
    if (isRequired === true && !required.includes(key)) required.push(key)
  }
  return {
    type: 'object',
    additionalProperties: options.additionalProperties ?? false,
    properties: props,
    ...(required.length === 0 ? {} : { required }),
  }
}

/**
 * Declare a tool with the same runtime shape the Host's defineTool produces.
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.description
 * @param {object} options.parameters Full JSON Schema, or a property map.
 * @param {{schema: object, render: (args: object, value: object) => object[]}} options.output
 * @param {(args: object, exec: object) => Promise<object>} options.execute
 * @param {number} [options.timeoutMs]
 * @param {(args: object) => boolean} [options.isConcurrencySafe]
 * @returns {object}
 */
export function defineTool(options) {
  if (!options || typeof options !== 'object') throw new Error('defineTool requires an options object')
  if (typeof options.name !== 'string' || options.name.length === 0) throw new Error('defineTool requires a name')
  if (typeof options.description !== 'string' || options.description.length === 0) {
    throw new Error(`defineTool(${options.name}) requires a description`)
  }
  if (!options.output || typeof options.output.render !== 'function') {
    throw new Error(`defineTool(${options.name}) requires output.render`)
  }
  if (!options.output.schema || options.output.schema.type !== 'object') {
    throw new Error(`defineTool(${options.name}) requires an object output.schema`)
  }
  const parameters = options.parameters?.type === 'object'
    ? options.parameters
    : objectSchema(options.parameters ?? {})
  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: options.output.schema,
      render: options.output.render,
    },
    async execute(args, exec) {
      return options.execute(args ?? {}, exec ?? {})
    },
  }
  if (options.timeoutMs !== undefined) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`)
    }
    tool.timeoutMs = options.timeoutMs
  }
  if (options.isConcurrencySafe) tool.isConcurrencySafe = options.isConcurrencySafe
  return tool
}

/** Common output shape shared by every tool in this bundle. */
export const OUTPUT_SCHEMA = objectSchema({
  ok: { type: 'boolean', required: true, description: 'Whether the call produced a usable result.' },
  kind: {
    type: 'string',
    required: true,
    enum: ['image', 'video', 'text', 'voice', 'task'],
    description: 'Result family.',
  },
  model: { type: 'string', required: true, description: 'Model that produced the result, or the requested model on failure.' },
  prompt: { type: 'string', description: 'Prompt after truncation.' },
  markdown_image: { type: 'string', description: 'Ready-to-paste Markdown image line, e.g. ![alt](https://...). Empty when unavailable.' },
  markdown_audio: { type: 'string', description: 'Ready-to-paste Markdown link to the generated audio file. Empty when unavailable.' },
  url: { type: 'string', description: 'Primary image URL, when the result is an image.' },
  alt: { type: 'string', description: 'Alt text used in markdown_image.' },
  text: { type: 'string', description: 'Human-readable result summary or model text.' },
  transcript: { type: 'string', description: 'Text that was spoken, when the result is audio.' },
  task_id: { type: 'string', description: 'Async task id for later check_zhipu_task calls.' },
  status: { type: 'string', description: 'Async task status.' },
  video_url: { type: 'string', description: 'Video URL, for Vidu2 results.' },
  cover_url: { type: 'string', description: 'Video cover image URL, for Vidu2 results.' },
  audio_path: { type: 'string', description: 'Local path of the generated audio file.' },
  engine: { type: 'string', description: 'Voice engine actually used.' },
  degraded: { type: 'boolean', description: 'Whether a fallback model/engine produced the result.' },
  warning: { type: 'string', description: 'Non-fatal safety or compatibility warning.' },
  note: { type: 'string', description: 'Actionable note for the model or user.' },
  error: { type: 'string', description: 'Readable failure text. Present only when ok is false.' },
  elapsed_ms: { type: 'integer', description: 'Wall-clock duration of the tool call.' },
})

/**
 * Build the model-facing text for one tool result. This is the only content
 * block the Host receives, so every actionable fact must be in this text.
 * @param {object} _args
 * @param {object} value
 * @returns {object[]}
 */
export function renderValue(_args, value) {
  if (value === null || typeof value !== 'object') {
    return [{ type: 'text', text: '（工具没有返回结果）' }]
  }
  const lines = []
  if (value.markdown_image) lines.push(value.markdown_image)
  if (value.markdown_audio) lines.push(value.markdown_audio)

  if (value.ok === false) {
    lines.push(`调用失败：${value.error || '未知错误'}`)
  }
  if (value.text) lines.push(value.text)
  if (value.transcript && value.transcript !== value.text) lines.push(`转录：${value.transcript}`)
  if (value.video_url) lines.push(`视频链接：${value.video_url}`)
  if (value.cover_url && value.cover_url !== value.url) lines.push(`封面链接：${value.cover_url}`)
  if (value.audio_path) lines.push(`音频文件：${value.audio_path}`)
  if (value.task_id) lines.push(`任务 ID：${value.task_id}`)
  if (value.status) lines.push(`任务状态：${value.status}`)
  if (value.engine) lines.push(`语音引擎：${value.engine}${value.degraded ? '（降级）' : ''}`)
  if (value.note) lines.push(`说明：${value.note}`)
  if (value.warning) lines.push(`警告：${value.warning}`)

  if (value.markdown_image) {
    lines.push('<!-- 将上面的 markdown 图片原样放入回复正文；不要放进代码块。 -->')
  }
  return [{ type: 'text', text: lines.join('\n\n') || '（空结果）' }]
}

/**
 * Drop undefined fields. The Host validates execute() output against
 * output.schema, and an own property whose value is undefined is not the same
 * as an absent optional property.
 * @param {object} value
 * @returns {object}
 */
function compact(value) {
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item
  }
  return out
}

/**
 * @param {'image'|'video'|'text'|'voice'|'task'} kind
 * @param {string} model
 * @param {object} [fields]
 * @returns {object}
 */
export function resultOk(kind, model, fields = {}) {
  return compact({ ok: true, kind, model, ...fields })
}

/**
 * @param {'image'|'video'|'text'|'voice'|'task'} kind
 * @param {string} model
 * @param {unknown} error
 * @param {object} [fields]
 * @returns {object}
 */
export function resultFail(kind, model, error, fields = {}) {
  return compact({
    ok: false,
    kind,
    model,
    error: error instanceof Error ? error.message : String(error ?? '未知错误'),
    ...fields,
  })
}
