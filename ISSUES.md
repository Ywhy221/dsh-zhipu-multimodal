# 多轮自检记录（ISSUES）

- 项目：`dsh-zhipu-multimodal`
- 环境：Windows / DSH desktop profile / `@deepseek-ai/dsh-tools 0.2.2-rc.5`
- 离线回归：`node test/selfcheck.mjs` → **39/39 passed**
- 安装验证：v0.4.0 已重新安装 → `application: "applied"`、`warnings: []`，**7 个工具** active（含 `generate_video_cogvideo`）；Breeze 的 `sidebar.panellist` / `main` occupant 仍 active；Host 不暴露 `generate_voice`
- 真实 API：智谱 `chat_char`、`generate_image_glm` 已成功；Breeze 本地语音已实测成功；CogVideoX-3 已真实提交并生成 5 秒 1280×720 视频（task `202611211730075ab16f9d87f44366`，SUCCESS）

## 第一轮：实现 + 自检

第一轮修复后离线测试 **29/29**。检查项与处理如下。

| # | 检查项 | 发现 | 修复 | 回归 |
| --- | --- | --- | --- | --- |
| 1 | 异步兼容性：Vidu FAIL 是否带 task_id | FAIL 分支只抛错误文本，用户无法继续查询 | `runVidu` catch 从 `ZhipuError.taskId` 回填 `task_id` | 测试断言 FAIL 结果含 task_id |
| 2 | 异步兼容性：CANCELED | 只识别 FAIL/FAILED，CANCELED 会一直轮询到超时 | `pollAsync` 将 CANCELED/CANCELLED 按失败处理 | 测试覆盖 |
| 3 | 异步不阻塞主循环 | 轮询使用 `setTimeout` 的 `sleep`，不是忙等；工具总超时 240s | 保留；超时返回 PROCESSING + task_id，提示用 `check_zhipu_task` | 超时测试 |
| 4 | GLM-Image URL 转换 | 原始 `data[0].url` 只是 JSON 字符串 | `markdownImage()` 生成 `![alt](https://...)`；非 HTTPS 过滤；b64 转 data URL | URL/b64/非 HTTPS 三组测试 |
| 5 | Vidu 结果格式 | 可能是 `video_result`、`data`、`image_result` | `normalizeSuccess` 统一成 `kind: image/video/text` 和 markdown | SUCCESS/check 测试 |
| 6 | 输出 schema 与 render 一致 | `resultOk/resultFail` 可能显式带 `undefined` 字段 | `compact()` 删除 undefined；本地校验 `OUTPUT_SCHEMA` | 每个成功/失败结果都过 `assertResult` |
| 7 | data URL 注入 | 原正则允许空白/换行，可能把恶意文本带进 markdown | 只允许 `[A-Za-z0-9+/=]+`；限制 6,000,000 字符 | 注入测试 |
| 8 | 大体积重复 | b64 结果同时填 `url` 和 `markdown_image`，重复数 MB | data URL 时省略 `url` | b64 测试 |
| 9 | 鉴权缺失 | 缺 key 时不能静默失败/抛未捕获异常 | 返回统一 `missingKeyMessage`；真实 Host 已验证 | 缺 key 测试 + 安装后实调 |
| 10 | 4xx/5xx 错误 | 原始异常会打断工具调用 | `requestJson` 归一化为 `ZhipuError`，execute 顶层 catch → `resultFail` | 400/401/404/HTML 200 测试 |
| 11 | 模型标识：Vidu2 实际能力 | 用户描述为“文生图/参考图生图”，官方文档是**图生视频**，`vidu2-image` 必须 `image_url` | 不伪装成文生图：`generate_image_vidu` 返回视频+封面；静态图指向 GLM-Image；无参考图本地拒绝 | 无图测试、模型说明 |
| 12 | 模型标识：CharGLM-4 端点 | 官方 `llms.txt` 无 CharGLM-4 v4 页面；旧资料只有 characterglm v3 | 主请求可配置 `ZHIPU_CHAR_ENDPOINT`/`ZHIPU_CHAR_MODEL`；失败降级 `glm-4-flash`，人设入 system message，结果标 degraded | 正常/404 降级/401 不降级 |
| 13 | 模型标识：GLM-4-Voice 端点 | 官方示例只展示音频输入，纯文本输入无示例 | 先走 chat/completions + `glm-4-voice`；无音频自动降级 GLM-TTS；可配置 `ZHIPU_VOICE_ENDPOINT` | Voice 成功/TTS 降级/双失败 |
| 14 | 角色多轮 | 初版只支持单轮 prompt | 增加 `history`（最多 20 轮，每轮截断 2000 字符） | history 顺序测试 |
| 15 | 超长 prompt | GLM 上限 1000，Vidu 文档实际 512 | 统一 `truncateText`，写 `warning` 和原长 | 1000/512/1024 三组测试 |

