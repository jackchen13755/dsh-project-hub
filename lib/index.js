/**
 * dsh-project-hub —— 宿主半边。
 *
 * 装配：SQLite 台账（事实源）→ agent 工具面（`ph_*`）→ HTTP 路由（面板/CLI）→ 心跳式会话扫描。
 *
 * 三条纪律（来自本机插件生态的实测教训）：
 *   1. **定时器用 Node 原生 + `ctx.effect` 收尾 + `unref`**：直接 `ctx.setInterval` 会因
 *      未 inject `timer` 服务抛 `cannot get property "timer" without inject`，整个 entry 加载失败；
 *      节拍靠 DB meta 的 `last_scan_at` 比对 interval，重启不丢拍；
 *   2. **服务读取一律 `ctx.inject([...], cb)` + 按属性读**（`ctx.get` 对未 inject 的服务会抛）；
 *   3. **任何可选服务缺席都只降级、不抛**：headless/无 webServer 时插件照常提供工具。
 */
import { existsSync, readFileSync } from 'node:fs'
import { installApi } from './api.js'
import { Store } from './store.js'
import { buildTools } from './tools.js'
import { getMeta, setMeta } from './db.js'
import { dataDir, dshHome, ensureDir } from './paths.js'

export const name = 'project-hub'
export const version = '0.1.0'
export const inject = ['tools']

export { Store } from './store.js'
export { buildTools } from './tools.js'
export { installApi } from './api.js'
export { frameRanges, decompressMultiFrame, summarizeSession, findSessionFiles, extractRequirementTokens } from './session-scan.js'
export { resolveDocTitle, stripSiteSuffix, titleFromHtml, titleFromText } from './doc-title.js'
export { discoverWorkspaceProjects, projectFromCwd, readGitRemote, decodeMangledCwd } from './projects.js'
export { readWorkspaceRegistry, readProjectCaches, projectCandidatesFrom } from './workspace.js'
export { deriveRequirementId, projectIdFromCwd, dateInTz, slugify, dbPath, dataDir } from './paths.js'
export { LOG_KINDS, REQ_STATUSES } from './store.js'

const DEFAULT_SCAN_INTERVAL_MINUTES = 30

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** `$DSH_HOME/profiles/web/package.json` 里的本插件版本（面板状态行显示用）。 */
function installedVersion(config = {}) {
  if (config.version) return String(config.version)
  try {
    const file = `${dshHome()}/profiles/web/node_modules/dsh-project-hub/package.json`
    const doc = readJson(file)
    if (doc?.version) return String(doc.version)
  } catch {
    /* 忽略 */
  }
  return version
}

