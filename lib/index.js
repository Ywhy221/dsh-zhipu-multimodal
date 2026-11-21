/**
 * dsh-zhipu-multimodal — host-only DSH tool bundle.
 *
 * Registers six model-facing tools. Registration is pure and synchronous; no
 * network request, credential read, or filesystem access happens during
 * apply(), so a missing key or an unreachable voice endpoint can never stop
 * the plugin from loading.
 */
import { tools } from './tools.js'
import { BREEZE_ROUTE_PREFIX, createBreezeHandler } from './breeze-route.js'

export const name = 'dsh-zhipu-multimodal'
export const inject = ['tools']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  for (const tool of tools) {
    ctx.tools.register(tool)
  }

  // The Breeze sidebar needs same-origin routes. Headless compositions have no
  // webServer, so this stays optional and never prevents tool registration.
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const unregister = webCtx.webServer.register({
        kind: 'prefix',
        path: BREEZE_ROUTE_PREFIX,
        handler: createBreezeHandler(),
      })
      return () => unregister()
    }, 'dsh-zhipu-multimodal: /zhipu/breeze routes')
  })
}