## 第二轮：边界条件与兼容性加固

第二轮在安装后逐文件复核，测试从 29 项扩到 **35/35**。

| # | 边界场景 | 发现 | 修复 | 回归 |
| --- | --- | --- | --- | --- |
| 1 | 多模型共存 | 同一会话先 GLM-Image 再 CharGLM-4，schema/全局状态是否被污染 | 每个工具独立 schema、独立 execute；无模块级可变请求状态 | 共存测试 |
| 2 | Chat 超时 | `chat_char` 90s，小于主请求 60s + 降级 60s | 提到 **150s** | `timeoutMs >= 120_000` |
| 3 | Voice 超时 | `generate_voice` 150s，小于 Voice 120s + TTS 120s | 提到 **300s** | `timeoutMs >= 240_000` |
| 4 | Vidu 空 images | 直接调 `createViduTask` 会 `undefined.filter` TypeError | `Array.isArray` 保护，返回可读错误 | 空数组测试 |
| 5 | 非法 Vidu 模型 | 初版静默回退 `vidu2-image`，会隐藏调用错误 | 返回 `不支持的 Vidu2 模型...` | 代码路径 |
| 6 | TTS 假 WAV | 只看长度 ≥44，200 HTML/JSON 也会落盘成 `.wav` | 校验 `RIFF`/`WAVE` 头 + content-type；拒绝落盘 | HTML 200 测试 |
| 7 | Voice base64 前缀 | `data:audio/wav;base64,` 直接 Buffer 解码会坏 | `audioBase64` 剥离前缀和空白 | 前缀测试 |
| 8 | 视频链接安全 | 非 HTTPS `video_url` 会交给模型；空 prompt 的 alt 变成“生成图片” | 视频/封面只保留 HTTPS，否则隐藏并 warning；alt 用“生成视频” | 代码复核 |
| 9 | 图片 URL 协议 | `http:` 图片不应被渲染器尝试加载 | 工具层只接受 HTTPS/data URL，非 HTTPS 过滤 + warning | 非 HTTPS 测试 |
| 10 | Vidu 尺寸 | `480x360` 官方仅 start-end 支持 | 其他模型本地拒绝 | 尺寸测试 |
| 11 | 参考图输入 | 本地路径/HTTP 图片直到 API 才报错 | 仅接受 HTTPS URL 或 `data:image/(png|jpe?g|webp);base64` | 本地路径测试 |
| 12 | Prompt 长度 | 用户预期 Vidu 2000 字符，官方文档实际 512 | 按官方 512 截断并 warning，README 说明 | 512 测试 |
| 13 | 降级端点 | Char 降级复用用户自定义 `charEndpoint` 可能不可用 | 新增 `ZHIPU_CHAR_FALLBACK_ENDPOINT` | 404 降级测试 |
| 14 | 鉴权错误误降级 | 400 `invalid api key` 曾触发 Char 降级 | `shouldFallbackChar` 先排除 api key/authentication/unauthorized/鉴权/密钥 | 400 鉴权测试 |
| 15 | 工具描述指引 | 缺少“原样粘贴、不要代码块”会让模型把 markdown 包进代码块 | 所有图像/视频 description 明确要求；render 末尾追加 HTML 注释提示 | 人工复核 |
| 16 | GLM-4-Voice 音频格式 | 官方示例把 `audio.data` 解码后按 44.1kHz 单声道 16-bit **PCM** 写 WAV；初版直接把 base64 存成 `.wav`，没有 RIFF 头，播放器打不开 | `normalizeVoiceWav()` 识别 RIFF/WAVE 原样保存，否则把 PCM 封装成 44 字节 WAV 头；校验偶数长度和最短长度 | 原始 PCM 测试断言 RIFF/WAVE/44100/mono/16-bit |

## 第三轮：Breeze 本地语音集成

