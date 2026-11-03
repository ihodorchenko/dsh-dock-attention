/**
 * Platform primitives for the dsh-dock-attention plugin.
 *
 * The plugin itself only decides *when* attention is needed; this module owns the
 * macOS mechanics: probe who is in front, write the beacon request, launch the
 * bundled native beacon app. Everything here is side-effect free except the
 * explicit `probe`, `launchBeacon` and `playSound` functions, which keeps the
 * decision logic testable on any machine.
 */
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

/** Package root: `<pkg>/lib/attention.js` -> `<pkg>` */
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

export const BEACON_BUNDLE_ID = 'dev.dsh.dock-attention.beacon'
/** The helper shipped inside the plugin package; this is the build artifact source. */
export const HELPER_BUNDLE = join(PACKAGE_ROOT, 'bin', 'DSH Attention.app')
/** Backwards-compatible alias for the shipped helper bundle. */
export const HELPER_APP = HELPER_BUNDLE
export const HELPER_EXECUTABLE = join(HELPER_BUNDLE, 'Contents', 'MacOS', 'dsh-attention')

/**
 * The beacon runs from a stable, user-visible location instead of the plugin
 * package (which may live inside `node_modules` under a hidden directory). The
 * Dock tile must belong to an ordinary, LaunchServices-registered app bundle:
 * a copy launched straight out of a package directory is ambiguous with every
 * other copy of the same bundle id, and macOS can turn a click on it into a
 * Finder window instead of an activation.
 */
export const HELPER_INSTALL_DIR = join(homedir(), 'Library', 'Application Support', 'dsh-dock-attention')
export const INSTALLED_HELPER_APP = join(HELPER_INSTALL_DIR, 'DSH Attention.app')
export const INSTALLED_HELPER_EXECUTABLE = join(INSTALLED_HELPER_APP, 'Contents', 'MacOS', 'dsh-attention')
const INSTALL_MARKER = join(HELPER_INSTALL_DIR, 'installed.sha256')
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister'

/**
 * Request and log files live next to the installed helper, not in the plugin
 * package: the package directory may be read-only or hidden, while this location
 * is always writable and is what the helper resolves when it is started without
 * explicit `--request` / `--log` arguments.
 */
export const RUNTIME_DIR = join(HELPER_INSTALL_DIR, 'runtime')
export const REQUEST_PATH = join(RUNTIME_DIR, 'request.json')
export const HELPER_LOG_PATH = join(RUNTIME_DIR, 'helper.log')

export const QUESTION_TOOLS = new Set(['ask_user_question', 'exit_plan_mode'])
export const ROOT_ACTIVE_BUNDLE = 'com.deepseek.dsh'
export const SYSTEM_SOUND_DIR = '/System/Library/Sounds'

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  /** Dock icon of the DeepSeek Harness Desktop app; change it when running `dsh web` in a browser. */
  targetBundleId: ROOT_ACTIVE_BUNDLE,
  /** Foreground apps that count as "the user is already looking at Harness". */
  activeBundleIds: [ROOT_ACTIVE_BUNDLE],
  /** Never ring the bell while one of `activeBundleIds` is frontmost. */
  skipWhenActive: true,
  /** Bounce when the agent waits for an approval decision. */
  bounceOnApproval: true,
  /** Bounce when the agent asks a question (`ask_user_question`, `exit_plan_mode`). */
  bounceOnQuestion: true,
  /** Bounce when a turn finishes, fails, or is blocked. */
  bounceOnTurnEnd: true,
  /** Subagent sessions stay silent by default; only the sessions you see can ring. */
  includeSubagents: false,
  /** `critical` bounces until the user comes back (or the timeout), `informational` bounces once. */
  mode: 'critical',
  /** Informational mode: how many single bounces to ask for. */
  repeatCount: 3,
  /** How long the beacon tile may live, in seconds. */
  timeoutSeconds: 30,
  /** Ignore attention events that arrive within this many seconds of the previous bounce. */
  minIntervalSeconds: 3,
  /** macOS system sound name (`Glass`) or an absolute path to an audio file; `null` is silent. */
  sound: null,
  /** Opened by the beacon if `targetBundleId` is not installed (the Desktop app answers `dsh://open`). */
  openUrl: 'dsh://open',
})

