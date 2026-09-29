/**
 * 领域层：项目 / 需求台账 / 开发记录 / 检索 / 会话扫描落库。
 *
 * 设计要点
 *   - 需求 id 前缀由本插件拼：`<PROJECT大写>-<号>`（`SPMS-5921`）。扫描时对没登记过的需求号
 *     用**同一个公式**生成临时 id，等用户真正保存该需求时 id 天然对齐，扫描记录自动挂上去。
 *   - 扫描落库幂等：activity 用「替换」语义（重扫不累加），work_logs 靠部分唯一索引去重。
 *   - 所有写操作走单写者队列（SQLite WAL 下多进程也安全，队列只是为了自己不打自己）。
 */
import { existsSync } from 'node:fs'
import { backupDaily, closeDb, getMeta, migrate, openDb, quickCheck, setMeta, WriteQueue } from './db.js'
import { archivesRoot, backupDir, dataDir, dateInTz, dbPath, deriveRequirementId, ensureDir, projectIdFromCwd, sessionsRoot, slugify } from './paths.js'
import { discoverWorkspaceProjects, projectFromCwd } from './projects.js'
import { projectCandidatesFrom, readProjectCaches, readWorkspaceRegistry } from './workspace.js'
import { resolveDocTitle } from './doc-title.js'
import { findSessionFiles, summarizeSession } from './session-scan.js'

export const LOG_KINDS = ['dev', 'bug', 'doc', 'review', 'meeting', 'release', 'other']
export const REQ_STATUSES = ['draft', 'planning', 'developing', 'testing', 'released', 'paused', 'dropped']

const nowMs = () => Date.now()

function normKind(kind) {
  const k = String(kind ?? '').trim().toLowerCase()
  if (!k) return 'dev'
  if (LOG_KINDS.includes(k)) return k
  const alias = { 开发: 'dev', 修bug: 'bug', 缺陷: 'bug', 文档: 'doc', 评审: 'review', 会议: 'meeting', 发布: 'release', 其他: 'other' }
  return alias[k] ?? 'other'
}

function normStatus(status) {
  const s = String(status ?? '').trim().toLowerCase()
  if (!s) return null
  if (REQ_STATUSES.includes(s)) return s
  const alias = { 开发中: 'developing', 已完成: 'released', 已上线: 'released', 待开发: 'planning', 规划中: 'planning', 暂停: 'paused', 废弃: 'dropped', 测试中: 'testing', 草稿: 'draft' }
  return alias[s] ?? s
}

