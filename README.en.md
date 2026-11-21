# dsh-zhipu-multimodal

[中文](README.md) | English

A DSH bundle that registers Zhipu **GLM-Image**, **Vidu2**, **CogVideoX-3**, and **CharGLM-4** as tools, and connects a locally deployed **Breeze-TTS-2** as a tool plus a **Voice** page in the sidebar. Every network or process failure is turned into a model-readable result, so an unavailable provider never prevents the plugin from loading.

## Tools and models

| Tool | Model | Capability | Sync/Async | Main output |
| --- | --- | --- | --- | --- |
| `generate_image_glm` | `glm-image` | Text to image | Sync | `markdown_image` (HTTPS image URL) |
| `generate_image_vidu` | `vidu2-image` | **Image to video** (one reference image) | Async, polls inside the tool by default | Video cover `markdown_image` + `video_url` |
| `generate_video_vidu` | `vidu2-image` / `vidu2-reference` / `vidu2-start-end` | Image to video / reference images / first-last frames | Async, polls by default | Video cover + video URL |
| `generate_video_cogvideo` | `cogvideox-3` | **Text to video / one image / first-last frames** | Async, polls by default | Video cover `markdown_image` + `video_url` |
| `chat_char` | `charglm-4` (falls back to `glm-4-flash`) | Character/persona chat | Sync | Plain text `text` |
| `generate_voice_breeze` | **local Breeze-TTS-2** | Local text to speech | Sync (first call may wait for model load) | `/zhipu/breeze/audio/...` playback link + `transcript` |
| `check_zhipu_task` | Generic async query | Query Vidu2 / CogVideoX-3 / async image tasks | Sync | Status; on success, markdown is generated automatically |

### Five capability boundaries

1. **Vidu2 is officially image-to-video, not text-to-image.** `vidu2-image` requires an `image_url`; `generate_image_vidu` returns "video + cover image" despite the name. For a still image, use `generate_image_glm`.
2. **No confirmed dedicated v4 endpoint exists for CharGLM-4.** By default the plugin calls `${ZHIPU_BASE_URL}/chat/completions` with `charglm-4` and writes `system_role` into `meta.bot_info`. A 404/422 or model-related 400 falls back to `glm-4-flash`, moving the persona into the system message and setting `degraded=true`. If your account has a dedicated endpoint, override it with `ZHIPU_CHAR_ENDPOINT`.
3. **Breeze is a local service, not a Zhipu API.** It does not need `ZHIPU_API_KEY` and text never leaves the machine. It requires Breeze-TTS-2.cpp, `breeze-server.exe`, and the GGUF model locally. The default address is `http://127.0.0.1:8080`; the first model load can take tens of seconds.
4. **Breeze WAV files use a streaming header.** Its `RIFF`/`data` length fields are written as `0xFFFFFFFF`; the plugin rewrites them to real lengths before saving or returning audio, otherwise players treat the file as corrupt.
5. **CogVideoX-3 generates video, not images.** It accepts text only, one first-frame image, or exactly two first/last-frame images. `prompt` is limited to 512 characters, and at least one of `prompt`/`image_url` is required. Video URLs expire in about one day; the cover is converted to `markdown_image`, while the video itself can only be shown as a link.

### Why cloud voice was removed

Starting with v0.3.0 the plugin no longer registers `generate_voice` (GLM-4-Voice → GLM-TTS):

- **GLM-4-Voice is not pure TTS.** It is a speech conversation model; official examples require `input_audio`. A text-only request was rejected with `HTTP 400`, and this plugin has no microphone/audio-input path, so keeping it would mean keeping an unusable tool.
- **GLM-TTS overlaps with Breeze.** Both do text to speech; local Breeze already works, costs no API fee, and supports voice design, while the GLM-TTS account returned `HTTP 429 insufficient balance`.
- If speech conversation is needed later, build audio input plus multi-turn sessions as a separate feature rather than mixing it into a TTS tool.

## Extending: adding another model