const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SOUND_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]{0,63}$/

/**
 * Merge a user config over the defaults, dropping values the beacon cannot honor.
 * Every field is optional in the patch file, so unknown or malformed values fall
 * back to a working default instead of breaking the plugin row.
 */
export function normalizeConfig(raw) {
  const config = { ...DEFAULT_CONFIG, activeBundleIds: [...DEFAULT_CONFIG.activeBundleIds] }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return config

  for (const key of ['enabled', 'skipWhenActive', 'bounceOnApproval', 'bounceOnQuestion', 'bounceOnTurnEnd', 'includeSubagents']) {
    if (typeof raw[key] === 'boolean') config[key] = raw[key]
  }
  if (typeof raw.targetBundleId === 'string' && BUNDLE_ID_PATTERN.test(raw.targetBundleId.trim())) {
    config.targetBundleId = raw.targetBundleId.trim()
  }
  if (Array.isArray(raw.activeBundleIds)) {
    const ids = raw.activeBundleIds
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => BUNDLE_ID_PATTERN.test(value))
    if (ids.length > 0) config.activeBundleIds = [...new Set(ids)]
  }
  if (raw.mode === 'critical' || raw.mode === 'informational') config.mode = raw.mode
  if (Number.isFinite(raw.repeatCount)) config.repeatCount = clamp(Math.round(raw.repeatCount), 1, 20)
  if (Number.isFinite(raw.timeoutSeconds)) config.timeoutSeconds = clamp(raw.timeoutSeconds, 3, 300)
  if (Number.isFinite(raw.minIntervalSeconds)) config.minIntervalSeconds = clamp(raw.minIntervalSeconds, 0, 120)
  if (raw.sound === null) config.sound = null
  else if (typeof raw.sound === 'string' && raw.sound.trim().length > 0) config.sound = raw.sound.trim().slice(0, 200)
  if (typeof raw.openUrl === 'string' && raw.openUrl.trim().length > 0) config.openUrl = raw.openUrl.trim().slice(0, 200)
  return config
}

/**
 * Map a durable session event to an attention kind, or `null` when the event is
 * not something the user must react to.
 * @returns {'approval' | 'question' | 'turn' | 'error' | 'blocked' | 'max-tokens' | null}
 */
export function attentionKind(event) {
  if (event === null || typeof event !== 'object') return null
  if (event.type === 'approval/asked') return 'approval'
  if (event.type === 'tool/call') {
    const name = event.data?.name
    return typeof name === 'string' && QUESTION_TOOLS.has(name) ? 'question' : null
  }
  if (event.type === 'turn/end') {
    const kind = event.data?.reason?.kind
    // User-cancelled, forked and interrupted turns are not "come back" moments.
    if (kind === 'aborted' || kind === 'forked' || kind === 'interrupted') return null
    if (kind === 'error' || kind === 'blocked' || kind === 'max-tokens') return kind
    return 'turn'
  }
  return null
}

/** Whether the normalized config asks the beacon for this attention kind. */
export function isKindEnabled(kind, config) {
  switch (kind) {
    case 'approval':
      return config.bounceOnApproval
    case 'question':
      return config.bounceOnQuestion
    case 'turn':
    case 'error':
    case 'blocked':
    case 'max-tokens':
      return config.bounceOnTurnEnd
    default:
      return false
  }
}

/** Root sessions only: a subagent finishing must not ring the bell. */
export function isRootSession(session, config) {
  const header = session?.header
  if (header === null || header === undefined) return false
  if (!config.includeSubagents) {
    if (header.origin === 'subagent') return false
    if (header.parentSession !== null && header.parentSession !== undefined) return false
  }
  return true
}

