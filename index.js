/**
 * dsh-dock-attention — a Host plugin for DeepSeek Harness.
 *
 * Watches the durable session event feed and, when the agent needs the user and
 * the Harness window is not frontmost, bounces a Dock icon through the bundled
 * native "DSH Attention" beacon app. It never writes to the session log and never
 * talks to the model.
 *
 * Why a native helper: Electron's Dock APIs (`app.dock.bounce()`) live in the
 * Desktop main process; a Host plugin runs in a separate Node child process and
 * cannot reach them. The beacon owns a Dock tile of its own, appears only while
 * attention is pending, and disappears when the user comes back or clicks it.
 */
import { attentionKind, describeSession, isKindEnabled, isRootSession, normalizeConfig, raiseAttention } from './lib/attention.js'

const STATE_TITLES_LIMIT = 512

/**
 * Mount Dock attention on the Host context.
 * @param ctx - the Cordis context of this plugin row.
 * @param config - the row's `config` mapping; unknown fields are ignored.
 * @param deps - test seam: optional overrides of the native attention primitive.
 */
export function apply(ctx, config, deps = {}) {
  if (process.platform !== 'darwin') return

  const options = normalizeConfig(config)
  if (!options.enabled) return

  const raise = typeof deps.raiseAttention === 'function' ? deps.raiseAttention : raiseAttention
  const titles = new Map()
  let lastAttentionAt = 0

  ctx.on('session/event', (session, event) => {
    if (!isRootSession(session, options)) return

    if (event.type === 'session/title') {
      const title = event.data?.title
      if (typeof title === 'string' && title.trim().length > 0) {
        titles.set(session.id, title.trim())
        if (titles.size > STATE_TITLES_LIMIT) titles.delete(titles.keys().next().value)
      }
      return
    }

    const kind = attentionKind(event)
    if (kind === null || !isKindEnabled(kind, options)) return

    const now = Date.now()
    if (now - lastAttentionAt < options.minIntervalSeconds * 1000) return
    lastAttentionAt = now

    void attend(kind, describeSession(session, titles))
  })

  ctx.on('session/disposed', (session) => {
    titles.delete(session.id)
  })

  async function attend(kind, label) {
    try {
      const detail = label.length > 0 ? ` · ${label}` : ''
      const result = await raise(options, {
        log: (message) => ctx.logger?.info?.(`dock-attention: ${message}`),
      })
      if (result.action === 'beacon') {
        ctx.logger?.info?.(`dock-attention: ${kind}${detail} (front: ${result.frontBundleId || 'unknown'})`)
      }
    } catch (error) {
      ctx.logger?.warn?.(`dock-attention: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