Models are not hard-coded into the registrar. Tools are declared with `defineTool` in `lib/tools.js`, network calls live in `lib/api.js`, and registration happens only in `lib/index.js`. A new model normally takes five steps:

1. **Add an API function in `lib/api.js`.**
   - Define the model ID as a constant and call `requestJson`.
   - Validate input (length, enums, URL scheme) locally and throw a readable `ZhipuError` on failure.
   - For async models, add `createXxxTask` + `generateXxx`; reuse `pollAsync(...)` for polling and normalize successful results into the existing `image`/`video`/`text` shapes where possible.
2. **Add a `defineTool` in `lib/tools.js`.**
   - Provide `name`, `description`, `parameters`, `output.schema`, and `execute`.
   - Prefer `resultOk`/`resultFail`; use `markdownImage(...)` for `markdown_image`; return `task_id`/`status` for async work.
   - The description must state the output type, whether it is async, and that `markdown_image` must be pasted verbatim into the reply.
3. **Register it in the `tools` array in `lib/index.js`.** The loop calls `ctx.tools.register`.
4. **Add mock-fetch tests in `test/selfcheck.mjs`.** Cover success, 4xx, timeout, and invalid input; run `npm run check`.
5. **Install and verify.** Use `plugin_manager remove_bundle` + `install_bundle`, refresh the GUI, and confirm the Host schema. After changing a description or parameters, a reinstall is required; HMR alone may keep the old schema.

For a local or non-Zhipu model, create a separate adapter (see `lib/breeze.js`) and make its base URL, credentials, and paths environment variables. A failure should affect only that tool; `apply()` must not throw. If a UI is needed, add a `client.js` slot (see `sidebar.panellist` + `main`), and expose Host routes through `ctx.inject(['webServer'])`.

## One-sentence Breeze usage

Ask the model in chat:

```text
Use Breeze to say: Welcome back. You worked hard today.
```

The corresponding tool call:

```text
generate_voice_breeze({
  prompt: "Welcome back. You worked hard today.",
  instruction: "gentle, clear, slightly slow",
  seed: 42
})
```

On success the result has `kind: "voice"`:

```json
{
  "markdown_audio": "[Play/download voice](/zhipu/breeze/audio/breeze-....wav)",
  "audio_path": "C:\\Users\\...\\.dsh\\cache\\zhipu-multimodal\\breeze\\breeze-....wav"
}
```

Paste `markdown_audio` verbatim into the reply to play or download it. DSH has no audio content block, so `<audio>` cannot be embedded in a tool card; only the sidebar page has a real player.

## Sidebar "Voice" page

After installing v0.4.0, the left navigation shows a microphone entry named **Voice** (`sidebar.panellist`, `id: "breeze"`). It opens a dedicated main panel:

- Text input, voice/instruction, optional voice ID, and seed.
- A **Generate voice** button; disabled while generating, auto-plays when finished.
- A **Start local service** button when the service is offline.
- All requests go through same-origin Host routes instead of cross-origin calls to Breeze.