/** Resolve `sound` to an absolute audio path, or `null` when sound is off/unknown. */
export function resolveSoundPath(sound) {
  if (typeof sound !== 'string' || sound.length === 0) return null
  if (isAbsolute(sound)) return sound
  if (!SOUND_NAME_PATTERN.test(sound)) return null
  return join(SYSTEM_SOUND_DIR, `${sound}.aiff`)
}

/** Build the JXA probe script. Bundle ids are validated before they reach the source. */
export function buildProbeScript(config) {
  const interesting = [...new Set([
    config.targetBundleId,
    ...config.activeBundleIds,
    BEACON_BUNDLE_ID,
  ])].filter((id) => BUNDLE_ID_PATTERN.test(id))

  return `
ObjC.import('AppKit')
const INTEREST = ${JSON.stringify(interesting)}
const workspace = $.NSWorkspace.sharedWorkspace
const front = workspace.frontmostApplication
const frontBundleId = front ? String(ObjC.unwrap(front.bundleIdentifier) || '') : ''
const running = []
const apps = workspace.runningApplications
for (let index = 0; index < apps.count; index += 1) {
  const app = apps.objectAtIndex(index)
  const bundleId = String(ObjC.unwrap(app.bundleIdentifier) || '')
  if (INTEREST.indexOf(bundleId) >= 0) running.push(bundleId)
}
JSON.stringify({ frontBundleId, running })`
}

/**
 * Ask NSWorkspace who is frontmost and which interesting apps are running.
 * Works without Automation/Accessibility permissions — JXA reaches AppKit directly.
 * @returns {Promise<{frontBundleId: string, running: string[]}>}
 */
export function probe(config, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', buildProbeScript(config)],
      { timeout, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        try {
          const result = JSON.parse(String(stdout).trim())
          resolve({
            frontBundleId: typeof result?.frontBundleId === 'string' ? result.frontBundleId : '',
            running: Array.isArray(result?.running) ? result.running.filter((id) => typeof id === 'string') : [],
          })
        } catch (parseError) {
          reject(parseError)
        }
      },
    )
  })
}

