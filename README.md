# dsh-zhipu-multimodal

DSH bundle：把智谱的 GLM-Image、Vidu2、CogVideoX-3、CharGLM-4 注册成工具，并把本机部署的 **Breeze-TTS-2** 接成一个工具和侧边栏「语音」页。所有网络/进程失败都会收敛成模型可读的结果，不会让插件加载失败。

## 工具与模型

| 工具 | 模型 | 能力 | 同步/异步 | 主要输出 |
| --- | --- | --- | --- | --- |
| `generate_image_glm` | `glm-image` | 文生图 | 同步 | `markdown_image`（HTTPS 图片 URL） |
| `generate_image_vidu` | `vidu2-image` | **图生视频**（1 张参考图） | 异步，默认工具内轮询 | 视频封面 `markdown_image` + `video_url` |
| `generate_video_vidu` | `vidu2-image` / `vidu2-reference` / `vidu2-start-end` | 图生视频 / 参考图 / 首尾帧 | 异步，默认轮询 | 视频封面 + 视频链接 |
| `generate_video_cogvideo` | `cogvideox-3` | **文生视频 / 单图生视频 / 首尾帧** | 异步，默认轮询 | 视频封面 `markdown_image` + `video_url` |
| `chat_char` | `charglm-4`（失败降级 `glm-4-flash`） | 角色人设对话 | 同步 | 纯文本 `text` |
| `generate_voice_breeze` | **本机 Breeze-TTS-2** | 本地文字转语音 | 同步（首次可能要等模型加载） | `/zhipu/breeze/audio/...` 播放链接 + `transcript` |
| `check_zhipu_task` | 通用异步查询 | 查询 Vidu2 / CogVideoX-3 / 异步图片任务 | 同步 | 状态；成功后自动转 markdown |

### 五个必须知道的能力边界

1. **Vidu2 官方是图生视频，不是文生图。** `vidu2-image` 必须提供 `image_url`；`generate_image_vidu` 虽然名字带 image，返回的是「视频 + 封面图」。纯静态图片请用 `generate_image_glm`。
2. **CharGLM-4 没有可确认的 v4 专属文档端点。** 默认请求 `${ZHIPU_BASE_URL}/chat/completions` + `charglm-4`，并把 `system_role` 写入 `meta.bot_info`；404/422/模型类 400 会降级到 `glm-4-flash`，人设移入 system message，结果标 `degraded=true`。若你的账号有专属端点，用 `ZHIPU_CHAR_ENDPOINT` 覆盖。
3. **Breeze 是本地服务，不是智谱 API。** 它不需要 `ZHIPU_API_KEY`，文本不会上传；需要本机有 Breeze-TTS-2.cpp、`breeze-server.exe` 和 GGUF 模型。默认 `http://127.0.0.1:8080`，首次加载模型可能要几十秒。
4. **Breeze 的 WAV 是流式头。** 它的 `RIFF`/`data` 长度字段会写成 `0xFFFFFFFF`；插件在保存/返回浏览器前会把长度改成真实值，否则播放器会认为文件损坏。
5. **CogVideoX-3 是视频生成，不是图片生成。** 支持纯文本、1 张首帧、恰好 2 张首尾帧；`prompt` 最多 512 字符，`image_url` 与 `prompt` 至少一个。输出视频链接约 1 天有效，封面会转成 `markdown_image`；视频本身只能以链接展示。

### 为什么移除了云端语音

v0.3.0 起不再注册 `generate_voice`（GLM-4-Voice → GLM-TTS）：

- **GLM-4-Voice 不是纯 TTS**，而是语音对话模型，官方示例要求 `input_audio` 音频输入；纯文本请求实测被 `HTTP 400` 拒绝，当前插件没有麦克风/音频输入链路，保留它等于保留一个不可用工具。
- **GLM-TTS 与 Breeze 能力重叠**，都是文字转语音；本机 Breeze 已可用、无需 API 费用、支持音色设计，而 GLM-TTS 当前账户返回 `HTTP 429 余额不足`。
- 如果以后要接“语音对话”而不是“文字转语音”，应单独做音频输入 + 多轮会话，不应混在 TTS 工具里。

## 一句话调用 Breeze

在对话里直接让模型调用：

```text
用 Breeze 说一句：欢迎回来，今天也辛苦了。
```

对应工具：

```text
generate_voice_breeze({
  prompt: "欢迎回来，今天也辛苦了。",
  instruction: "温柔、清晰、稍慢",
  seed: 42
})
```

成功时结果是 `kind: "voice"`，其中：

```json
{
  "markdown_audio": "[播放/下载语音](/zhipu/breeze/audio/breeze-....wav)",
  "audio_path": "C:\\Users\\...\\.dsh\\cache\\zhipu-multimodal\\breeze\\breeze-....wav"
}
```

把 `markdown_audio` 原样放进回复正文即可播放/下载。DSH 没有音频内容块，所以不能在工具卡片里内嵌 `<audio>`；侧边栏页面才有真正的播放器。