| # | 检查项 | 发现 | 修复 | 回归 |
| --- | --- | --- | --- | --- |
| 1 | Breeze 流式 WAV 头 | `RIFF` size 与 `data` size 都是 `0xFFFFFFFF`，直接保存/返回浏览器会像坏文件 | `normalizeWav()` 找 `data` chunk，写入实际长度和 `RIFF size = length - 8` | 单测构造 0xFFFFFFFF WAV；真实 Breeze 生成 169,004 字节 WAV，头部已修正 |
| 2 | Breeze 无服务/未加载 | 直接 `fetch` 会得到连接拒绝，模型只看到网络错误 | `ensureBreeze()` 先探 `/health`；本地且允许时 detached spawn，共享 `starting` Promise，按 500ms 轮询；exe/模型缺失给具体路径 | 离线禁用自动启动测试；真实服务冷/热各跑一次 |
| 3 | Breeze 合成失败分类 | 404 音色、409 忙、非音频响应、坏 WAV 都容易混成“网络错误” | 分别转成中文 `BreezeError`；校验 `audio/*` 和 RIFF/WAVE；文本上限 4000 | 离线 mock 三类错误；真实合成 |
| 4 | 路由同源与目录穿越 | 浏览器直连 Breeze 会遇到 CORS；`/audio/../../...` 不能读任意文件 | Host 注册 `/zhipu/breeze`；只接受同源 `Origin`；音频名做 basename + `.wav` 校验；只读 `BREEZE_AUDIO_DIR` | 代码复核 + 路由 smoke（`/status`、`/speech`、`/audio` 均 200） |
| 5 | 侧边栏注册 | `sidebar.footer.action` 只有宽/窄按钮，不适合完整表单；主面板必须用 keyed slot | 用 `sidebar.panellist` 注册 `id:"breeze"`、`label:"语音"`；`main` 注册 `key:"breeze"`；`VoicePage` 用原生控件 | `cordis_inspect_query` 确认两个 slot occupant 均 active |
| 6 | 客户端模块格式 | 手写 JSX 无法直接进浏览器；模块必须走 `__ModuleLoader__.load` | `client.js` 用手写 factory + `React.createElement`；`dsh.client.platform="web"`、`exports["./client"]` | `node --check client.js`；client slot 注册 active |
| 7 | 测试数量与工具数 | 旧测试固定 6 个工具，新增工具会让注册测试失败 | 改为 7 个；新增 Breeze 成功/长文本/离线三项；总数 38 | **38/38 passed** |

## 第四轮：移除云端语音，仅保留 Breeze

用户问 GLM-4-Voice / GLM-TTS 与 Breeze 的区别，若差别不大就移除云端语音。结论是移除 `generate_voice`，只保留本地 `generate_voice_breeze`。

| # | 检查项 | 发现 | 修复 | 回归 |
| --- | --- | --- | --- | --- |
| 1 | GLM-4-Voice 是不是 TTS | 不是。它是语音对话模型，官方示例要求 `input_audio`；本机纯文本请求 `HTTP 400 user message item content is string, should be list` | 不再把 GLM-4-Voice 包装成文字转语音工具；插件当前没有音频输入链路 | 真实请求记录 |
| 2 | GLM-TTS 与 Breeze 是否重叠 | 都是文字转语音；Breeze 本地可用、无 API 费用、支持音色设计；GLM-TTS 账户 `HTTP 429 余额不足` | 删除云端 `generate_voice`（GLM-4-Voice → GLM-TTS），只保留 Breeze | 30/30 离线测试 |
| 3 | 删除后的死代码 | `lib/api.js` 仍有 `audioBase64`/`normalizeVoiceWav`/`saveAudio`/`generateVoice`，`lib/config.js` 仍有 `voiceEndpoint`/`audioDir`/`voiceTimeoutMs` | 一并删除相关 imports/常量/配置；`lib/tools.js` 删除 `generate_voice` 定义与 import | `node --check` 全通过 |
| 4 | 测试/文档数量漂移 | 测试仍断言 7 个工具、38/38；README 仍有云端语音表/env 行 | 工具数改 6、测试 30/30；README 新增“为什么移除了云端语音”；版本 0.3.0 | **30/30 passed** |

## 第六轮：新增 CogVideoX-3 视频生成

| # | 检查项 | 发现 | 修复 | 回归 |
| --- | --- | --- | --- | --- |
| 1 | CogVideoX-3 能力边界 | 官方是文生视频/单图生视频/首尾帧，不是图片生成；`prompt` ≤512，`image_url` 与 `prompt` 至少一个 | 新增 `generate_video_cogvideo`，description 明确“视频不是图片”；纯静态图仍指向 GLM-Image | schema + 文生/单图/双图测试 |
| 2 | 异步任务复用 | 新模型也走 `/videos/generations` + `/async-result/{id}`，不应复制一套不一致的轮询 | `createCogVideoTask` / `generateCogVideo` 复用 `pollAsync` 与 `normalizeSuccess`；`check_zhipu_task` 同步支持 | 轮询成功、FAIL、wait=false、check 复用 |
| 3 | 首尾帧参数形态 | 1 张图要传字符串，2 张图要传数组；传错会被 API 拒绝 | `createCogVideoTask` 根据数量组装 `image_url`；工具层限制最多 2 张 | 单图字符串 / 双图数组断言 |
| 4 | 空输入与长度 | 官方允许“只有图、没有 prompt”，但两者不能都空；prompt 上限 512 | 本地先判空并拒绝，不发请求；超长截断并写 `warning` | 空输入不发请求 / 512 截断测试 |
| 5 | 时长与模型选项 | CogVideoX-3 仅 5/10 秒，fps 30/60，quality speed/quality | 工具 schema 枚举 + execute 本地校验；`timeoutMs:600_000`，轮询上限 540 秒 | 非法 duration 本地拒绝；39/39 |
| 6 | 视频链接安全 | 视频 URL 可能是临时 HTTP/HTTPS 链接；封面必须能进 markdown | 复用 `renderVideoRef`：只暴露 HTTPS 视频，封面走 `markdownImage`，非 HTTPS 隐藏并 warning | 代码复核 + check 视频结果测试 |

