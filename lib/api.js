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
    if (total > maxBytes) {
      const error = new Error('body too large')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    // 客户端把 body 传坏了是 4xx，不是服务端错误
    const error = new Error('请求体不是合法 JSON')
    error.statusCode = 400
    throw error
  }
}

const asBool = (v) => v === true || v === 'true' || v === '1'
const asNum = (v, fallback) => (v === null || v === undefined || v === '' ? fallback : Number(v))

export function installApi(ctx, deps) {
  const {
    store,
    config = {},
    version = '0.0.0',
    scanIntervalMinutes = 30,
    getSessionCwd = () => null,
    scan = null,
    /** `(path, title) => Promise<{id,path,title,created}|null>`：把项目目录登记成宿主 workspace。 */
    ensureWorkspace = null,
  } = deps
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
          tag: q.get('tag'),
          archived: q.get('archived') ?? 'exclude',
          limit: asNum(q.get('limit'), 50),
          offset: asNum(q.get('offset'), 0),
        })
        return sendJson(res, 200, { ok: true, ...result })
      }

      // 台账里用过的全部标签（面板的标签下拉 + 表单输入补全）
      if (method === 'GET' && path === '/requirements/tags') {
        return sendJson(res, 200, {
          ok: true,
          tags: store.listTags({ archived: q.get('archived') ?? 'exclude', project: q.get('project') }),
        })
      }

      if (method === 'GET' && path === '/requirements/get') {
        const id = q.get('id')
        if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id' })
        const row = store.getRequirement(id, { project: q.get('project') })
        if (!row) return sendJson(res, 404, { ok: false, error: `没有找到需求 ${id}` })
        const requirement = store.attachLinksOne(store.requirementDetail(row.id))
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

      // ── 链接（UI / 需求 / WBS / 设计，每类可多条）───────────────────────
      if (method === 'POST' && path === '/requirements/link/add') {
        const body = await readBody(req)
        if (!body.id || !body.url) return sendJson(res, 400, { ok: false, error: '缺少 id / url' })
        const link = store.upsertLink(String(body.id), { kind: body.kind, url: body.url, title: body.title ?? null, note: body.note ?? null, sort: body.sort ?? 0 })
        store.syncPrimaryMirrors(String(body.id))
        return sendJson(res, 200, { ok: true, link, links: store.listLinks(String(body.id)) })
      }

      if (method === 'POST' && path === '/requirements/link/remove') {
        const body = await readBody(req)
        const removed = store.removeLink({ id: body.linkId ?? body.link_id ?? null, requirementId: body.id, kind: body.kind ?? null, url: body.url ?? null })
        if (body.id) store.syncPrimaryMirrors(String(body.id))
        return sendJson(res, removed ? 200 : 404, { ok: Boolean(removed), removed, links: body.id ? store.listLinks(String(body.id)) : [] })
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

      if (method === 'POST' && path === '/logs/update') {
        const body = await readBody(req)
        if (body.id === undefined) return sendJson(res, 400, { ok: false, error: '缺少 id' })
        const log = store.updateLog(body.id, body)
        return sendJson(res, log ? 200 : 404, { ok: Boolean(log), log })
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
          tag: q.get('tag'),
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

      // ── 会话扫描（**只有增量**：不接受 full/rebuild，传了就明确回 ignored）──
      if (method === 'POST' && path === '/scan') {
        const body = await readBody(req)
        const ignored = ['full', 'rebuild'].filter((key) => Object.prototype.hasOwnProperty.call(body, key))
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
          ...(ignored.length ? { ignored, note: `扫描只做增量，已忽略：${ignored.join(', ')}（要重新派生请走 schema 迁移清水位）` } : {}),
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

      // ── 需求简报（提示词）───────────────────────────────────────────────
      if (method === 'GET' && path === '/brief') {
        const id = q.get('id')
        if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id' })
        const { buildRequirementBrief } = await import('./brief.js')
        const result = buildRequirementBrief(store, id, { project: q.get('project'), task: q.get('task'), logLimit: asNum(q.get('logs'), 8) })
        return sendJson(res, result.ok ? 200 : 404, {
          ok: result.ok,
          brief: result.brief,
          project: result.project,
          requirement: result.requirement
            ? { id: result.requirement.id, title: result.requirement.title, status: result.requirement.status, links: (result.requirement.links ?? []).length }
            : null,
        })
      }

      // ── 在项目工作区开新会话（宿主侧只保证 workspace + 简报；会话由客户端创建）──
      //
      // 为什么会话不在这里创建：本机实测（dsh-zentao-workbench 的同一套链路）新建会话的
      // 正确入口在**客户端**：`sessions.create({ workspaceId })` → `sessions.open(id)` →
      // `sessions.scope(id).get('conversation').send(text)`。宿主侧这里负责它做不到的事：
      // 把项目目录登记成宿主 workspace（`workspaceRegistry`），并渲染好要发进去的提示词。
      if (method === 'POST' && path === '/open-session') {
        const body = await readBody(req)
        const id = body.id ?? body.requirementId
        if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id' })
        const { buildRequirementBrief } = await import('./brief.js')
        const result = buildRequirementBrief(store, id, { project: body.project ?? null, task: body.task ?? null, logLimit: body.logs ?? 8 })
        if (!result.ok) return sendJson(res, 404, { ok: false, error: `没有找到需求 ${id}` })
        const project = result.project
        const root = project && project.root ? String(project.root) : null
        let workspace = null
        let workspaceError = null
        if (!root) {
          workspaceError = '该需求的项目还没有工作目录：请用一个「从工作区选出来的项目」（带 root 路径）重新保存这条需求'
        } else if (typeof ensureWorkspace !== 'function') {
          workspaceError = '宿主没有 workspaceRegistry 服务，无法自动登记项目目录（可在 DSH 里手动添加该目录为项目）'
        } else {
          try {
            workspace = await ensureWorkspace(root, project.name ?? project.id)
          } catch (error) {
            workspaceError = error?.message ?? String(error)
          }
        }
        return sendJson(res, 200, {
          ok: true,
          prompt: result.brief,
          project,
          workspace,
          workspaceError,
          requirement: { id: result.requirement.id, title: result.requirement.title, links: (result.requirement.links ?? []).length },
          /** 客户端据此决定：有 workspace.id 就建会话发简报；否则退化成「复制简报」 */
          canCreate: Boolean(workspace?.id),
        })
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
      const code = Number(error?.statusCode) >= 400 ? Number(error.statusCode) : 500
      return sendJson(res, code, { ok: false, error: error?.message ?? String(error) })
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