## 侧边栏「语音」页

安装 v0.4.0 后，左侧导航会出现麦克风图标的 **语音** 入口（`sidebar.panellist` 的 `id: "breeze"`），点开是一个独立主面板：

- 输入文本、音色/语气、可选音色 ID、seed；
- 「生成语音」按钮；生成中禁用，完成后自动播放；
- 服务离线时显示「启动本地服务」按钮；
- 所有请求走同源 Host 路由，不直接跨域访问 Breeze。

Host 路由（注册在 `lib/index.js`，实现于 `lib/breeze-route.js`）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/zhipu/breeze/status` | 探测 `/health`，**不**自动启动 |
| `POST` | `/zhipu/breeze/start` | 显式启动并等待模型加载 |
| `POST` | `/zhipu/breeze/speech` | JSON `{text,instruction,voice,seed,cfg_scale}` → 修正后的 `audio/wav` |
| `GET` | `/zhipu/breeze/audio/<name>` | 只服务插件缓存目录里的 `.wav`，防目录穿越 |

路由只接受同源 `Origin`；无 `webServer` 的 headless 组合会跳过路由，不影响工具注册。

## 图片如何真正显示在回复里

DSH 的工具结果卡片按纯文本渲染，**不会**把工具输出里的 Markdown 当图片加载；只有助手回复正文的 Markdown 会。因此本插件按用户指定的回退方案实现：

- `output.render` 返回文本，其中第一行是可直接粘贴的 `![alt](https://...)`，字段为 `output.markdown_image`。
- 工具 description 明确要求模型：**把 `markdown_image` 原样放进回复正文，单独一行，不要代码块、不要反引号、不要转义、不要改写 URL**。
- 工具卡片本身显示的是这段文本，不是图片；这是 DSH 当前渲染机制决定的。

安全约束：只接受 `https:` 和 `data:image/(png|jpeg|webp|gif);base64,...`。非 HTTPS、带用户名密码、超长 URL、超大 data URL（> 6,000,000 字符）都会被拒绝或隐藏，并写入 `warning`。图片临时链接通常约 30 天有效，请及时转存。

## 鉴权

### 智谱

只从运行环境读取，不写入代码、schema、日志或结果：

1. 环境变量 `ZHIPU_API_KEY`；
2. 或 `~/.glm/.env` 中的一行 `ZHIPU_API_KEY=...`（也接受 `export` 和引号）。

缺失时工具返回：

```text
未找到 ZHIPU_API_KEY。请设置环境变量 ZHIPU_API_KEY，或在 ~/.glm/.env 中写入一行 ...
```

设置后无需重启 Host；下一次工具调用会重新读取。本机已用真实 key 验证 `chat_char` 和 `generate_image_glm`。

### Breeze

Breeze 无鉴权，只监听本机回环地址；`generate_voice_breeze` 不需要 `ZHIPU_API_KEY`。自动启动依赖本机可执行文件和模型，路径用 `BREEZE_HOME` / `BREEZE_EXE` / `BREEZE_MODEL` 配置。

## 安装与更新

本机已安装到 desktop profile：

```text
plugin_manager action:install_bundle target:"D:\\DeepSeek work\\dsh-zhipu-multimodal"
```

当前验证版本为 **0.4.0**。bundle 入口是 `lib/index.js`，`apply(ctx)` 注册 7 个工具并挂 `/zhipu/breeze` 路由；`client.js` 通过 `dsh.client`/`exports["./client"]` 加载侧边栏页面。

**改 description/parameters 或 client 入口后，不要只等热重载。** 本机实测 Host 会保留旧工具 schema；需要：

```text
plugin_manager action:remove_bundle target:"dsh-zhipu-multimodal"
plugin_manager action:install_bundle target:"D:\\DeepSeek work\\dsh-zhipu-multimodal"
```

然后刷新 GUI。不要手写 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile 里跑 pnpm。

## 异步用法

Vidu2 提交后默认在工具内轮询（`timeout_seconds` 默认 120，最大 180；工具总超时 240 秒）。CogVideoX-3 默认等待 300 秒、最大 540 秒，工具总超时 600 秒；5 秒和 10 秒视频都按同一套异步任务查询。长任务建议：

```text
generate_video_cogvideo({ prompt: "一只猫在月球上跳跃", wait: false })
→ { task_id: "..." }

check_zhipu_task({ task_id: "..." })
→ PROCESSING 继续等；SUCCESS 自动返回封面 markdown_image / video_url
```

Vidu2 的 `wait: false` 与查询方式相同。超时不会丢弃任务：返回 `ok: false`、`kind: "task"`、`task_id`、`status: "PROCESSING"`（render 会显示“调用失败”，但 note 明确任务仍在服务端处理），并提示继续查询，不要重新提交。FAIL / CANCELED / 网络中断都会返回明确错误和可用的 `task_id`。

## 语音：本地 Breeze

v0.3.0 起只保留 `generate_voice_breeze`；云端 `generate_voice` 已移除，原因见上文。

- 调用 Breeze 的 OpenAI 兼容 JSON：`POST /v1/audio/speech`，`response_format: "wav"`，返回 16-bit mono 24kHz WAV。
- 服务未启动时，`ensureBreeze()` 会尝试启动 `breeze-server.exe`（`detached`，不阻塞对话主循环），最多等 `BREEZE_START_TIMEOUT_MS`。
- 合成失败会区分：服务离线、exe/模型缺失、启动超时、404 音色、409 忙、非音频响应、坏 WAV、网络错误。
- 多个并发调用共享同一个启动 Promise，不会同时拉起两个模型。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ZHIPU_API_KEY` | 无 | 智谱必填；也可放 `~/.glm/.env` |
| `ZHIPU_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` | 智谱 API 根地址 |
| `ZHIPU_CHAR_ENDPOINT` | `${base}/chat/completions` | CharGLM 主端点 |
| `ZHIPU_CHAR_MODEL` | `charglm-4` | 角色模型 ID |
| `ZHIPU_CHAR_FALLBACK_ENDPOINT` | `${base}/chat/completions` | 角色降级端点 |
| `ZHIPU_CHAR_FALLBACK_MODEL` | `glm-4-flash` | 角色降级模型 |
| `ZHIPU_REQUEST_TIMEOUT_MS` | `60000` | 单次 JSON 请求超时 |
| `ZHIPU_POLL_INTERVAL_MS` | `3000` | 异步轮询间隔 |
| `ZHIPU_VIDU_TIMEOUT_MS` | `180000` | 异步轮询总超时 |
| `BREEZE_HOME` | `D:\\DeepSeek work\\Breeze-TTS-2.cpp` | Breeze 根目录 |
| `BREEZE_BASE_URL` | `http://127.0.0.1:8080` | Breeze 服务地址 |
| `BREEZE_EXE` | `${home}\\app\\...\\breeze-server.exe` | 覆盖可执行文件 |
| `BREEZE_MODEL` | `${home}\\models\\breeze-tts-2-q8_0.gguf` | 覆盖模型 |
| `BREEZE_AUTOSTART` | `1` | `0` 禁止工具/面板自动拉起服务 |
| `BREEZE_AUDIO_DIR` | `~/.dsh/cache/zhipu-multimodal/breeze` | 本地 WAV 缓存 |
| `BREEZE_TIMEOUT_MS` | `180000` | 单次合成超时 |
| `BREEZE_START_TIMEOUT_MS` | `60000` | 冷启动等待上限 |

## 测试

```powershell
cd "D:\\DeepSeek work\\dsh-zhipu-multimodal"
node --check lib/index.js
node --check lib/tools.js
node --check lib/breeze.js
node --check lib/breeze-route.js
node --check client.js
node test/selfcheck.mjs
```

当前离线自检 **39/39 passed**：mock HTTP，不读取真实 key，不访问外网。覆盖 7 个工具 schema、缺 key、GLM URL/b64/非 HTTPS、data URL 注入、Vidu 成功/FAIL/超时/CANCELED/空图/长 prompt、CogVideoX-3 文生视频/单图/首尾帧/空输入/FAIL/本地图拒绝、Char 正常/降级/鉴权/history、Breeze 合成/WAV 长度修正/长文本/离线错误、多模型共存。

### 真实调用记录

- `chat_char`：成功，返回「已连通。我是一个语言模型。」
- `generate_image_glm`：成功生成 1280×1280 图片，返回 HTTPS URL。
- `generate_voice_breeze`：本机 Breeze 服务已启动，实测 1.87 秒生成 169,004 字节 WAV；`RIFF`/`WAVE`、24kHz、mono、16-bit、长度字段均正确。
- `generate_video_cogvideo`：真实提交任务 `202611211730075ab16f9d87f44366`，约 1 分钟返回 `SUCCESS`；生成 5 秒、1280×720、16:9 视频，返回 HTTPS 封面与 MP4 链接。

**未完成真实调用的部分**：Vidu2、CharGLM-4 专属端点。它们需要对应模型/额度，离线 mock 不能替代账号侧的权限与计费验证。

## 目录

```text
lib/index.js        插件入口：name / inject / apply / Breeze 路由
lib/tools.js        7 个工具定义与 execute
lib/schema.js       本地 defineTool 兼容层、output.schema、render
lib/api.js          GLM-Image / Vidu2 / CogVideoX-3 / CharGLM API
lib/http.js         Bearer 请求、错误归一化、异步轮询
lib/config.js       智谱环境变量与 ~/.glm/.env 读取
lib/format.js       markdown 图片/链接、尺寸校验、截断
lib/breeze.js       本地 Breeze 健康检查、自动启动、WAV 修正
lib/breeze-route.js /zhipu/breeze 同源路由
client.js           侧边栏「语音」页（sidebar.panellist + main）
test/selfcheck.mjs  离线回归
```