**真实调用**：`202611211730075ab16f9d87f44366` 提交后约 1 分钟返回 SUCCESS；生成 5 秒、1280×720、16:9 视频，封面为 HTTPS PNG，视频 URL 为 HTTPS MP4（约 1 天有效）。

## 安装期补充

- **工具 schema 不会随源码热更新。** 修好 GLM-4-Voice 的 PCM 封装并更新 `generate_voice` description 后，Host 仍暴露旧描述（“取返回的 base64 WAV”）。执行 `remove_bundle` → `install_bundle`（v0.1.1）后，`cordis_inspect_query` 的 `Tool.listTools` 才显示新描述；6 个工具均重新注册。部署时若改了 description/parameters，必须重新安装，不能假设 HMR 会更新工具 schema。
- **加入 Client 后同样要重装。** v0.2.0 增加 `client.js`、`exports["./client"]` 与 `dsh.client` 后，再次 `remove_bundle` → `install_bundle`；Host 推送 7 个工具，`sidebar.panellist` 与 `main` 的 `breeze` occupant 均为 active。直接刷新浏览器不一定加载新的 Client bundle。
- **移除工具也必须重装。** v0.3.0 删除 `generate_voice` 后，`remove_bundle` → `install_bundle`，Host 只推送 6 个工具；`generate_voice` 不再出现在工具 schema 中，Breeze 的 `sidebar.panellist` / `main` 注册仍 active。只改源码不重装时，模型仍会看到旧的 7 工具 schema。
- **新增异步工具同样要重装。** v0.4.0 加回 Breeze 并新增 `generate_video_cogvideo` 后，再次 `remove_bundle` → `install_bundle`；Host 推送 7 个工具，CogVideoX-3 schema 可见，Breeze 的 `sidebar.panellist` / `main` occupant 均 active。

## 未关闭的限制（已写入 README）

1. **真实 API 只覆盖了部分链路。** `chat_char`、`generate_image_glm`、Breeze、CogVideoX-3（5 秒 1280×720）已实测；Vidu2、CharGLM-4 专属端点尚未成功调用。离线 mock 不能替代账号侧的模型权限/计费/内容审核行为；CogVideoX-3 单次 5 秒生成约 1 元。
2. **CharGLM-4 v4 端点未经官方确认。** 默认按通用 `/chat/completions` + `charglm-4` 实现，失败才降级；如果账号返回 404/模型不存在，会得到带 `degraded` 的 GLM-4-Flash 文本，而不是 CharGLM 原生行为。
3. **Vidu2 是视频模型。** `generate_image_vidu` 名称保留用户指定叫法，但实际返回视频+封面；纯静态图必须用 `generate_image_glm`。Vidu 视频 URL 官方仅 1 天有效，GLM 图片约 30 天。
4. **DSH 工具卡片不渲染 Markdown。** 图片依赖模型把 `markdown_image` 原样放进回复正文；若模型加了代码块/转义，图片不会显示。插件无法强制模型行为，只能在 description 和 render 里提示。
5. **对话内没有音频内容块。** DSH `ContentBlock` 只有 text/image；Breeze 给 `/zhipu/breeze/audio/...` 链接，不能在工具卡片内嵌播放器；Breeze 侧边栏页面有独立 `<audio>` 播放器。
6. **未做 durable 转存。** 图片/视频仍用智谱临时 URL；没有下载到本地或 attachments，过期后链接失效。
7. **Vidu `duration` 未本地校验。** 目前交给 API 校验；非法值会以 4xx 文本返回，不影响插件加载。
8. **依赖账号权限。** 即使 key 正确，具体模型（`glm-image`、`vidu2-*`、`charglm-4`）仍需账号开通；未开通时返回的是 API 错误文本，不是插件崩溃。
9. **Breeze 依赖本机部署。** 默认路径是 `D:\DeepSeek work\Breeze-TTS-2.cpp`；换机器/换目录要设 `BREEZE_HOME` 或 `BREEZE_EXE`/`BREEZE_MODEL`。首次加载 Q8_0 模型约需几十秒；自动启动失败时工具会给出路径/超时错误，不会静默挂起。