/** Write the beacon request atomically so a half-written file is never read. */
export function writeRequest(config) {
  mkdirSync(RUNTIME_DIR, { recursive: true })
  const payload = {
    targetBundleId: config.targetBundleId,
    mode: config.mode,
    timeoutSeconds: config.timeoutSeconds,
    repeatCount: config.repeatCount,
    openUrl: config.openUrl,
  }
  const temporary = `${REQUEST_PATH}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, REQUEST_PATH)
}

/** The app bundle must be executable regardless of how the package was unpacked. */
export function ensureHelperExecutable() {
  if (!existsSync(HELPER_EXECUTABLE)) {
    throw new Error(`beacon helper is missing: ${HELPER_EXECUTABLE} (run tools/build-helper.sh)`)
  }
  chmodSync(HELPER_EXECUTABLE, 0o755)
}

/** `sha256` of a file, used to refresh the installed helper after a plugin update. */
function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Best-effort external tool: a missing or failing tool must never break attention. */
function quietTool(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

/**
 * Copy the helper into `~/Library/Application Support/dsh-dock-attention/`, strip
 * any quarantine flag (a zip download would otherwise be App-Translocated into a
 * random read-only temp path), ad-hoc sign the copy and register it with
 * LaunchServices.
 *
 * The copy is what the Dock tile belongs to: a single stable, non-hidden app
 * bundle makes a click on the tile a plain activation. Launching the same bundle
 * id straight from `node_modules` leaves LaunchServices with several competing
 * registrations, and macOS can turn the click into a Finder reveal instead.
 * @returns {string} the app bundle to launch.
 */
export function ensureHelperInstalled() {
  if (!existsSync(HELPER_EXECUTABLE)) {
    throw new Error(`beacon helper is missing: ${HELPER_EXECUTABLE} (run tools/build-helper.sh)`)
  }

  const sourceHash = fileHash(HELPER_EXECUTABLE)
  let installedHash = ''
  try {
    installedHash = readFileSync(INSTALL_MARKER, 'utf8').trim()
  } catch {
    installedHash = ''
  }

  if (installedHash === sourceHash && existsSync(INSTALLED_HELPER_EXECUTABLE)) {
    chmodSync(INSTALLED_HELPER_EXECUTABLE, 0o755)
    return INSTALLED_HELPER_APP
  }

  mkdirSync(HELPER_INSTALL_DIR, { recursive: true })
  rmSync(INSTALLED_HELPER_APP, { recursive: true, force: true })
  cpSync(HELPER_BUNDLE, INSTALLED_HELPER_APP, { recursive: true })
  quietTool('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', INSTALLED_HELPER_APP])
  quietTool('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--identifier', BEACON_BUNDLE_ID, INSTALLED_HELPER_APP])
  quietTool(LSREGISTER, ['-f', INSTALLED_HELPER_APP])
  chmodSync(INSTALLED_HELPER_EXECUTABLE, 0o755)
  writeFileSync(INSTALL_MARKER, `${sourceHash}\n`, { mode: 0o600 })
  return INSTALLED_HELPER_APP
}

/** The installed copy when possible, the in-package bundle as a last resort. */
function resolveHelperApp() {
  try {
    return ensureHelperInstalled()
  } catch {
    ensureHelperExecutable()
    return HELPER_BUNDLE
  }
}

/**
 * Launch the beacon through LaunchServices in the background. The helper is a
 * regular app, so LaunchServices gives it a normal Dock tile; `-n` asks for a
 * fresh instance (the single-instance guard in the helper backs this up) and
 * `-g` keeps the launch from activating it, so no focus is stolen. The request
 * and log paths are passed explicitly, so the helper does not depend on where
 * its bundle happens to live.
 */
export const BEACON_LAUNCH_FLAGS = Object.freeze(['-n', '-g'])

export function launchBeacon({ timeout = 5000 } = {}) {
  const app = resolveHelperApp()
  const args = [...BEACON_LAUNCH_FLAGS, app, '--args', `--request=${REQUEST_PATH}`, `--log=${HELPER_LOG_PATH}`]
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', args, { timeout, windowsHide: true }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/** Play the configured sound, if any; failures are silent and never block attention. */
export function playSound(sound, { timeout = 5000 } = {}) {
  const path = resolveSoundPath(sound)
  if (path === null) return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile('/usr/bin/afplay', [path], { timeout, windowsHide: true }, () => resolve(true))
  })
}

/**
 * One full attention beat: probe the desktop, honor "only when inactive", write the
 * request and start the beacon. Returns a description of what happened for logs/tests.
 * @returns {Promise<{action: 'skipped-active'|'skipped-running'|'beacon', frontBundleId?: string}>}
 */
export async function raiseAttention(config, { log = () => {} } = {}) {
  let snapshot = null
  try {
    snapshot = await probe(config)
  } catch (error) {
    // Fail open: if focus cannot be determined, grab attention rather than stay silent.
    log(`probe failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (snapshot !== null) {
    if (config.skipWhenActive && config.activeBundleIds.includes(snapshot.frontBundleId)) {
      log(`skipped: ${snapshot.frontBundleId} is frontmost`)
      return { action: 'skipped-active', frontBundleId: snapshot.frontBundleId }
    }
    if (snapshot.running.includes(BEACON_BUNDLE_ID)) {
      log('skipped: a beacon is already bouncing')
      return { action: 'skipped-running', frontBundleId: snapshot.frontBundleId }
    }
  }

  writeRequest(config)
  await launchBeacon()
  void playSound(config.sound)
  return { action: 'beacon', frontBundleId: snapshot?.frontBundleId ?? '' }
}

/** Best-effort session label for diagnostics: title, then first prompt, then folder name. */
export function describeSession(session, titles) {
  const title = titles?.get(session?.id)
  if (typeof title === 'string' && title.length > 0) return title
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd.split('/').filter(Boolean).at(-1) ?? ''
  return ''
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}