Host routes (registered in `lib/index.js`, implemented in `lib/breeze-route.js`):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/zhipu/breeze/status` | Probe `/health`; **does not** auto-start |
| `POST` | `/zhipu/breeze/start` | Explicitly start and wait for model load |
| `POST` | `/zhipu/breeze/speech` | JSON `{text,instruction,voice,seed,cfg_scale}` → corrected `audio/wav` |
| `GET` | `/zhipu/breeze/audio/<name>` | Serve only `.wav` files from the plugin cache; blocks traversal |

Routes accept only same-origin `Origin` requests. A headless composition without `webServer` skips routes and still registers tools.

## How images actually appear in replies

DSH tool-result cards render plain text; they **do not** load Markdown inside tool output as images. Only Markdown in the assistant's reply is rendered. This plugin therefore uses the fallback requested by the user:

- `output.render` returns text whose first line is a paste-ready `![alt](https://...)`, exposed as `output.markdown_image`.
- Tool descriptions explicitly tell the model: **put `markdown_image` verbatim into the reply body, on its own line, with no code block, backticks, escaping, or URL rewriting**.
- The tool card shows that text, not the image; this is how DSH currently renders tool output.

Security constraint: only `https:` and `data:image/(png|jpeg|webp|gif);base64,...` are accepted. Non-HTTPS URLs, URLs with credentials, overly long URLs, and oversized data URLs (> 6,000,000 characters) are rejected or hidden and recorded in `warning`. Temporary image URLs usually last about 30 days; save them promptly.

## Authentication

### Zhipu

The key is read only from the runtime and is never written to code, schemas, logs, or results:

1. Environment variable `ZHIPU_API_KEY`;
2. or a line `ZHIPU_API_KEY=...` in `~/.glm/.env` (`export` and quotes are accepted).

When missing, tools return:

```text
未找到 ZHIPU_API_KEY。请设置环境变量 ZHIPU_API_KEY，或在 ~/.glm/.env 中写入一行 ...
```

No Host restart is needed after setting it; the next tool call re-reads it. This machine has verified `chat_char` and `generate_image_glm` with a real key.

### Breeze

Breeze has no authentication and listens only on the loopback address; `generate_voice_breeze` does not need `ZHIPU_API_KEY`. Auto-start uses the local executable and model; configure them with `BREEZE_HOME` / `BREEZE_EXE` / `BREEZE_MODEL`.

## Install and update

This machine has installed the bundle into the desktop profile:

```text
plugin_manager action:install_bundle target:"D:\\DeepSeek work\\dsh-zhipu-multimodal"
```

The verified version is **0.4.0**. The bundle entry is `lib/index.js`; `apply(ctx)` registers seven tools and mounts `/zhipu/breeze` routes. `client.js` loads the sidebar page through `dsh.client` / `exports["./client"]`.

**After changing a description, parameters, or the client entry, do not rely on hot reload alone.** On this machine the Host kept the old tool schema. Use:

```text
plugin_manager action:remove_bundle target:"dsh-zhipu-multimodal"
plugin_manager action:install_bundle target:"D:\\DeepSeek work\\dsh-zhipu-multimodal"
```

Then refresh the GUI. Do not hand-write the profile's `package.json` / `cordis.patch.yml`, and do not run pnpm in the profile.

## Async usage

Vidu2 polls inside the tool by default (`timeout_seconds` defaults to 120, max 180; total tool timeout 240 seconds). CogVideoX-3 waits 300 seconds by default, max 540 seconds, with a 600-second tool timeout. Five- and ten-second videos use the same async task lookup. For long jobs:

```text
generate_video_cogvideo({ prompt: "A cat jumping on the moon", wait: false })
→ { task_id: "..." }

check_zhipu_task({ task_id: "..." })
→ PROCESSING means keep waiting; SUCCESS returns cover markdown_image / video_url
```

Vidu2 supports the same `wait: false` and lookup. A timeout does not lose the task: the tool returns `ok: false`, `kind: "task"`, `task_id`, and `status: "PROCESSING"` (render shows "call failed", but the note says the task is still running server-side) and tells the model to keep querying rather than resubmit. FAIL / CANCELED / network interruption all return a clear error plus a usable `task_id`.

## Voice: local Breeze

Since v0.3.0 only `generate_voice_breeze` remains; cloud `generate_voice` is gone for the reasons above.

- Calls Breeze's OpenAI-compatible JSON `POST /v1/audio/speech` with `response_format: "wav"`, returning 16-bit mono 24 kHz WAV.
- If the service is down, `ensureBreeze()` tries to start `breeze-server.exe` detached, without blocking the conversation loop, up to `BREEZE_START_TIMEOUT_MS`.
- Failures distinguish offline service, missing exe/model, startup timeout, 404 voice, 409 busy, non-audio response, corrupt WAV, and network errors.
- Concurrent calls share one startup Promise, so two models are never loaded simultaneously.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `ZHIPU_API_KEY` | none | Required for Zhipu; may live in `~/.glm/.env` |
| `ZHIPU_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` | Zhipu API base URL |
| `ZHIPU_CHAR_ENDPOINT` | `${base}/chat/completions` | CharGLM primary endpoint |
| `ZHIPU_CHAR_MODEL` | `charglm-4` | Character model ID |
| `ZHIPU_CHAR_FALLBACK_ENDPOINT` | `${base}/chat/completions` | Character fallback endpoint |
| `ZHIPU_CHAR_FALLBACK_MODEL` | `glm-4-flash` | Character fallback model |
| `ZHIPU_REQUEST_TIMEOUT_MS` | `60000` | Per-request JSON timeout |
| `ZHIPU_POLL_INTERVAL_MS` | `3000` | Async poll interval |
| `ZHIPU_VIDU_TIMEOUT_MS` | `180000` | Async poll total timeout |
| `BREEZE_HOME` | `D:\\DeepSeek work\\Breeze-TTS-2.cpp` | Breeze root |
| `BREEZE_BASE_URL` | `http://127.0.0.1:8080` | Breeze service address |
| `BREEZE_EXE` | `${home}\\app\\...\\breeze-server.exe` | Override executable |
| `BREEZE_MODEL` | `${home}\\models\\breeze-tts-2-q8_0.gguf` | Override model |
| `BREEZE_AUTOSTART` | `1` | `0` disables auto-start from tools/panel |
| `BREEZE_AUDIO_DIR` | `~/.dsh/cache/zhipu-multimodal/breeze` | Local WAV cache |
| `BREEZE_TIMEOUT_MS` | `180000` | Per-synthesis timeout |
| `BREEZE_START_TIMEOUT_MS` | `60000` | Cold-start wait limit |

## Tests

```powershell
cd "D:\\DeepSeek work\\dsh-zhipu-multimodal"
node --check lib/index.js
node --check lib/tools.js
node --check lib/breeze.js
node --check lib/breeze-route.js
node --check client.js
node test/selfcheck.mjs
```

Current offline self-check: **39/39 passed**. It uses mock HTTP, never reads a real key, and never touches the network. It covers seven tool schemas, missing key, GLM URL/b64/non-HTTPS, data-URL injection, Vidu success/FAIL/timeout/CANCELED/empty images/long prompt, CogVideoX-3 text/image/first-last-frame/empty input/FAIL/local-image rejection, Char normal/fallback/auth/history, Breeze synthesis/WAV length correction/long text/offline errors, and multi-model coexistence.

### Real-call log

- `chat_char`: success, returned "已连通。我是一个语言模型。"
- `generate_image_glm`: generated a 1280×1280 image and returned an HTTPS URL.
- `generate_voice_breeze`: local Breeze service running; generated a 169,004-byte WAV in 1.87 s; `RIFF`/`WAVE`, 24 kHz, mono, 16-bit, and length fields are correct.
- `generate_video_cogvideo`: submitted task `202611211730075ab16f9d87f44366`; `SUCCESS` in about one minute; generated a 5-second, 1280×720, 16:9 video with HTTPS cover and MP4 links.

**Not verified against the real API**: Vidu2 and a dedicated CharGLM-4 endpoint. They require the corresponding model/quota; offline mocks cannot replace account permissions or billing checks.

## Layout

```text
lib/index.js        Plugin entry: name / inject / apply / Breeze routes
lib/tools.js        Seven tool definitions and execute functions
lib/schema.js       Local defineTool compatibility layer, output.schema, render
lib/api.js          GLM-Image / Vidu2 / CogVideoX-3 / CharGLM API
lib/http.js         Bearer requests, error normalization, async polling
lib/config.js       Zhipu environment variables and ~/.glm/.env reader
lib/format.js       Markdown images/links, size validation, truncation
lib/breeze.js       Local Breeze health check, auto-start, WAV correction
lib/breeze-route.js Same-origin /zhipu/breeze routes
client.js           "Voice" sidebar page (sidebar.panellist + main)
test/selfcheck.mjs  Offline regression tests
```