export function apply(ctx, config = {}) {
  const scanCfg = { intervalMinutes: DEFAULT_SCAN_INTERVAL_MINUTES, limit: 300, minDigits: 3, weakMinHits: 2, ...(config.scan ?? {}) }
  const opened = Store.open({ tz: config.tz ?? 'Asia/Shanghai', scan: scanCfg, docTimeoutMs: config.docTimeoutMs }, process.env)
  if (!opened.store) {
    console.warn(`[project-hub] 台账库打开失败，插件进入空转（不影响宿主）：${opened.error}`)
    return
  }
  const store = opened.store
  const state = { store, tools: [], api: null, sessions: null, scans: 0, lastError: null }

  if (config.verbose) {
    console.log(`[project-hub] 台账库 ${store.dbPath}（schema v${getMeta(store.db, 'schema_version', 0)}，数据目录 ${dataDir()}）`)
  }

  // 每日备份（在线、一致；失败只告警）
  if (config.backup?.enabled !== false) {
    try {
      const today = new Date().toISOString().slice(0, 10)
      if (getMeta(store.db, 'last_backup_day', '') !== today) {
        const res = store.backup({ keep: config.backup?.keep ?? 7 })
        setMeta(store.db, 'last_backup_day', today)
        if (config.verbose) console.log(`[project-hub] 已备份台账 → ${res.file}（${Math.round(res.bytes / 1024)}KB）`)
      }
    } catch (error) {
      console.warn(`[project-hub] 备份失败（忽略）：${error.message}`)
    }
  }

  // ── 会话服务（只用于「按 sessionId 反查 cwd」，缺席则候选退化为注册表/缓存/库内）──
  try {
    ctx.inject(['sessions'], (scoped) => {
      state.sessions = scoped.sessions ?? scoped.get?.('sessions') ?? null
    })
  } catch {
    /* headless 等场景：忽略 */
  }
  const getSessionCwd = (sessionId) => {
    if (!sessionId || !state.sessions) return null
    try {
      const list = state.sessions.list?.() ?? []
      const hit = list.find((s) => (s?.id ?? s?.header?.id) === sessionId)
      return hit?.header?.cwd ?? null
    } catch {
      return null
    }
  }

  // ── 工作区注册表（「开新会话」要用：客户端只能按 workspaceId 建会话，
  //     所以「在任意项目目录里开会话」必须先由宿主把这个目录登记成 workspace）──
  try {
    ctx.inject(['workspaceRegistry'], (scoped) => {
      state.workspaceRegistry =
        scoped.workspaceRegistry ?? (typeof scoped.get === 'function' ? scoped.get('workspaceRegistry') : null) ?? null
    })
  } catch {
    /* 服务缺席：开新会话退化成「复制简报」 */
  }

  const ensureWorkspace = async (path, title) => {
    const registry = state.workspaceRegistry
    if (!registry) return null
    const norm = (value) => (value === null || value === undefined ? null : String(value))
    const list = typeof registry.list === 'function' ? registry.list() ?? [] : []
    const hit = list.find((item) => norm(item?.path) === norm(path))
    if (hit) return { id: hit.id ?? hit.key ?? null, path: hit.path ?? path, title: hit.title ?? title ?? null, created: false }
    if (typeof registry.create !== 'function') return null
    const created = await registry.create(path, title ?? undefined)
    return {
      id: created?.id ?? created?.key ?? null,
      path: created?.path ?? path,
      title: created?.title ?? title ?? null,
      created: true,
    }
  }

  // ── HTTP 路由（web-only；无 webServer 时自动跳过）────────────────────
  state.api = installApi(ctx, {
    store,
    config,
    version: installedVersion(config),
    scanIntervalMinutes: scanCfg.intervalMinutes,
    getSessionCwd,
    ensureWorkspace,
  })
  if (!state.api.installed && config.verbose) {
    console.warn(`[project-hub] HTTP 路由未注册（${state.api.error ?? '本 profile 无 webServer'}）：工具面不受影响`)
  }

  // ── agent 工具面 ────────────────────────────────────────────────────
  const registerTools = (toolsCtx) => {
    const registry = toolsCtx.tools ?? toolsCtx.get?.('tools')
    if (!registry?.register) {
      console.warn('[project-hub] 宿主未提供 tools.register，跳过工具注册')
      return
    }
    const disposers = []
    for (const def of buildTools({ store, config, version: installedVersion(config) })) {
      try {
        disposers.push(registry.register(def))
        state.tools.push(def.name)
      } catch (error) {
        // 幂等：宿主把插件装配两次时同名工具会抛 already registered
        if (!String(error?.message ?? '').includes('already registered')) {
          console.warn(`[project-hub] 工具 ${def.name} 注册失败：${error.message}`)
        }
      }
    }
    if (config.verbose) console.log(`[project-hub] 已注册工具 ${state.tools.length} 个：${state.tools.join(', ')}`)
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  try {
    ctx.inject(['tools'], registerTools)
  } catch (error) {
    console.warn(`[project-hub] tools 注入失败（忽略）：${error.message}`)
  }

  // ── 心跳式定期扫描（R5）────────────────────────────────────────────
  if (scanCfg.enabled !== false) {
    const intervalMs = Math.max(1, Number(scanCfg.intervalMinutes) || DEFAULT_SCAN_INTERVAL_MINUTES) * 60000
    let running = false
    const tick = async () => {
      if (running) return
      const last = Number(getMeta(store.db, 'last_scan_at', 0)) || 0
      if (Date.now() - last < intervalMs) return
      running = true
      try {
        const res = await store.scanSessions({ limit: scanCfg.limit })
        state.scans += 1
        if (res.changed > 0 || config.verbose) {
          console.log(
            `[project-hub] 会话扫描完成：${res.changed} 个会话变更 / 跳过 ${res.skipped} / 新增开发记录 ${res.logs} 条 / 覆盖 ${res.days.length} 天`,
          )
        }
      } catch (error) {
        state.lastError = error?.message ?? String(error)
        console.warn(`[project-hub] 会话扫描失败（忽略）：${state.lastError}`)
      } finally {
        running = false
      }
    }
    ctx.effect(() => {
      const timer = setInterval(() => void tick(), 60000)
      timer.unref?.()
      // 首次进驻：20 秒后补一拍（用户不用等到第一个 30 分钟窗口）
      const boot = setTimeout(() => void tick(), 20000)
      boot.unref?.()
      return () => {
        clearInterval(timer)
        clearTimeout(boot)
      }
    }, 'dsh-project-hub: session scan heartbeat')
  }

  ctx.effect(() => () => {
    try {
      store.close()
    } catch {
      /* 忽略 */
    }
  }, 'dsh-project-hub: close db')

  if (config.verbose) console.log(`[project-hub] 就绪：${Object.keys(store.counts()).length} 项计数 / 工具 ${state.tools.length} 个`)
  return state
}

/** 供测试/CLI 复用：不带 cordis 上下文也能起一个台账。 */
export function openStore(config = {}) {
  return Store.open({ tz: config.tz ?? 'Asia/Shanghai', scan: config.scan ?? {}, docTimeoutMs: config.docTimeoutMs }, process.env)
}

export { ensureDir }
export default apply