function parseTags(tags) {
  if (!tags) return []
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean)
  return String(tags)
    .split(/[,，;；\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

export class Store {
  constructor({ db, config = {}, env = process.env } = {}) {
    this.db = db
    this.config = config
    this.env = env
    this.queue = new WriteQueue()
    this.dbPath = dbPath(env)
  }

  /** 打开（缺省自动建库 + 迁移）；失败时返回 { error }，调用方据此空转而不是崩。 */
  static open(config = {}, env = process.env) {
    try {
      ensureDir(dataDir(env))
      const db = openDb(dbPath(env))
      migrate(db, { log: (m) => console.warn(`[project-hub] ${m}`) })
      return { store: new Store({ db, config, env }) }
    } catch (error) {
      return { store: null, error: error?.message ?? String(error) }
    }
  }

  close() {
    closeDb(this.db)
  }

  backup({ keep = 7 } = {}) {
    return backupDaily(this.db, backupDir(this.env), { keep })
  }

  quickCheck() {
    return quickCheck(this.db)
  }

  // ── 项目 ────────────────────────────────────────────────────────────────
  rowToProject(row) {
    if (!row) return null
    return {
      id: row.id,
      name: row.name,
      root: row.root ?? null,
      remote: row.remote ?? null,
      aliases: row.aliases ? String(row.aliases).split(',').filter(Boolean) : [],
      kind: row.kind ?? 'work',
      lastSeenAt: row.last_seen_at ?? null,
      archivedAt: row.archived_at ?? null,
      requirementCount: row.requirement_count === undefined ? undefined : Number(row.requirement_count ?? 0),
      lastWorkedDate: row.last_worked_date ?? null,
    }
  }

  upsertProject({ id, name, root = null, remote = null, aliases = null, kind = 'work' } = {}) {
    const displayName = String(name ?? '').trim() || slugify(id) || 'unknown'
    const projectId = slugify(id ?? displayName) || 'unknown'
    const aliasText = Array.isArray(aliases) ? aliases.filter(Boolean).join(',') : aliases ? String(aliases) : null
    const ts = nowMs()
    const existing = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)
    if (existing) {
      this.db
        .prepare(
          `UPDATE projects SET name = ?, root = COALESCE(?, root), remote = COALESCE(?, remote),
             aliases = COALESCE(?, aliases), kind = COALESCE(?, kind), updated_at = ?, last_seen_at = ?
           WHERE id = ?`,
        )
        .run(displayName, root, remote, aliasText, kind, ts, ts, projectId)
    } else {
      this.db
        .prepare(
          `INSERT INTO projects (id, name, root, remote, aliases, kind, created_at, updated_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(projectId, displayName, root, remote, aliasText, kind, ts, ts, ts)
    }
    return this.rowToProject(this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId))
  }

  /**
   * 把任意「项目引用」解析成项目行：id → name → 别名 → cwd 路径。
   * 认不出来时按名字新建（这样 agent 直接写 `project: 'spms'` 也能用）。
   */
  ensureProject(ref, { create = true } = {}) {
    const raw = String(ref ?? '').trim()
    if (!raw) return null
    if (raw.startsWith('/') || raw.startsWith('~')) {
      const abs = raw.startsWith('~') ? raw.replace('~', process.env.HOME ?? '') : raw
      const info = projectFromCwd(abs)
      const existing = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(info.id)
      if (existing) {
        this.db.prepare('UPDATE projects SET last_seen_at = ?, root = COALESCE(root, ?) WHERE id = ?').run(nowMs(), info.root, info.id)
        return this.rowToProject(this.db.prepare('SELECT * FROM projects WHERE id = ?').get(info.id))
      }
      return create ? this.upsertProject(info) : null
    }
    const byId = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(slugify(raw))
    if (byId) return this.rowToProject(byId)
    // name 允许重名（不同目录可以同名），按最近活跃挑一个最可能的
    const byName = this.db.prepare('SELECT * FROM projects WHERE lower(name) = lower(?) ORDER BY last_seen_at DESC LIMIT 1').get(raw)
    if (byName) return this.rowToProject(byName)
    const byAlias = this.db.prepare("SELECT * FROM projects WHERE ',' || lower(aliases) || ',' LIKE ?").get(`%,${raw.toLowerCase()},%`)
    if (byAlias) return this.rowToProject(byAlias)
    return create ? this.upsertProject({ id: slugify(raw), name: raw }) : null
  }

  listProjects({ cwd = null, withCounts = true, archived = 'exclude' } = {}) {
    const filter = archived === 'only' ? 'WHERE p.archived_at IS NOT NULL' : archived === 'include' ? '' : 'WHERE p.archived_at IS NULL'
    const rows = this.db
      .prepare(
        withCounts
          ? `SELECT p.*,
               (SELECT COUNT(*) FROM requirements r WHERE r.project_id = p.id) AS requirement_count,
               (SELECT MAX(date) FROM work_logs w WHERE w.project_id = p.id) AS last_worked_date
             FROM projects p ${filter} ORDER BY p.last_seen_at DESC, p.name ASC`
          : `SELECT * FROM projects p ${filter} ORDER BY p.name ASC`,
      )
      .all()
    const items = rows.map((r) => this.rowToProject(r))
    if (cwd) {
      const ids = new Set(items.map((p) => p.id))
      for (const cand of discoverWorkspaceProjects(cwd)) {
        if (!ids.has(cand.id)) items.push({ ...cand, requirementCount: 0, lastWorkedDate: null, lastSeenAt: null })
      }
    }
    return items
  }

  /** 候选项目（R3：UI 下拉用）：官方工作区注册表 + 工作区扫描 + 会话历史 + 库里已有。 */
  candidateProjects(cwd = null, { limit = 80, includeCaches = true } = {}) {
    const seen = new Map()
    const add = (p, source) => {
      if (!p?.id || seen.has(p.id)) return
      seen.set(p.id, { id: p.id, name: p.name, root: p.root ?? null, remote: p.remote ?? null, source: p.source ?? source })
    }
    for (const p of this.listProjects({ cwd })) add(p, 'db')
    if (cwd) for (const p of discoverWorkspaceProjects(cwd)) add(p, 'workspace')
    for (const row of this.db.prepare("SELECT DISTINCT cwd FROM scanned_sessions WHERE cwd IS NOT NULL AND cwd <> ''").all()) {
      add(projectFromCwd(row.cwd), 'session')
    }
    // 官方工作区注册表（宿主 workspaceRegistry 的持久化形态）
    for (const p of readWorkspaceRegistry(this.env)) add(p, 'workspace-registry')
    // 会话投影缓存（零解压）：首屏就有候选，不必等第一次扫描
    if (includeCaches) {
      for (const p of projectCandidatesFrom([], readProjectCaches(this.env))) add(p, 'session-cache')
    }
    return [...seen.values()].slice(0, limit)
  }

  // ── 需求台账 ────────────────────────────────────────────────────────────
  rowToRequirement(row) {
    if (!row) return null
    return {
      id: row.id,
      no: row.no ?? null,
      title: row.title ?? null,
      projectId: row.project_id ?? null,
      projectName: row.project_name ?? null,
      status: row.status ?? null,
      priority: row.priority ?? null,
      docUrl: row.doc_url ?? null,
      docTitle: row.doc_title ?? null,
      docLocal: row.doc_local ?? null,
      docTitleAt: row.doc_title_at ?? null,
      wbsUrl: row.wbs_url ?? null,
      wbsNote: row.wbs_note ?? null,
      designUrl: row.design_url ?? null,
      designNote: row.design_note ?? null,
      tags: parseTags(row.tags),
      extra: row.extra ? safeJson(row.extra) : null,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
      lastWorkedAt: row.last_worked_at ?? null,
      archivedAt: row.archived_at ?? null,
      workCount: row.work_count === undefined ? undefined : Number(row.work_count ?? 0),
      lastWorkDate: row.last_work_date ?? null,
    }
  }

  findRequirementByNo(projectId, no) {
    const digits = String(no ?? '').replace(/^0+/, '')
    if (!digits) return null
    return (
      this.db.prepare("SELECT * FROM requirements WHERE project_id = ? AND (no = ? OR no = ?)").get(projectId ?? '', digits, String(no)) ??
      this.db.prepare("SELECT * FROM requirements WHERE no = ? OR no = ?").get(digits, String(no)) ??
      null
    )
  }

  getRequirement(idOrNo, { project = null } = {}) {
    const key = String(idOrNo ?? '').trim()
    if (!key) return null
    let row = this.db.prepare('SELECT * FROM requirements WHERE id = ?').get(key)
    if (!row && project) {
      const proj = this.ensureProject(project, { create: false })
      row = this.findRequirementByNo(proj?.id ?? project, key)
    }
    if (!row) {
      row = this.db.prepare('SELECT * FROM requirements WHERE no = ?').get(key.replace(/^0+/, '') || key)
    }
    return row ?? null
  }

  /**
   * 需求 id 前缀（`spms` → `SPMS`）：用项目**显示名**而不是 slug。
   *
   * 为什么不用 slug：同一个禅道产品的多个仓库（`work/spms` 与 `work/spms-ui/spms`）
   * 目录名相同但 slug 不同（`spms` / `spms-ui-spms`），用 slug 会把同一个需求
   *（如 SPMS-5921）拆成两条临时台账；用显示名则天然合并成一条，
   * 而每条开发记录仍保留自己的 `project_id`，报表照样能区分是哪个仓库动的手。
   */
  reqPrefix(project) {
    const base = String(project?.name ?? project?.id ?? '')
    const cleaned = base
      .trim()
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toUpperCase()
    return cleaned || String(project?.id ?? '').toUpperCase()
  }

  /**
   * 保存/更新需求（R2 + R4）。
   * `readTitle !== false` 且给了 docUrl 时，把文档标题读回来（读不到不报错，只是不填）。
   */
  async saveRequirement(input = {}) {
    const projectRef = input.project ?? input.projectId ?? null
    const project = this.ensureProject(projectRef)
    const rawId = String(input.id ?? '').trim()
    const rawNo = String(input.no ?? '').trim()
    let no = rawNo
    if (!no && rawId) {
      const m = rawId.match(/(\d{2,8})\s*$/)
      no = m ? m[1] : ''
    }
    const id = rawId || deriveRequirementId(this.reqPrefix(project), no)
    if (!id) throw new Error('缺少需求 ID / 需求号')

    let docTitle = input.docTitle ? String(input.docTitle) : null
    let titleRead = null
    if (input.readTitle !== false && input.docUrl) {
      titleRead = await resolveDocTitle(String(input.docUrl), { timeoutMs: this.config.docTimeoutMs })
      if (titleRead?.ok) docTitle = titleRead.title
    }
    const title = input.title ? String(input.title).trim() : docTitle
    const ts = nowMs()
    const existing = this.db.prepare('SELECT * FROM requirements WHERE id = ?').get(id)
    const merged = {
      id,
      no: no || existing?.no || null,
      title: title ?? existing?.title ?? null,
      project_id: project?.id ?? existing?.project_id ?? '',
      status: normStatus(input.status) ?? existing?.status ?? 'developing',
      priority: input.priority ?? existing?.priority ?? null,
      doc_url: input.docUrl ?? existing?.doc_url ?? null,
      doc_title: docTitle ?? existing?.doc_title ?? null,
      doc_local: input.docLocal ?? existing?.doc_local ?? null,
      doc_title_at: docTitle ? ts : existing?.doc_title_at ?? null,
      wbs_url: input.wbsUrl ?? existing?.wbs_url ?? null,
      wbs_note: input.wbsNote ?? existing?.wbs_note ?? null,
      design_url: input.designUrl ?? existing?.design_url ?? null,
      design_note: input.designNote ?? existing?.design_note ?? null,
      tags: input.tags !== undefined ? parseTags(input.tags).join(',') : existing?.tags ?? null,
      extra: input.extra !== undefined ? JSON.stringify(input.extra) : existing?.extra ?? null,
      created_at: existing?.created_at ?? ts,
      updated_at: ts,
      last_worked_at: existing?.last_worked_at ?? null,
      archived_at: input.archived === true ? (existing?.archived_at ?? ts) : input.archived === false ? null : existing?.archived_at ?? null,
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO requirements
          (id, no, title, project_id, status, priority, doc_url, doc_title, doc_local, doc_title_at,
           wbs_url, wbs_note, design_url, design_note, tags, extra, created_at, updated_at, last_worked_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        merged.id, merged.no, merged.title, merged.project_id, merged.status, merged.priority, merged.doc_url, merged.doc_title,
        merged.doc_local, merged.doc_title_at, merged.wbs_url, merged.wbs_note, merged.design_url, merged.design_note, merged.tags,
        merged.extra, merged.created_at, merged.updated_at, merged.last_worked_at, merged.archived_at,
      )
    const row = this.requirementDetail(id)
    return { requirement: this.rowToRequirement(row), titleRead, created: !existing }
  }

  /** 带项目名 / 记录数 / 最近开发日期的完整需求行。 */
  requirementDetail(id) {
    return (
      this.db
        .prepare(
          `SELECT r.*, p.name AS project_name,
             (SELECT COUNT(*) FROM work_logs w WHERE w.requirement_id = r.id) AS work_count,
             (SELECT MAX(date) FROM work_logs w WHERE w.requirement_id = r.id) AS last_work_date
           FROM requirements r LEFT JOIN projects p ON p.id = r.project_id WHERE r.id = ?`,
        )
        .get(String(id)) ?? null
    )
  }

  /** 归档 / 恢复（R14）：target = requirement | log | project。 */
  setArchived(target, id, archived = true) {
    const table = { requirement: 'requirements', log: 'work_logs', project: 'projects' }[String(target)]
    if (!table) throw new Error(`不支持的归档对象：${target}（可选 requirement / log / project）`)
    const key = table === 'work_logs' ? Number(id) : String(id)
    const res = this.db.prepare(`UPDATE ${table} SET archived_at = ? WHERE id = ?`).run(archived ? nowMs() : null, key)
    return Number(res.changes ?? 0)
  }

  /** 归档/恢复需求（返回更新后的完整需求）。 */
  archiveRequirement(id, archived = true) {
    const changed = this.setArchived('requirement', id, archived)
    return { changed, requirement: changed ? this.rowToRequirement(this.requirementDetail(id)) : null }
  }

  /** 归档/恢复一条开发记录。 */
  archiveLog(id, archived = true) {
    const changed = this.setArchived('log', id, archived)
    return { changed, log: changed ? this.getLog(id) : null }
  }

  archiveProject(id, archived = true) {
    const changed = this.setArchived('project', id, archived)
    return { changed, project: changed ? this.rowToProject(this.db.prepare('SELECT * FROM projects WHERE id = ?').get(String(id))) : null }
  }

  deleteRequirement(id) {
    const res = this.db.prepare('DELETE FROM requirements WHERE id = ?').run(String(id))
    return Number(res.changes ?? 0)
  }

  listRequirements({ project = null, q = null, status = null, requirement = null, archived = 'exclude', limit = 50, offset = 0 } = {}) {
    const where = []
    const args = []
    if (archived === 'only') where.push('r.archived_at IS NOT NULL')
    else if (archived !== 'include') where.push('r.archived_at IS NULL')
    if (project) {
      const proj = this.ensureProject(project, { create: false })
      where.push('r.project_id = ?')
      args.push(proj?.id ?? slugify(project))
    }
    if (status) {
      where.push('r.status = ?')
      args.push(normStatus(status) ?? status)
    }
    if (requirement) {
      // 按需求过滤：既认正式 id/号，也认「扫描出来的临时 id」（`SPMS-55036` 这种还没登记的需求）
      const like = `%${requirement}%`
      where.push('(r.id LIKE ? OR r.no LIKE ?)')
      args.push(like, like)
    }
    if (q) {
      where.push('(r.id LIKE ? OR r.title LIKE ? OR r.doc_title LIKE ? OR r.no LIKE ? OR r.tags LIKE ?)')
      const like = `%${q}%`
      args.push(like, like, like, like, like)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM requirements r ${clause}`).get(...args)?.n ?? 0)
    const rows = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name,
           (SELECT COUNT(*) FROM work_logs w WHERE w.requirement_id = r.id) AS work_count,
           (SELECT MAX(date) FROM work_logs w WHERE w.requirement_id = r.id) AS last_work_date
         FROM requirements r LEFT JOIN projects p ON p.id = r.project_id
         ${clause}
         ORDER BY COALESCE(r.last_worked_at, '') DESC, r.updated_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...args, Number(limit), Number(offset))
    return { total, items: rows.map((r) => this.rowToRequirement(r)) }
  }

  // ── 开发记录 ────────────────────────────────────────────────────────────
  rowToLog(row) {
    if (!row) return null
    return {
      id: Number(row.id),
      date: row.date,
      projectId: row.project_id ?? '',
      projectName: row.project_name ?? null,
      requirementId: row.requirement_id ?? '',
      requirementTitle: row.requirement_title ?? null,
      kind: row.kind,
      title: row.title ?? null,
      detail: row.detail ?? null,
      minutes: row.minutes ?? null,
      source: row.source,
      sessionId: row.session_id ?? null,
      evidence: row.evidence ?? null,
      createdAt: row.created_at ?? null,
      archivedAt: row.archived_at ?? null,
    }
  }

  /** 手动添加记录（R6：比如「今天解决了 bug 55036」）。 */
  addLog(input = {}) {
    const date = String(input.date ?? '').trim() || dateInTz(nowMs(), this.config.tz)
    const project = this.ensureProject(input.project ?? input.projectId ?? null)
    const reqRef = String(input.requirement ?? input.requirementId ?? '').trim()
    let reqId = ''
    if (reqRef) {
      const found = this.getRequirement(reqRef, { project: project?.id ?? null })
      reqId = found?.id ?? deriveRequirementId(this.reqPrefix(project), reqRef.replace(/^[A-Za-z-]+[-_]?/, '') || reqRef)
    }
    const title = String(input.title ?? '').trim() || (reqId ? `开发 ${reqId}` : `${project?.name ?? '未指定项目'} 开发`)
    const res = this.db
      .prepare(
        `INSERT INTO work_logs (date, project_id, requirement_id, kind, title, detail, minutes, source, session_id, evidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        date, project?.id ?? '', reqId, normKind(input.kind), title, input.detail ? String(input.detail) : null,
        Number.isFinite(Number(input.minutes)) && input.minutes !== null && input.minutes !== undefined ? Number(input.minutes) : null,
        String(input.source ?? 'manual'), input.sessionId ?? null, input.evidence ?? null, nowMs(),
      )
    const id = Number(res.lastInsertRowid ?? 0)
    if (reqId) this.touchRequirementWork(reqId, date)
    return this.getLog(id)
  }

  touchRequirementWork(reqId, date) {
    try {
      this.db
        .prepare("UPDATE requirements SET last_worked_at = MAX(COALESCE(last_worked_at, ''), ?) WHERE id = ?")
        .run(String(date), String(reqId))
    } catch {
      /* 需求还没登记：临时 id 打不上也正常 */
    }
  }

  getLog(id) {
    const row = this.db
      .prepare(
        `SELECT w.*, p.name AS project_name, r.title AS requirement_title
         FROM work_logs w LEFT JOIN projects p ON p.id = w.project_id
         LEFT JOIN requirements r ON r.id = w.requirement_id WHERE w.id = ?`,
      )
      .get(Number(id))
    return this.rowToLog(row)
  }

  deleteLog(id) {
    const res = this.db.prepare('DELETE FROM work_logs WHERE id = ?').run(Number(id))
    return Number(res.changes ?? 0)
  }

  listLogs({ project = null, requirement = null, from = null, to = null, kind = null, q = null, source = null, archived = 'exclude', limit = 100, offset = 0 } = {}) {
    const where = []
    const args = []
    if (archived === 'only') where.push('w.archived_at IS NOT NULL')
    else if (archived !== 'include') where.push('w.archived_at IS NULL')
    if (project) {
      const proj = this.ensureProject(project, { create: false })
      where.push('w.project_id = ?')
      args.push(proj?.id ?? slugify(project))
    }
    if (requirement) {
      const req = this.getRequirement(requirement, { project })
      const like = `%${requirement}%`
      where.push('(w.requirement_id = ? OR w.requirement_id LIKE ?)')
      args.push(req?.id ?? String(requirement), like)
    }
    if (from) {
      where.push('w.date >= ?')
      args.push(String(from))
    }
    if (to) {
      where.push('w.date <= ?')
      args.push(String(to))
    }
    if (kind) {
      where.push('w.kind = ?')
      args.push(normKind(kind))
    }
    if (source) {
      where.push('w.source = ?')
      args.push(String(source))
    }
    if (q) {
      const like = `%${q}%`
      where.push('(w.title LIKE ? OR w.detail LIKE ? OR w.requirement_id LIKE ? OR w.evidence LIKE ?)')
      args.push(like, like, like, like)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM work_logs w ${clause}`).get(...args)?.n ?? 0)
    const rows = this.db
      .prepare(
        `SELECT w.*, p.name AS project_name, r.title AS requirement_title
         FROM work_logs w LEFT JOIN projects p ON p.id = w.project_id
         LEFT JOIN requirements r ON r.id = w.requirement_id
         ${clause}
         ORDER BY w.date DESC, w.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, Number(limit), Number(offset))
    return { total, items: rows.map((r) => this.rowToLog(r)) }
  }

  // ── 检索 / 汇总 ─────────────────────────────────────────────────────────
  /** R7：按项目 / 需求 / 日期搜索（需求 + 记录 + 按天时间线一次给全）。 */
  search({ q = null, project = null, requirement = null, from = null, to = null, kind = null, archived = 'exclude', limit = 60 } = {}) {
    const reqs = this.listRequirements({ project, q, requirement, archived, limit })
    let logQuery = { project, from, to, kind, archived, limit }
    if (requirement) logQuery.requirement = requirement
    else if (q) logQuery.q = q
    const logs = this.listLogs(logQuery)
    const days = this.timeline({ project, requirement, from, to, limit: 30 })
    return { requirements: reqs.items, requirementTotal: reqs.total, logs: logs.items, logTotal: logs.total, days }
  }

  /** 按天 → 项目 → 需求 的时间线（扫描结果 + 手工记录都有）。 */
  timeline({ project = null, requirement = null, from = null, to = null, limit = 30 } = {}) {
    const where = []
    const args = []
    if (project) {
      const proj = this.ensureProject(project, { create: false })
      where.push('a.project_id = ?')
      args.push(proj?.id ?? slugify(project))
    }
    if (requirement) {
      const req = this.getRequirement(requirement, { project })
      where.push('a.requirement_id LIKE ?')
      args.push(req ? req.id : `%${requirement}%`)
    }
    if (from) {
      where.push('a.date >= ?')
      args.push(String(from))
    }
    if (to) {
      where.push('a.date <= ?')
      args.push(String(to))
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT a.*, p.name AS project_name, r.title AS requirement_title, r.status AS requirement_status
         FROM activity a LEFT JOIN projects p ON p.id = a.project_id
         LEFT JOIN requirements r ON r.id = a.requirement_id
         ${clause}
         ORDER BY a.date DESC, a.project_id ASC, a.requirement_id ASC
         LIMIT ?`,
      )
      .all(...args, Number(limit) * 40)

    const byDate = new Map()
    for (const row of rows) {
      if (!byDate.has(row.date)) byDate.set(row.date, { date: row.date, projects: new Map(), sessions: new Set(), msgs: 0, toolCalls: 0 })
      const day = byDate.get(row.date)
      day.msgs += Number(row.msgs ?? 0)
      day.toolCalls += Number(row.tool_calls ?? 0)
      if (row.session_id) day.sessions.add(row.session_id)
      const pid = row.project_id || ''
      if (!day.projects.has(pid)) day.projects.set(pid, { projectId: pid, projectName: row.project_name ?? null, requirements: [], msgs: 0, toolCalls: 0 })
      const proj = day.projects.get(pid)
      proj.msgs += Number(row.msgs ?? 0)
      proj.toolCalls += Number(row.tool_calls ?? 0)
      if (row.requirement_id) {
        // 同一需求在同一天可能横跨多个会话 → 合并成一条，避免报表里出现 `SPMS-394×8、SPMS-394×8`
        const merged = proj.requirements.find((x) => x.id === row.requirement_id)
        if (merged) {
          merged.msgs += Number(row.msgs ?? 0)
          merged.toolCalls += Number(row.tool_calls ?? 0)
          merged.lastTime = Math.max(Number(merged.lastTime ?? 0), Number(row.last_time ?? 0)) || merged.lastTime
          if (row.session_id) merged.sessionIds.push(row.session_id)
          if (!merged.sample) merged.sample = row.sample ?? null
          if (!merged.title) merged.title = row.requirement_title ?? null
        } else {
          proj.requirements.push({
            id: row.requirement_id,
            title: row.requirement_title ?? null,
            status: row.requirement_status ?? null,
            msgs: Number(row.msgs ?? 0),
            toolCalls: Number(row.tool_calls ?? 0),
            lastTime: row.last_time ?? null,
            sample: row.sample ?? null,
            sessionId: row.session_id ?? null,
            sessionIds: row.session_id ? [row.session_id] : [],
          })
        }
      }
    }
    const days = [...byDate.values()]
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, Number(limit))
      .map((d) => ({
        date: d.date,
        msgs: d.msgs,
        toolCalls: d.toolCalls,
        sessionCount: d.sessions.size,
        projects: [...d.projects.values()].sort((a, b) => b.msgs - a.msgs),
      }))
    return days
  }

  /** 开发日报/区间汇总（R5 的读侧：哪天在开发哪些项目的哪些需求）。 */
  report({ from = null, to = null, project = null, limit = 60 } = {}) {
    const days = this.timeline({ from, to, project, limit })
    const logWhere = []
    const logArgs = []
    if (from) {
      logWhere.push('date >= ?')
      logArgs.push(String(from))
    }
    if (to) {
      logWhere.push('date <= ?')
      logArgs.push(String(to))
    }
    if (project) {
      const proj = this.ensureProject(project, { create: false })
      logWhere.push('project_id = ?')
      logArgs.push(proj?.id ?? slugify(project))
    }
    const clause = logWhere.length ? `WHERE ${logWhere.join(' AND ')}` : ''
    const logRows = this.db.prepare(`SELECT date, project_id, kind, COUNT(*) AS n FROM work_logs ${clause} GROUP BY date, project_id, kind`).all(...logArgs)
    const logIndex = new Map()
    for (const row of logRows) {
      const key = `${row.date}|${row.project_id}`
      if (!logIndex.has(key)) logIndex.set(key, { count: 0, kinds: {} })
      const entry = logIndex.get(key)
      entry.count += Number(row.n ?? 0)
      entry.kinds[row.kind] = (entry.kinds[row.kind] ?? 0) + Number(row.n ?? 0)
    }
    // 只有手工记录、没有扫描活动的日子也要出现
    const dates = new Set([...days.map((d) => d.date), ...[...logIndex.keys()].map((k) => k.split('|')[0])])
    const merged = [...dates]
      .sort()
      .reverse()
      .slice(0, Number(limit))
      .map((date) => {
        const activityDay = days.find((d) => d.date === date)
        const projectMap = new Map()
        for (const p of activityDay?.projects ?? []) {
          projectMap.set(p.projectId, { projectId: p.projectId, projectName: p.projectName, requirements: p.requirements, msgs: p.msgs, logCount: 0, kinds: {} })
        }
        for (const [key, value] of logIndex) {
          const [d, pid] = key.split('|')
          if (d !== date) continue
          if (!projectMap.has(pid)) projectMap.set(pid, { projectId: pid, projectName: null, requirements: [], msgs: 0, logCount: 0, kinds: {} })
          const entry = projectMap.get(pid)
          entry.logCount += value.count
          entry.kinds = { ...entry.kinds, ...value.kinds }
        }
        const projects = [...projectMap.values()]
        return {
          date,
          msgs: activityDay?.msgs ?? 0,
          toolCalls: activityDay?.toolCalls ?? 0,
          sessionCount: activityDay?.sessionCount ?? 0,
          logCount: projects.reduce((n, p) => n + p.logCount, 0),
          requirementCount: new Set(projects.flatMap((p) => p.requirements.map((r) => r.id))).size,
          projects,
        }
      })
    return {
      days: merged,
      totals: {
        days: merged.length,
        logCount: merged.reduce((n, d) => n + d.logCount, 0),
        requirementCount: new Set(merged.flatMap((d) => d.projects.flatMap((p) => p.requirements.map((r) => r.id)))).size,
        projectCount: new Set(merged.flatMap((d) => d.projects.map((p) => p.projectId))).size,
      },
    }
  }

  // ── 会话扫描 ────────────────────────────────────────────────────────────
  knownRequirementNos() {
    const rows = this.db.prepare("SELECT DISTINCT no FROM requirements WHERE no IS NOT NULL AND no <> ''").all()
    return new Set(rows.map((r) => String(r.no).replace(/^0+/, '')).filter(Boolean))
  }

  scanState(path) {
    return this.db.prepare('SELECT * FROM scanned_sessions WHERE path = ?').get(String(path)) ?? null
  }

  needsRescan({ file, mtime, bytes }) {
    const prev = this.scanState(file)
    if (!prev) return true
    if (prev.error) return true
    return Number(prev.mtime ?? 0) !== Number(mtime ?? 0) || Number(prev.bytes ?? 0) !== Number(bytes ?? 0)
  }

  /** 把一个会话摘要写进库（幂等）。 */
  ingestSession(summary, { dryRun = false } = {}) {
    const project = summary.cwd ? this.ensureProject(summary.cwd) : null
    let activities = 0
    let logs = 0
    const touched = new Set()
    for (const day of summary.days) {
      // ① 会话级活动（这个会话当天有多少轮/多少次工具调用）
      if (!dryRun) {
        this.db
          .prepare(
            `INSERT INTO activity (date, project_id, requirement_id, session_id, msgs, tool_calls, first_time, last_time, sample, session_title, scanned_at)
             VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(date, project_id, requirement_id, session_id) DO UPDATE SET
               msgs = excluded.msgs, tool_calls = excluded.tool_calls, first_time = excluded.first_time,
               last_time = excluded.last_time, sample = excluded.sample, session_title = excluded.session_title,
               scanned_at = excluded.scanned_at`,
          )
          .run(
            day.date, project?.id ?? '', summary.sessionId, Number(day.msgs ?? 0), Number(day.toolCalls ?? 0),
            day.firstTime ?? summary.firstTime ?? null, day.lastTime ?? summary.lastTime ?? null, day.sample ?? null,
            summary.title ?? null, nowMs(),
          )
        activities += 1
      }
      // ② 需求级活动 + 工作记录
      for (const r of day.requirements) {
        const known = this.findRequirementByNo(project?.id ?? '', r.digits)
        const reqId = known?.id ?? deriveRequirementId(this.reqPrefix(project), r.digits)
        touched.add(`${reqId}|${day.date}`)
        if (!dryRun) {
          this.db
            .prepare(
              `INSERT INTO activity (date, project_id, requirement_id, session_id, msgs, tool_calls, first_time, last_time, sample, session_title, scanned_at)
               VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
               ON CONFLICT(date, project_id, requirement_id, session_id) DO UPDATE SET
                 msgs = excluded.msgs, first_time = excluded.first_time, last_time = excluded.last_time,
                 sample = COALESCE(excluded.sample, activity.sample), session_title = excluded.session_title,
                 scanned_at = excluded.scanned_at`,
            )
            .run(
              day.date, project?.id ?? '', reqId, summary.sessionId, Number(r.hits ?? 1), r.lastTime ?? day.lastTime ?? null,
              r.lastTime ?? day.lastTime ?? null, r.sample ?? day.sample ?? null, summary.title ?? null, nowMs(),
            )
          activities += 1
          const res = this.db
            .prepare(
              `INSERT OR IGNORE INTO work_logs (date, project_id, requirement_id, kind, title, detail, minutes, source, session_id, evidence, created_at)
               VALUES (?, ?, ?, ?, ?, ?, NULL, 'session-scan', ?, ?, ?)`,
            )
            .run(
              day.date, project?.id ?? '', reqId, r.kind === 'bug' ? 'bug' : 'dev',
              `${r.kind === 'bug' ? '修复' : '开发'} ${reqId}`, summary.title ?? null, summary.sessionId, r.sample ?? null, nowMs(),
            )
          logs += Number(res.changes ?? 0)
          this.touchRequirementWork(reqId, day.date)
        }
      }
      // ③ 当天没有任何需求号的会话：记一条项目级记录（标题用会话标题），别让这天凭空消失
      if (day.requirements.length === 0 && !dryRun) {
        const res = this.db
          .prepare(
            `INSERT OR IGNORE INTO work_logs (date, project_id, requirement_id, kind, title, detail, minutes, source, session_id, evidence, created_at)
             VALUES (?, ?, '', 'dev', ?, ?, NULL, 'session-scan', ?, ?, ?)`,
          )
          .run(day.date, project?.id ?? '', summary.title ?? `开发 ${project?.name ?? '未知项目'}`, day.sample ?? null, summary.sessionId, day.sample ?? null, nowMs())
        logs += Number(res.changes ?? 0)
      }
    }
    if (!dryRun) {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO scanned_sessions
            (session_id, path, cwd, project_id, first_time, last_time, msgs, events, days, mtime, bytes, scanned_at, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          summary.sessionId, summary.path, summary.cwd ?? null, project?.id ?? null, summary.firstTime ?? null, summary.lastTime ?? null,
          Number(summary.msgs ?? 0), Number(summary.events ?? 0), (summary.days ?? []).map((d) => d.date).join(','),
          Number(summary.mtime ?? 0), Number(summary.bytes ?? 0), nowMs(),
        )
    }
    return { activities, logs, projectId: project?.id ?? null, touched: [...touched] }
  }

  /** 清掉扫描派生的行（只给 schema 迁移/维护脚本用；正常路径只有增量扫描）。 */

  purgeScanData({ project = null } = {}) {
    const proj = project ? this.ensureProject(project, { create: false }) : null
    const pid = proj?.id ?? null
    const logs = pid
      ? this.db.prepare("DELETE FROM work_logs WHERE source = 'session-scan' AND project_id = ?").run(pid)
      : this.db.prepare("DELETE FROM work_logs WHERE source = 'session-scan'").run()
    const acts = pid ? this.db.prepare('DELETE FROM activity WHERE project_id = ?').run(pid) : this.db.prepare('DELETE FROM activity').run()
    const sessions = pid
      ? this.db.prepare('DELETE FROM scanned_sessions WHERE project_id = ?').run(pid)
      : this.db.prepare('DELETE FROM scanned_sessions').run()
    return { logs: Number(logs.changes ?? 0), activity: Number(acts.changes ?? 0), sessions: Number(sessions.changes ?? 0) }
  }

  /**
   * R5 主入口：**增量**扫描会话日志。
   *
   * 增量口径 = `scanned_sessions` 里的 `mtime + bytes` 水位：没变的会话直接跳过
   * （实测 453 个会话文件里只有几十个会变），失败过的会话（error 非空）下次会重试。
   * activity 用替换语义、work_logs 靠部分唯一索引去重，所以重扫同一会话不会翻倍。
   * 提取规则变了要重新派生时，走 **schema 迁移** 清水位（见 lib/schema.js v2），
   * 不提供「全量重扫」入口。
   *
   * `limit` = **本轮真正扫描（有变更的）会话数上限**，不是文件枚举上限：
   * 文件枚举始终看全量（只加一个防爆上限），否则会话数一旦超过 limit，
   * 排在后面的会话会永远轮不到（早期版本的坑：limit 当成了文件列表截断）。
   */
  async scanSessions({ since = null, dryRun = false, limit = 800, sessionId = null, log = () => {}, now = Date.now() } = {}) {
    const roots = [sessionsRoot(this.env), archivesRoot(this.env)]
    const files = findSessionFiles(roots, { limit: Math.max(Number(limit) * 8, 5000) })
    const maxScan = Math.max(1, Number(limit) || 800)
    const knownNos = this.knownRequirementNos()
    const tz = this.config.tz ?? 'Asia/Shanghai'
    const minDigits = this.config.scan?.minDigits ?? 3
    const weakMinHits = this.config.scan?.weakMinHits ?? 2
    const stats = { files: files.length, changed: 0, skipped: 0, activities: 0, logs: 0, days: new Set(), errors: [], sessions: [] }
    let n = 0
    for (const info of files) {
      n += 1
      if (n % 4 === 0) await new Promise((r) => setImmediate(r)) // 让出事件循环，别把宿主卡住
      if (stats.changed >= maxScan) break // 本轮工作量到顶：剩下的留给下一轮（水位没动，下轮继续）
      if (sessionId && !info.file.includes(sessionId)) continue
      if (since && Number(info.mtime ?? 0) < Number(since)) {
        stats.skipped += 1
        continue
      }
      if (!this.needsRescan(info)) {
        stats.skipped += 1
        continue
      }
      try {
        const summary = summarizeSession(info.file, { tz, minDigits, weakMinHits, knownNos })
        if (summary.msgs === 0) {
          stats.skipped += 1
          if (!dryRun) {
            this.db
              .prepare(
                `INSERT OR REPLACE INTO scanned_sessions
                  (session_id, path, cwd, project_id, first_time, last_time, msgs, events, days, mtime, bytes, scanned_at, error)
                 VALUES (?, ?, ?, NULL, ?, ?, 0, ?, '', ?, ?, ?, NULL)`,
              )
              .run(summary.sessionId, summary.path, summary.cwd ?? null, summary.firstTime ?? null, summary.lastTime ?? null, summary.events ?? 0, summary.mtime ?? 0, summary.bytes ?? 0, nowMs())
          }
          continue
        }
        const res = this.ingestSession(summary, { dryRun })
        stats.changed += 1
        stats.activities += res.activities
        stats.logs += res.logs
        for (const d of summary.days) stats.days.add(d.date)
        stats.sessions.push({
          sessionId: summary.sessionId,
          cwd: summary.cwd,
          projectId: res.projectId,
          title: summary.title,
          msgs: summary.msgs,
          days: summary.days.map((d) => `${d.date}(${d.requirements.length}需求)`),
        })
        log(`扫描 ${summary.sessionId.slice(0, 18)}… ${summary.msgs} 条消息 / ${summary.days.length} 天`)
      } catch (error) {
        const message = error?.message ?? String(error)
        stats.errors.push({ file: info.file, sessionId: info.sessionId ?? null, error: message })
        if (!dryRun) {
          try {
            this.db
              .prepare(
                `INSERT OR REPLACE INTO scanned_sessions
                  (session_id, path, cwd, project_id, first_time, last_time, msgs, events, days, mtime, bytes, scanned_at, error)
                 VALUES (?, ?, NULL, NULL, NULL, NULL, 0, 0, '', ?, ?, ?, ?)`,
              )
              .run(info.sessionId ?? info.file, info.file, Number(info.mtime ?? 0), Number(info.bytes ?? 0), nowMs(), message)
          } catch {
            /* 记录失败就算了，别让扫描整体崩 */
          }
        }
      }
    }
    const result = { ...stats, days: [...stats.days].sort(), at: now }
    if (!dryRun) {
      setMeta(this.db, 'last_scan_at', String(now))
      setMeta(this.db, 'last_scan_result', JSON.stringify({ files: result.files, changed: result.changed, skipped: result.skipped, activities: result.activities, logs: result.logs, days: result.days, errors: result.errors.length }))
    }
    return result
  }

  lastScan() {
    const at = Number(getMeta(this.db, 'last_scan_at', 0)) || null
    let result = null
    try {
      result = JSON.parse(getMeta(this.db, 'last_scan_result', 'null'))
    } catch {
      result = null
    }
    return { at, result }
  }

  // ── 状态 ────────────────────────────────────────────────────────────────
  counts() {
    const one = (sql) => Number(this.db.prepare(sql).get()?.n ?? 0)
    return {
      projects: one('SELECT COUNT(*) AS n FROM projects'),
      requirements: one('SELECT COUNT(*) AS n FROM requirements'),
      archivedRequirements: one('SELECT COUNT(*) AS n FROM requirements WHERE archived_at IS NOT NULL'),
      workLogs: one('SELECT COUNT(*) AS n FROM work_logs'),
      archivedLogs: one('SELECT COUNT(*) AS n FROM work_logs WHERE archived_at IS NOT NULL'),
      manualLogs: one("SELECT COUNT(*) AS n FROM work_logs WHERE source = 'manual'"),
      scanLogs: one("SELECT COUNT(*) AS n FROM work_logs WHERE source = 'session-scan'"),
      activity: one('SELECT COUNT(*) AS n FROM activity'),
      scannedSessions: one('SELECT COUNT(*) AS n FROM scanned_sessions'),
      activeDays: one('SELECT COUNT(DISTINCT date) AS n FROM work_logs'),
    }
  }

  status({ version = '0.0.0', scanIntervalMinutes = 30 } = {}) {
    return {
      ok: true,
      version,
      dbPath: this.dbPath,
      counts: this.counts(),
      lastScanAt: this.lastScan().at,
      lastScan: this.lastScan().result,
      scanIntervalMinutes,
      schemaVersion: Number(getMeta(this.db, 'schema_version', 0)),
    }
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
