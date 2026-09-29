/**
 * 宿主 HTTP API：给侧边栏面板与 CLI 提供数据与操作。
 *
 * 注册方式（与 dsh-memory-core 同款，web-only）：
 *   `ctx.inject(['webServer'], (webCtx) => webCtx.webServer.register({ kind:'prefix', path, handler }))`
 * 同一 (kind,path) 重复注册会抛 —— 整块包在 try/catch 里，绝不阻断宿主。
 *
 * 路由表（前缀 `/project-hub/api`）见 DESIGN.md §6。统一 JSON；失败 `{ ok:false, error }`。
 */

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readBody(req, maxBytes = 512 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

const asBool = (v) => v === true || v === 'true' || v === '1'
const asNum = (v, fallback) => (v === null || v === undefined || v === '' ? fallback : Number(v))

export function installApi(ctx, deps) {
  const { store, config = {}, version = '0.0.0', scanIntervalMinutes = 30, getSessionCwd = () => null, scan = null } = deps
  const base = config.apiBase ?? '/project-hub/api'

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) || '/' : url.pathname
    const method = (req.method ?? 'GET').toUpperCase()
    const q = url.searchParams
    /** 面板可能只带 sessionId：由宿主服务换算出 cwd，用于「当前工作区项目」候选。 */
    const cwd = q.get('cwd') ?? getSessionCwd(q.get('sessionId')) ?? null

    try {
      // ── 状态 ───────────────────────────────────────────────────────────
      if (method === 'GET' && (path === '/' || path === '/status')) {
        return sendJson(res, 200, store.status({ version, scanIntervalMinutes }))
      }

      // ── 项目 ───────────────────────────────────────────────────────────
      if (method === 'GET' && (path === '/projects' || path === '/candidates')) {
        return sendJson(res, 200, {
          ok: true,
          projects: store.listProjects({ cwd, archived: q.get('archived') ?? 'exclude' }),
          candidates: store.candidateProjects(cwd),
        })
      }

      if (method === 'POST' && path === '/projects/add') {
        const body = await readBody(req)
        if (!body.name && !body.id) return sendJson(res, 400, { ok: false, error: '缺少项目 name' })
        const project = store.upsertProject({ id: body.id ?? body.name, name: body.name ?? body.id, root: body.root ?? null, aliases: body.aliases ?? null })
        return sendJson(res, 200, { ok: true, project })
      }

      if (method === 'POST' && path === '/projects/archive') {
        const body = await readBody(req)
        const res2 = store.archiveProject(body.id, body.archived !== false)
        return sendJson(res, res2.changed ? 200 : 404, { ok: Boolean(res2.changed), ...res2 })
      }

      // ── 需求台账 ───────────────────────────────────────────────────────
      if (method === 'GET' && path === '/requirements') {
        const result = store.listRequirements({
          project: q.get('project'),
          q: q.get('q'),
          status: q.get('status'),
          archived: q.get('archived') ?? 'exclude',
          limit: asNum(q.get('limit'), 50),
          offset: asNum(q.get('offset'), 0),
        })
        return sendJson(res, 200, { ok: true, ...result })
      }

      if (method === 'GET' && path === '/requirements/get') {
        const id = q.get('id')
        if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id' })
        const row = store.getRequirement(id, { project: q.get('project') })
        if (!row) return sendJson(res, 404, { ok: false, error: `没有找到需求 ${id}` })
        const requirement = store.rowToRequirement(store.requirementDetail(row.id))
        const logs = store.listLogs({ requirement: row.id, archived: 'include', limit: 50 })
        const days = store.timeline({ requirement: row.id, limit: 30 })
        return sendJson(res, 200, { ok: true, requirement, logs: logs.items, days })
      }

      if (method === 'POST' && path === '/requirements/save') {
        const body = await readBody(req)
        try {
          const res2 = await store.saveRequirement(body)
          return sendJson(res, 200, { ok: true, ...res2 })
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error?.message ?? String(error) })
        }
      }

      if (method === 'POST' && path === '/requirements/archive') {
        const body = await readBody(req)
        const res2 = store.archiveRequirement(body.id, body.archived !== false)
        return sendJson(res, res2.changed ? 200 : 404, { ok: Boolean(res2.changed), ...res2 })
      }

      if (method === 'POST' && path === '/requirements/delete') {
        const body = await readBody(req)
        const deleted = store.deleteRequirement(body.id)
        return sendJson(res, deleted ? 200 : 404, { ok: Boolean(deleted), deleted })
      }

      // ── 开发记录 ───────────────────────────────────────────────────────
      if (method === 'GET' && path === '/logs') {
        const result = store.listLogs({
          project: q.get('project'),
          requirement: q.get('requirement'),
          from: q.get('from'),
          to: q.get('to'),
          kind: q.get('kind'),
          q: q.get('q'),
          source: q.get('source'),
          archived: q.get('archived') ?? 'exclude',
          limit: asNum(q.get('limit'), 100),
          offset: asNum(q.get('offset'), 0),
        })
        return sendJson(res, 200, { ok: true, ...result })
      }

      if (method === 'POST' && path === '/logs/add') {
        const body = await readBody(req)
        if (!body.title) return sendJson(res, 400, { ok: false, error: '缺少 title' })
        const log = store.addLog({ ...body, project: body.project ?? cwd, source: 'manual' })
        return sendJson(res, 200, { ok: true, log })
      }

      if (method === 'POST' && path === '/logs/archive') {
        const body = await readBody(req)
        const res2 = store.archiveLog(body.id, body.archived !== false)
        return sendJson(res, res2.changed ? 200 : 404, { ok: Boolean(res2.changed), ...res2 })
      }

      if (method === 'POST' && path === '/logs/delete') {
        const body = await readBody(req)
        const deleted = store.deleteLog(body.id)
        return sendJson(res, deleted ? 200 : 404, { ok: Boolean(deleted), deleted })
      }

      // ── 检索 / 报表 ────────────────────────────────────────────────────
      if (method === 'GET' && path === '/search') {
        const result = store.search({
          q: q.get('q'),
          project: q.get('project'),
          requirement: q.get('requirement'),
          from: q.get('from'),
          to: q.get('to'),
          kind: q.get('kind'),
          archived: q.get('archived') ?? 'exclude',
          limit: asNum(q.get('limit'), 40),
        })
        return sendJson(res, 200, { ok: true, ...result })
      }

      if (method === 'GET' && path === '/report') {
        const result = store.report({
          from: q.get('from'),
          to: q.get('to'),
          project: q.get('project'),
          limit: asNum(q.get('limit'), 31),
        })
        return sendJson(res, 200, { ok: true, ...result })
      }

      // ── 会话扫描 ───────────────────────────────────────────────────────
      if (method === 'POST' && path === '/scan') {
        const body = await readBody(req)
        const runner = scan ?? ((opts) => store.scanSessions(opts))
        const result = await runner({
          dryRun: asBool(body.dryRun),
          since: body.since ?? null,
          limit: asNum(body.limit, 300),
        })
        return sendJson(res, 200, {
          ok: true,
          files: result.files,
          changed: result.changed,
          skipped: result.skipped,
          activities: result.activities,
          logs: result.logs,
          days: result.days,
          errors: result.errors?.length ?? 0,
          errorDetails: (result.errors ?? []).slice(0, 10),
          sessions: (result.sessions ?? []).slice(0, 50),
        })
      }

      // ── 文档标题 ───────────────────────────────────────────────────────
      if (method === 'POST' && path === '/doc-title') {
        const body = await readBody(req)
        const ref = body.url ?? body.path ?? ''
        if (!ref) return sendJson(res, 400, { ok: false, error: '缺少 url / path' })
        const { resolveDocTitle } = await import('./doc-title.js')
        const result = await resolveDocTitle(ref, { timeoutMs: config.docTimeoutMs })
        return sendJson(res, result.ok ? 200 : 200, { ...result })
      }

      // ── 导出（人可读快照，也方便我离线核对）──────────────────────────
      if (method === 'GET' && path === '/export') {
        return sendJson(res, 200, {
          ok: true,
          exportedAt: new Date().toISOString(),
          counts: store.counts(),
          projects: store.listProjects({ archived: 'include' }),
          requirements: store.listRequirements({ archived: 'include', limit: 1000 }).items,
          logs: store.listLogs({ archived: 'include', limit: 1000 }).items,
        })
      }

      return sendJson(res, 404, { ok: false, error: `未知路由 ${method} ${path}` })
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
    }
  }

  try {
    const disposer = ctx.inject(['webServer'], (webCtx) => {
      const server = webCtx.webServer ?? (typeof webCtx.get === 'function' ? webCtx.get('webServer') : undefined)
      if (!server?.register) return undefined
      return server.register({ kind: 'prefix', path: base, handler })
    })
    return { installed: true, disposer }
  } catch (error) {
    return { installed: false, error: error?.message ?? String(error) }
  }
}

export { asBool, asNum }
