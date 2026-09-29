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
import { extractRequirementNo } from './req-no.js'
import { figmaKeysOf, figmaOverlaps } from './link-index.js'
import { DEFAULT_SINCE_DAYS, gitHead, groupTouchesByModule, scanGitRepo } from './git-index.js'
import { changeSignalsIn, verdictOf } from './drift.js'
import { candidateOverlaps, candidatesFromPages, candidatesFromTouches, mergeCandidates, scanConfluenceTree } from './discover.js'
import { candidatesFromStories, scanZentaoStories } from './zentao-source.js'
import { fetchPage } from './page-fetch.js'
import { docGaps, findRelatedRequirements, frontendCheck, renderReviewReport, reuseCheck } from './review.js'
import { snapshotDoc } from './doc-snapshot.js'
import { discoverWorkspaceProjects, projectFromCwd } from './projects.js'
import { projectCandidatesFrom, readProjectCaches, readWorkspaceRegistry } from './workspace.js'
import { resolveDocTitle } from './doc-title.js'
import { findSessionFiles, summarizeSession } from './session-scan.js'

export const LOG_KINDS = ['dev', 'bug', 'doc', 'review', 'meeting', 'release', 'other']
export const REQ_STATUSES = ['draft', 'planning', 'developing', 'testing', 'released', 'paused', 'dropped']
/** 链接类型：需求文档 / WBS / 后端设计 / UI 设计 / 其它（每类都可以有多条）。 */
export const LINK_KINDS = ['doc', 'wbs', 'design', 'ui', 'other']
export const LINK_LABELS = { doc: '需求文档', wbs: 'WBS', design: '后端设计', ui: 'UI 设计', other: '其它' }
/** 一次保存最多读回几条文档标题（防止一次贴十几条链接时打爆网络）。 */
const LINK_TITLE_BUDGET = 3

/** 链接类型归一化：认英文 key、中文标签与常见别名。 */
export function normLinkKind(kind) {
  const k = String(kind ?? '').trim().toLowerCase()
  if (!k) return 'other'
  if (LINK_KINDS.includes(k)) return k
  const alias = {
    需求: 'doc',
    需求文档: 'doc',
    文档: 'doc',
    doc: 'doc',
    prd: 'doc',
    wbs: 'wbs',
    排期: 'wbs',
    设计: 'design',
    后端设计: 'design',
    后端设计文档: 'design',
    技术方案: 'design',
    design: 'design',
    api: 'design',
    ui: 'ui',
    'ui设计': 'ui',
    ui设计: 'ui',
    设计稿: 'ui',
    视觉: 'ui',
    原型: 'ui',
    figma: 'ui',
    mastergo: 'ui',
    蓝湖: 'ui',
    其它: 'other',
    other: 'other',
  }
  return alias[k] ?? 'other'
}

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

/**
 * 合并 extra JSON：显式传入的字段优先，角色表（读文档带回）落进 `roles`。
 * 三处都可能缺 → 都没有就返回原值（NULL 保持 NULL，不写空对象）。
 */
function mergeExtra(existingRaw, incoming, roles) {
  const parse = (raw) => {
    if (!raw) return {}
    if (typeof raw === 'object') return { ...raw }
    try {
      const doc = JSON.parse(String(raw))
      return doc && typeof doc === 'object' ? doc : {}
    } catch {
      return {}
    }
  }
  const base = parse(existingRaw)
  const next = incoming !== undefined ? { ...base, ...parse(incoming) } : base
  if (roles && Object.keys(roles).length > 0) next.roles = { ...(base.roles ?? {}), ...roles }
  if (Object.keys(next).length === 0) return existingRaw ?? null
  return JSON.stringify(next)
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
      // 迁移日志只在 verbose 时打（否则每跑一次测试就刷一屏 stderr）
      migrate(db, { log: config.verbose ? (m) => console.warn(`[project-hub] ${m}`) : () => {} })
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
      uiUrl: row.ui_url ?? null,
      uiNote: row.ui_note ?? null,
      /** 多链接（事实源在 requirement_links 表）；调用方用 attachLinks 填充。 */
      links: Array.isArray(row.links) ? row.links : undefined,
      tags: parseTags(row.tags),
      /** 这条需求挂的项目（多项目：每项带 platform「端」；第一条是主项目）。attachLinks* 会填。 */
      projects: row.projects ?? [],
      /** 引用同一份 Figma 设计稿的其它需求（撞车信号）。attachLinks* 会填。 */
      figmaOverlaps: row.figmaOverlaps ?? [],
      /** 谁创建的（Confluence REST / 正文里认出来的） */
      creator: row.creator ?? null,
      /** 谁是「产品」（角色表里的 产品/产品经理） */
      product: row.product ?? null,
      /** 角色表全量（存在 extra.roles 里）：{ 产品, UI, 前端, 后端, QA… } */
      roles: (() => {
        try {
          const doc = row.extra ? JSON.parse(String(row.extra)) : null
          return doc && typeof doc === 'object' && doc.roles && typeof doc.roles === 'object' ? doc.roles : {}
        } catch {
          return {}
        }
      })(),
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

    // ⚠️ 顺序：**先读文档标题，再定需求号/需求 ID**。
    // 因为标题里就带着需求号（`【5922】L&F Q3 Enhancements/Queue数据记录`），
    // 读回来之后能自动把 no 填上、进而拼出 `SPMS-5922` —— 这一步必须在算 id 之前。
    let docTitle = input.docTitle ? String(input.docTitle) : null
    let titleRead = null
    if (input.readTitle !== false && input.docUrl) {
      titleRead = await resolveDocTitle(String(input.docUrl), { timeoutMs: this.config.docTimeoutMs, fetchText: input.fetchText ?? null })
      if (titleRead?.ok) docTitle = titleRead.title
    }

    /** 读文档时顺带带回来的结构化信息（谁创建的 / 谁是产品 / 页面里的 UI 链接）。 */
    let docMeta = null
    let noFromTitle = null
    if (titleRead?.ok) {
      docMeta = {
        creator: titleRead.creator ?? null,
        product: titleRead.product ?? null,
        roles: titleRead.roles ?? {},
        uiLinks: titleRead.uiLinks ?? [],
      }
    }

    let no = rawNo
    if (!no && rawId) {
      const m = rawId.match(/(\d{2,8})\s*$/)
      no = m ? m[1] : ''
    } else if (!no && docTitle) {
      noFromTitle = extractRequirementNo(docTitle)
      no = noFromTitle ?? ''
    }
    const id = rawId || deriveRequirementId(this.reqPrefix(project), no)
    if (!id) throw new Error('缺少需求 ID / 需求号')

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
      ui_url: input.uiUrl ?? existing?.ui_url ?? null,
      ui_note: input.uiNote ?? existing?.ui_note ?? null,
      tags: input.tags !== undefined ? parseTags(input.tags).join(',') : existing?.tags ?? null,
      // 谁创建的 / 谁是产品：显式传入优先，其次用读文档带回的，最后保留原值
      creator: input.creator ?? docMeta?.creator ?? existing?.creator ?? null,
      product: input.product ?? docMeta?.product ?? existing?.product ?? null,
      extra: mergeExtra(existing?.extra, input.extra, docMeta?.roles),
      created_at: existing?.created_at ?? ts,
      updated_at: ts,
      last_worked_at: existing?.last_worked_at ?? null,
      archived_at: input.archived === true ? (existing?.archived_at ?? ts) : input.archived === false ? null : existing?.archived_at ?? null,
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO requirements
          (id, no, title, project_id, status, priority, doc_url, doc_title, doc_local, doc_title_at,
           wbs_url, wbs_note, design_url, design_note, ui_url, ui_note, tags, extra, creator, product,
           created_at, updated_at, last_worked_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        merged.id, merged.no, merged.title, merged.project_id, merged.status, merged.priority, merged.doc_url, merged.doc_title,
        merged.doc_local, merged.doc_title_at, merged.wbs_url, merged.wbs_note, merged.design_url, merged.design_note, merged.ui_url,
        merged.ui_note, merged.tags, merged.extra, merged.creator, merged.product,
        merged.created_at, merged.updated_at, merged.last_worked_at, merged.archived_at,
      )

    // ── 文档页面里的 UI 信息（Figma/MasterGo/蓝湖…）直接并进来 ──────────────
    // 用户要求「UI 信息如果有的话直接加入」：读文档时页面里带的 PC端/APP端 设计稿链接，
    // 直接落成 ui 链接（唯一索引 (requirement_id,kind,url) + OR IGNORE → 重复执行不会长两条）
    let uiFromDoc = 0
    if (docMeta?.uiLinks?.length) {
      for (const link of docMeta.uiLinks) {
        const res2 = this.db
          .prepare(
            `INSERT OR IGNORE INTO requirement_links (requirement_id, kind, url, title, note, sort, created_at, updated_at)
             VALUES (?, 'ui', ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, link.url, link.title ?? null, '读文档时自动带入', link.sort ?? 0, ts, ts)
        uiFromDoc += Number(res2.changes ?? 0)
      }
      if (uiFromDoc > 0) this.syncPrimaryMirrors(id)
    }

    // ── 多链接（UI / 需求 / WBS / 设计 都可多条）──────────────────────────
    // ① `links: [{kind,url,title,note}]`：按 (kind,url) upsert；`replaceLinks:true` 时按类整体替换
    // ② 单值字段（docUrl/wbsUrl/designUrl/uiUrl）：替换该类「主链接」（向后兼容的旧语义）
    // 多项目：显式传 `projects: [{project, platform}]` 就整体替换；只传单个 `project` 时，
    // 需求还没有任何项目记录就种一条（老接口/老调用方保持原语义）
    let projectsTouched = 0
    if (Array.isArray(input.projects)) {
      projectsTouched = this.setRequirementProjects(id, input.projects).changed ?? 0
    } else if (this.listRequirementProjects(id).length === 0 && (project?.id || merged.project_id)) {
      projectsTouched = this.setRequirementProjects(id, [{ project: project?.id ?? merged.project_id, platform: input.platform ?? null }]).changed ?? 0
    }

    const touchedKinds = await this.applyLinks(id, { ...input, docTitle: docTitle ?? null })
    if (touchedKinds.size > 0) this.syncPrimaryMirrors(id)
    // 标题仍空时，用主文档链接的标题兜底（多链接路径下 R4「读文档标题保存」照样成立）
    if (!merged.title) {
      const primaryDoc = this.db.prepare("SELECT title FROM requirement_links WHERE requirement_id = ? AND kind = 'doc' ORDER BY sort ASC, id ASC LIMIT 1").get(id)
      if (primaryDoc?.title) this.db.prepare('UPDATE requirements SET title = ?, doc_title = ?, updated_at = ? WHERE id = ?').run(primaryDoc.title, primaryDoc.title, nowMs(), id)
    }

    const row = this.requirementDetail(id)
    return {
      requirement: this.attachLinksOne(row),
      titleRead,
      created: !existing,
      linkKinds: [...touchedKinds],
      /** 需求号是不是从文档标题里认出来的（面板/工具据此提示「需求号 5922 取自标题」）。 */
      noFromTitle: noFromTitle ?? null,
      /** 读文档带回的结构化信息（creator/product/roles）与自动并入的 UI 链接数。 */
      metaFromDoc: docMeta ? { creator: docMeta.creator, product: docMeta.product, roles: docMeta.roles } : null,
      uiFromDoc,
      /** 这次落库/更新的项目数（多项目编辑用） */
      projectsTouched,
    }
  }

  /**
   * 落库链接（saveRequirement 的第二段）：返回被触碰的 kind 集合。
   * 文档类链接缺标题时会读回标题（每条一次，最多 `LINK_TITLE_BUDGET` 次，避免一次保存打太多请求）。
   */
  async applyLinks(requirementId, input = {}) {
    const touched = new Set()
    let titleRead = null
    if (Array.isArray(input.links) && input.links.length > 0) {
      const normalized = input.links
        .map((l) => ({ kind: normLinkKind(l?.kind), url: String(l?.url ?? '').trim(), title: l?.title ? String(l.title) : null, note: l?.note ? String(l.note) : null }))
        .filter((l) => l.url)
      let budget = input.readTitle === false ? 0 : LINK_TITLE_BUDGET
      for (const link of normalized) {
        touched.add(link.kind)
        if (link.kind === 'doc' && !link.title && budget > 0) {
          budget -= 1
          try {
            const res = await resolveDocTitle(link.url, { timeoutMs: this.config.docTimeoutMs })
            if (res?.ok) {
              link.title = res.title
              if (!titleRead) titleRead = res
            }
          } catch {
            /* 读不到就留着空标题，不影响保存 */
          }
        }
      }
      if (input.replaceLinks === true) this.replaceLinks(requirementId, normalized)
      else for (const link of normalized) this.upsertLink(requirementId, link)
    }
    for (const [kind, url, note] of [
      ['doc', input.docUrl, input.docNote],
      ['wbs', input.wbsUrl, input.wbsNote],
      ['design', input.designUrl, input.designNote],
      ['ui', input.uiUrl, input.uiNote],
    ]) {
      if (url === undefined || url === null || String(url).trim() === '') continue
      touched.add(kind)
      // doc 类把刚读回来的标题一并写进链接（否则 syncPrimaryMirrors 会用空标题盖掉 doc_title）
      this.setPrimaryLink(requirementId, kind, String(url).trim(), note ?? null, kind === 'doc' ? input.docTitle ?? null : null)
    }
    return touched
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

  /**
   * 只改需求状态（卡片上直接切换、以及「开新会话 → 自动置开发中」都走它）。
   * 比整条 `saveRequirement` 轻得多：不动标题/链接/项目，只碰 status + updated_at。
   *
   * 与 `saveRequirement` 不同，这里**严格校验**：只认 7 个正式状态及其中文别名
   * （`normStatus` 对未知值会原样透传，那样卡片下拉就可能写进拼错的状态）。
   *
   * @returns {{ ok:boolean, changed:number, error?:string, requirement?:any }}
   */
  setRequirementStatus(id, status) {
    const next = normStatus(status)
    if (!next || !REQ_STATUSES.includes(next)) {
      return { ok: false, changed: 0, error: `未知状态：${status}（可用：${REQ_STATUSES.join(' / ')}，或中文别名如「开发中」）` }
    }
    const existing = this.getRequirement(id)
    if (!existing) return { ok: false, changed: 0, error: `没找到需求 ${id}` }
    const res = this.db.prepare('UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?').run(next, nowMs(), existing.id)
    return { ok: true, changed: Number(res.changes ?? 0), requirement: this.rowToRequirement(this.requirementDetail(existing.id)) }
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

  // ── 链接（多链接模型；事实源 = requirement_links，requirements 旧列只是「主链接」镜像）──

  /** 一条需求的所有链接（按 kind 顺序 + sort）。 */
  listLinks(requirementId, { kind = null } = {}) {
    const rows = kind
      ? this.db.prepare('SELECT * FROM requirement_links WHERE requirement_id = ? AND kind = ? ORDER BY sort ASC, id ASC').all(String(requirementId), normLinkKind(kind))
      : this.db.prepare('SELECT * FROM requirement_links WHERE requirement_id = ? ORDER BY kind ASC, sort ASC, id ASC').all(String(requirementId))
    return rows.map((row) => this.rowToLink(row))
  }

  rowToLink(row) {
    if (!row) return null
    return {
      id: Number(row.id),
      requirementId: row.requirement_id,
      kind: row.kind,
      kindLabel: LINK_LABELS[row.kind] ?? row.kind,
      url: row.url,
      title: row.title ?? null,
      note: row.note ?? null,
      sort: Number(row.sort ?? 0),
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
    }
  }

  /** 给单条需求挂上 links + 多项目（一条需求可以在多个项目里开发，每个项目带「端」）。 */
  attachLinksOne(row) {
    const req = this.rowToRequirement(row)
    if (!req) return null
    req.links = this.listLinks(req.id)
    req.projects = this.listRequirementProjects(req.id)
    /** 同一份 Figma 稿被别的需求也引用 → 冲突信号（P0） */
    req.figmaOverlaps = this.listFigmaOverlaps(req.id)
    /** 代码落点（P1：git 事实，按模块聚合） */
    req.codeTouches = this.listCodeTouches(req.id)
    return req
  }

  /**
   * 与这条需求**引用同一份 Figma 设计稿**的其它需求。
   * 只查一次 SQL（把引用 figma 的 ui 链接捞出来按 fileKey 分组），需求量级小，够用。
   */
  listFigmaOverlaps(requirementId) {
    const id = String(requirementId ?? '').trim()
    if (!id) return []
    try {
      const rows = this.db
        .prepare(
          `SELECT l.requirement_id, l.url, l.title, r.title AS req_title
             FROM requirement_links l LEFT JOIN requirements r ON r.id = l.requirement_id
            WHERE l.url LIKE '%figma.com/%' AND r.archived_at IS NULL`,
        )
        .all()
      const mine = new Set()
      for (const row of rows) if (row.requirement_id === id) mine.add(figmaKeysOf({ links: [{ url: row.url }] })[0])
      if (mine.size === 0) return []
      const out = []
      const seen = new Set()
      for (const row of rows) {
        if (row.requirement_id === id) continue
        const key = figmaKeysOf({ links: [{ url: row.url }] })[0]
        if (!key || !mine.has(key)) continue
        const dedupe = `${row.requirement_id}:${key}`
        if (seen.has(dedupe)) continue
        seen.add(dedupe)
        out.push({ id: row.requirement_id, title: row.req_title ?? null, fileKey: key, linkTitle: row.title ?? null })
      }
      return out
    } catch {
      return []
    }
  }

  // ── 需求 ↔ 多项目（schema v6）──────────────────────────────────────────
  /**
   * 一条需求挂的项目列表（顺序即面板显示顺序；第一条 = 主项目）。
   * `platform` 就是「端」：PC / APP / 服务端…，开新会话时按它裁剪提示词。
   */
  listRequirementProjects(requirementId) {
    const id = String(requirementId ?? '').trim()
    if (!id) return []
    let rows = []
    try {
      rows = this.db
        .prepare(
          `SELECT rp.requirement_id, rp.project_id, rp.platform, rp.is_primary, rp.sort,
                  p.name AS project_name, p.root AS project_root
             FROM requirement_projects rp LEFT JOIN projects p ON p.id = rp.project_id
            WHERE rp.requirement_id = ? ORDER BY rp.sort ASC, rp.is_primary DESC, rp.project_id ASC`,
        )
        .all(id)
    } catch {
      return [] // 极老库（还没跑到 v6）时静默降级
    }
    return rows.map((row) => ({
      projectId: row.project_id,
      projectName: row.project_name ?? row.project_id,
      platform: row.platform ?? null,
      primary: Number(row.is_primary ?? 0) === 1,
      root: row.project_root ?? null,
    }))
  }

  /**
   * 整体替换一条需求的项目列表（与链接的 replaceLinks 同款语义）。
   * 第一条 = 主项目 → 同步回 `requirements.project_id`（需求 ID 前缀沿用主项目）。
   * @param {Array<{project?:string, id?:string, platform?:string|null, root?:string|null}>} list
   */
  setRequirementProjects(requirementId, list) {
    const id = String(requirementId ?? '').trim()
    if (!id) throw new Error('缺少需求 ID')
    const existing = this.db.prepare('SELECT id FROM requirements WHERE id = ?').get(id)
    if (!existing) return { ok: false, changed: 0, error: `没找到需求 ${id}` }
    const ts = nowMs()
    const normalized = []
    const seen = new Set()
    for (const raw of Array.isArray(list) ? list : []) {
      const ref = raw?.project ?? raw?.id ?? raw?.projectId
      if (!ref) continue
      const proj = this.ensureProject(ref, { create: true })
      if (!proj || seen.has(proj.id)) continue
      seen.add(proj.id)
      // 允许传 root 兜底（候选项目里带目录时）
      if (raw.root && !proj.root) this.upsertProject({ id: proj.id, name: proj.name, root: String(raw.root) })
      normalized.push({ projectId: proj.id, platform: raw.platform ? String(raw.platform).trim() || null : null })
    }
    this.db.prepare('DELETE FROM requirement_projects WHERE requirement_id = ?').run(id)
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO requirement_projects (requirement_id, project_id, platform, is_primary, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    normalized.forEach((item, index) => {
      insert.run(id, item.projectId, item.platform, index === 0 ? 1 : 0, index, ts, ts)
    })
    // 主项目镜像回 requirements.project_id（空列表时保留原值，避免"清空项目"把需求变成孤儿）
    if (normalized.length > 0) {
      this.db.prepare('UPDATE requirements SET project_id = ?, updated_at = ? WHERE id = ?').run(normalized[0].projectId, ts, id)
    }
    return { ok: true, changed: normalized.length, projects: this.listRequirementProjects(id) }
  }

  /** 批量挂 links + 多项目（列表页一次查完，避免 N+1）。 */
  attachLinks(rows) {
    const items = rows.map((row) => this.rowToRequirement(row))
    const ids = items.map((r) => r && r.id).filter(Boolean)
    if (ids.length === 0) return items
    const placeholders = ids.map(() => '?').join(',')
    // 多项目：一条 SQL 查完所有需求的项目，再按需求分组
    try {
      const projRows = this.db
        .prepare(
          `SELECT rp.requirement_id, rp.project_id, rp.platform, rp.is_primary, rp.sort,
                  p.name AS project_name, p.root AS project_root
             FROM requirement_projects rp LEFT JOIN projects p ON p.id = rp.project_id
            WHERE rp.requirement_id IN (${placeholders}) ORDER BY rp.sort ASC, rp.is_primary DESC, rp.project_id ASC`,
        )
        .all(...ids)
      const byReq = new Map()
      for (const row of projRows) {
        if (!byReq.has(row.requirement_id)) byReq.set(row.requirement_id, [])
        byReq.get(row.requirement_id).push({
          projectId: row.project_id,
          projectName: row.project_name ?? row.project_id,
          platform: row.platform ?? null,
          primary: Number(row.is_primary ?? 0) === 1,
          root: row.project_root ?? null,
        })
      }
      for (const item of items) if (item) item.projects = byReq.get(item.id) ?? []
    } catch {
      for (const item of items) if (item && !item.projects) item.projects = []
    }
    // 同稿需求（P0）：链接已经在手上，纯内存算，不额外查库
    try {
      const overlaps = figmaOverlaps(items)
      for (const item of items) if (item) item.figmaOverlaps = overlaps.get(item.id) ?? []
    } catch {
      for (const item of items) if (item && !item.figmaOverlaps) item.figmaOverlaps = []
    }
    const all = this.db.prepare(`SELECT * FROM requirement_links WHERE requirement_id IN (${placeholders}) ORDER BY kind ASC, sort ASC, id ASC`).all(...ids)
    const grouped = new Map()
    for (const row of all) {
      const link = this.rowToLink(row)
      if (!grouped.has(link.requirementId)) grouped.set(link.requirementId, [])
      grouped.get(link.requirementId).push(link)
    }
    for (const item of items) if (item) item.links = grouped.get(item.id) ?? []
    return items
  }

  /** upsert 一条链接（(requirement_id, kind, url) 唯一）。 */
  upsertLink(requirementId, { kind, url, title = null, note = null, sort = 0 } = {}) {
    const clean = String(url ?? '').trim()
    if (!clean) return null
    const k = normLinkKind(kind)
    const ts = nowMs()
    this.db
      .prepare(
        `INSERT INTO requirement_links (requirement_id, kind, url, title, note, sort, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(requirement_id, kind, url) DO UPDATE SET
           title = COALESCE(excluded.title, requirement_links.title),
           note = COALESCE(excluded.note, requirement_links.note),
           updated_at = excluded.updated_at`,
      )
      .run(String(requirementId), k, clean, title, note, Number(sort ?? 0), ts, ts)
    return this.rowToLink(
      this.db.prepare('SELECT * FROM requirement_links WHERE requirement_id = ? AND kind = ? AND url = ?').get(String(requirementId), k, clean),
    )
  }

  /** 把某类链接的「主链接」（第一条）替换成给定 URL（单值字段的旧语义）。 */
  setPrimaryLink(requirementId, kind, url, note = null, title = null) {
    const k = normLinkKind(kind)
    const clean = String(url ?? '').trim()
    if (!clean) return null
    const primary = this.db.prepare('SELECT * FROM requirement_links WHERE requirement_id = ? AND kind = ? ORDER BY sort ASC, id ASC LIMIT 1').get(String(requirementId), k)
    if (!primary) return this.upsertLink(requirementId, { kind: k, url: clean, title, note })
    if (primary.url === clean) return this.upsertLink(requirementId, { kind: k, url: clean, title, note })
    // URL 变了：原地替换主链接；标题给了就写上，没给则清空（避免张冠李戴）
    this.db
      .prepare('UPDATE requirement_links SET url = ?, title = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?')
      .run(clean, title ?? null, note, nowMs(), primary.id)
    return this.rowToLink(this.db.prepare('SELECT * FROM requirement_links WHERE id = ?').get(primary.id))
  }

  /** 按类整体替换（面板保存整份链接状态时用）：list 里没出现的该类链接会被删掉。 */
  replaceLinks(requirementId, links = []) {
    const byKind = new Map()
    for (const link of links) {
      const k = normLinkKind(link.kind)
      if (!byKind.has(k)) byKind.set(k, [])
      byKind.get(k).push(link)
    }
    let removed = 0
    for (const [kind, rows] of byKind) {
      const keep = rows.map((l) => String(l.url).trim()).filter(Boolean)
      if (keep.length === 0) {
        removed += Number(this.db.prepare('DELETE FROM requirement_links WHERE requirement_id = ? AND kind = ?').run(String(requirementId), kind).changes ?? 0)
        continue
      }
      const placeholders = keep.map(() => '?').join(',')
      removed += Number(
        this.db.prepare(`DELETE FROM requirement_links WHERE requirement_id = ? AND kind = ? AND url NOT IN (${placeholders})`).run(String(requirementId), kind, ...keep).changes ?? 0,
      )
      rows.forEach((link, index) => this.upsertLink(requirementId, { ...link, kind, sort: index }))
    }
    return { removed }
  }

  removeLink({ id = null, requirementId = null, kind = null, url = null } = {}) {
    if (id !== null && id !== undefined) {
      const res = this.db.prepare('DELETE FROM requirement_links WHERE id = ?').run(Number(id))
      return Number(res.changes ?? 0)
    }
    if (!requirementId || !url) return 0
    const res = kind
      ? this.db.prepare('DELETE FROM requirement_links WHERE requirement_id = ? AND kind = ? AND url = ?').run(String(requirementId), normLinkKind(kind), String(url).trim())
      : this.db.prepare('DELETE FROM requirement_links WHERE requirement_id = ? AND url = ?').run(String(requirementId), String(url).trim())
    return Number(res.changes ?? 0)
  }

  /**
   * 把每类的第一条链接镜像回 requirements 旧列（doc_url/doc_title、wbs_url/wbs_note、
   * design_url/design_note、ui_url/ui_note），让老接口/老面板继续拿到「主链接」。
   */
  syncPrimaryMirrors(requirementId) {
    const map = [
      ['doc', 'doc_url', 'doc_title', true],
      ['wbs', 'wbs_url', 'wbs_note', false],
      ['design', 'design_url', 'design_note', false],
      ['ui', 'ui_url', 'ui_note', false],
    ]
    for (const [kind, urlCol, noteCol, noteIsTitle] of map) {
      const link = this.db.prepare('SELECT * FROM requirement_links WHERE requirement_id = ? AND kind = ? ORDER BY sort ASC, id ASC LIMIT 1').get(String(requirementId), kind)
      this.db
        .prepare(`UPDATE requirements SET ${urlCol} = ?, ${noteCol} = ?, updated_at = ? WHERE id = ?`)
        .run(link?.url ?? null, (noteIsTitle ? link?.title : link?.note) ?? null, nowMs(), String(requirementId))
    }
  }

  deleteRequirement(id) {
    const key = String(id)
    // 需求下挂的一切都没有独立生命周期 —— 逐表清干净，别留幽灵数据
    // （实测踩到：硬删后 drift 看板与待办里还挂着已删除的需求）
    for (const table of ['requirement_links', 'requirement_projects', 'requirement_drift', 'doc_snapshots', 'code_touches', 'drift_todos']) {
      try {
        this.db.prepare(`DELETE FROM ${table} WHERE requirement_id = ?`).run(key)
      } catch {
        /* 表还不存在（极老库）时忽略 */
      }
    }
    const res = this.db.prepare('DELETE FROM requirements WHERE id = ?').run(key)
    return Number(res.changes ?? 0)
  }

  listRequirements({
    project = null,
    q = null,
    status = null,
    requirement = null,
    tag = null,
    archived = 'exclude',
    /** 历史需求（采纳时打了 `历史导入` 标签）与当前开发的分开：exclude=只看当前 / only=只看历史 / include=都要。
     *  默认 include —— 内部逻辑（查重、评审、发现）必须看到全部，只有面板的 tab 才做区分。 */
    historical = 'include',
    sort = 'created',
    limit = 50,
    offset = 0,
  } = {}) {
    const where = []
    const args = []
    if (archived === 'only') where.push('r.archived_at IS NOT NULL')
    else if (archived !== 'include') where.push('r.archived_at IS NULL')
    if (historical === 'only') where.push("r.tags LIKE '%历史导入%'")
    else if (historical === 'exclude') where.push("(r.tags IS NULL OR r.tags NOT LIKE '%历史导入%')")
    if (project) {
      // 多项目：主项目或**任一挂载项目**命中都算（否则「在 spms-app 里也能开发」的需求筛不出来）
      const proj = this.ensureProject(project, { create: false })
      const pid = proj?.id ?? slugify(project)
      where.push('(r.project_id = ? OR EXISTS (SELECT 1 FROM requirement_projects rp WHERE rp.requirement_id = r.id AND rp.project_id = ?))')
      args.push(pid, pid)
    }
    if (tag) {
      // 标签存成逗号拼接的一列：两侧补逗号再 LIKE，做**整词**匹配
      // （否则「评审」会把「待评审」也捞进来）
      where.push("(',' || REPLACE(r.tags, ' ', '') || ',') LIKE ?")
      args.push(`%,${String(tag).trim()},%`)
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
    // 排序：默认**新到旧**（新建的排最前）。需求列表原先按「最近开发」排，
    // 结果刚建的需求被压在一堆老需求下面（用户反馈「默认排序新到旧」）。三种口径都留着，面板可切。
    const ORDER = {
      created: 'ORDER BY r.created_at DESC, r.id DESC',
      updated: 'ORDER BY r.updated_at DESC, r.id DESC',
      worked: "ORDER BY COALESCE(r.last_worked_at, '') DESC, r.updated_at DESC",
    }
    const orderBy = ORDER[String(sort ?? 'created')] ?? ORDER.created
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM requirements r ${clause}`).get(...args)?.n ?? 0)
    const rows = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name,
           (SELECT COUNT(*) FROM work_logs w WHERE w.requirement_id = r.id) AS work_count,
           (SELECT MAX(date) FROM work_logs w WHERE w.requirement_id = r.id) AS last_work_date
         FROM requirements r LEFT JOIN projects p ON p.id = r.project_id
         ${clause}
         ${orderBy}
         LIMIT ? OFFSET ?`,
      )
      .all(...args, Number(limit), Number(offset))
    return { total, items: this.attachLinks(rows) }
  }

  /**
   * 台账里用过的全部标签 + 各自条数（按条数降序）。
   * 面板的「标签」下拉与表单里的输入补全都读它 —— 一处聚合，两个入口口径一致。
   */
  listTags({ archived = 'exclude', project = null } = {}) {
    const where = ["r.tags IS NOT NULL", "TRIM(r.tags) <> ''"]
    const args = []
    if (archived === 'only') where.push('r.archived_at IS NOT NULL')
    else if (archived !== 'include') where.push('r.archived_at IS NULL')
    if (project) {
      const proj = this.ensureProject(project, { create: false })
      where.push('r.project_id = ?')
      args.push(proj?.id ?? slugify(project))
    }
    const rows = this.db.prepare(`SELECT r.tags FROM requirements r WHERE ${where.join(' AND ')}`).all(...args)
    const counts = new Map()
    for (const row of rows) {
      for (const tag of parseTags(row.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      // 同条数时按码位排序：确定性优先（localeCompare 的 zh 排序随 ICU 版本变化，下拉顺序会飘）
      .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
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

  /**
   * 编辑一条开发记录（只传要改的字段）。
   *
   * 扫描派生的记录也允许改：`work_logs` 的部分唯一索引保证重扫时 `INSERT OR IGNORE`
   * 不会再插一条，所以**改过的内容不会被下次增量扫描覆盖**。
   */
  updateLog(id, patch = {}) {
    const existing = this.db.prepare('SELECT * FROM work_logs WHERE id = ?').get(Number(id))
    if (!existing) return null
    const project = patch.project !== undefined ? this.ensureProject(patch.project) : this.db.prepare('SELECT * FROM projects WHERE id = ?').get(existing.project_id) ?? null
    let requirementId = existing.requirement_id
    if (patch.requirement !== undefined) {
      const ref = String(patch.requirement ?? '').trim()
      if (!ref) requirementId = ''
      else {
        const found = this.getRequirement(ref, { project: project?.id ?? null })
        requirementId = found?.id ?? deriveRequirementId(this.reqPrefix(project), ref.replace(/^[A-Za-z-]+[-_]?/, '') || ref)
      }
    }
    const date = patch.date !== undefined ? String(patch.date).trim() || existing.date : existing.date
    const minutes =
      patch.minutes === undefined
        ? existing.minutes
        : patch.minutes === null || patch.minutes === ''
          ? null
          : Number.isFinite(Number(patch.minutes))
            ? Number(patch.minutes)
            : existing.minutes
    this.db
      .prepare('UPDATE work_logs SET date = ?, project_id = ?, requirement_id = ?, kind = ?, title = ?, detail = ?, minutes = ? WHERE id = ?')
      .run(
        date,
        project?.id ?? existing.project_id ?? '',
        requirementId,
        patch.kind !== undefined ? normKind(patch.kind) : existing.kind,
        patch.title !== undefined ? String(patch.title).trim() || existing.title : existing.title,
        patch.detail === undefined ? existing.detail : patch.detail === null || patch.detail === '' ? null : String(patch.detail),
        minutes,
        Number(id),
      )
    if (requirementId) this.touchRequirementWork(requirementId, date)
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
  search({ q = null, project = null, requirement = null, tag = null, from = null, to = null, kind = null, archived = 'exclude', sort = 'created', limit = 60 } = {}) {
    const reqs = this.listRequirements({ project, q, requirement, tag, archived, sort, limit })
    let logQuery = { project, from, to, kind, archived, limit }
    if (requirement) logQuery.requirement = requirement
    else if (q) logQuery.q = q
    const logs = this.listLogs(logQuery)
    // days 与 report 共用一个口径（活动 + 手工记录都会出现），避免两个视图对不上
    const days = this.report({ project, requirement, from, to, limit: 30 }).days
    return { requirements: reqs.items, requirementTotal: reqs.total, logs: logs.items, logTotal: logs.total, days }
  }

  // ── P1：需求 ↔ 代码 影响索引（git 事实）────────────────────────────────
  /**
   * 扫描一个/全部项目的 git 历史，落 code_touches + code_recent + code_scans。
   * 只读 git；增量：HEAD 没变就跳过（除非 force）。
   * @param {{ project?: string|null, sinceDays?: number, force?: boolean, limitProjects?: number }} [opts]
   */
  async scanCode({ project = null, sinceDays = DEFAULT_SINCE_DAYS, force = false, limitProjects = 30 } = {}) {
    const targets = project
      ? [this.ensureProject(project, { create: false })].filter(Boolean)
      : (this.db.prepare('SELECT * FROM projects WHERE archived_at IS NULL ORDER BY last_seen_at DESC LIMIT ?').all(Number(limitProjects)) ?? [])
    const results = []
    const ts = nowMs()
    for (const proj of targets) {
      const root = proj?.root ? String(proj.root) : null
      if (!root || !existsSync(root)) {
        results.push({ project: proj?.id ?? null, skipped: '没有本地目录（无法跑 git）' })
        continue
      }
      const head = gitHead(root)
      const prev = this.db.prepare('SELECT * FROM code_scans WHERE project_id = ?').get(proj.id)
      if (!force && head && prev?.head === head) {
        results.push({ project: proj.id, skipped: 'HEAD 未变，跳过', head, coverage: prev.coverage ?? null, commits: prev.commits ?? 0 })
        continue
      }
      const scan = scanGitRepo(root, { sinceDays })
      if (!scan.ok) {
        this.db
          .prepare('INSERT OR REPLACE INTO code_scans (project_id, scanned_at, since_days, commits, numbered, coverage, head, error) VALUES (?, ?, ?, 0, 0, 0, ?, ?)')
          .run(proj.id, ts, Number(sinceDays), head, scan.error ?? '扫描失败')
        results.push({ project: proj.id, error: scan.error })
        continue
      }
      const insertTouch = this.db.prepare(
        `INSERT INTO code_touches (requirement_id, project_id, path, module, commits, first_seen, last_seen, sample, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(requirement_id, project_id, path) DO UPDATE SET
           commits = excluded.commits, module = excluded.module,
           first_seen = MIN(COALESCE(code_touches.first_seen, excluded.first_seen), excluded.first_seen),
           last_seen = MAX(COALESCE(code_touches.last_seen, excluded.last_seen), excluded.last_seen),
           sample = excluded.sample, updated_at = excluded.updated_at`,
      )
      const insertRecent = this.db.prepare(
        `INSERT INTO code_recent (project_id, path, module, commits, last_seen, sample, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, path) DO UPDATE SET
           commits = excluded.commits, module = excluded.module,
           last_seen = MAX(COALESCE(code_recent.last_seen, excluded.last_seen), excluded.last_seen),
           sample = excluded.sample, updated_at = excluded.updated_at`,
      )
      const run = this.writeQueue?.run?.bind(this.writeQueue)
      const apply = () => {
        for (const row of scan.touches) insertTouch.run(row.requirementId, proj.id, row.path, row.module, row.commits, row.firstSeen, row.lastSeen, row.sample, ts)
        for (const row of scan.recent) insertRecent.run(proj.id, row.path, row.module, row.commits, row.lastSeen, row.sample, ts)
        this.db
          .prepare(
            `INSERT OR REPLACE INTO code_scans
              (project_id, scanned_at, since_days, commits, numbered, coverage, head, error, merges, merge_numbered, signals, skipped_huge_merges)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
          )
          .run(proj.id, ts, Number(sinceDays), scan.commits, scan.numbered, scan.coverage, head, scan.merges ?? 0, scan.mergeNumbered ?? 0, scan.signals ?? 0, scan.skippedHugeMerges ?? 0)
      }
      // 写队列在 web 宿主里是串行的；没有队列（CLI/测试）就直接写
      if (run) await run(apply)
      else apply()
      results.push({
        project: proj.id,
        commits: scan.commits,
        numbered: scan.numbered,
        coverage: scan.coverage,
        merges: scan.merges ?? 0,
        mergeNumbered: scan.mergeNumbered ?? 0,
        signals: scan.signals ?? 0,
        skippedHugeMerges: scan.skippedHugeMerges ?? 0,
        requirements: new Set(scan.touches.map((row) => row.requirementId)).size,
        files: new Set(scan.touches.map((row) => row.path)).size,
      })
    }
    return { ok: true, sinceDays: Number(sinceDays), results }
  }

  /** 一条需求的代码落点（按模块聚合，给面板/工具一行一条）。 */
  listCodeTouches(requirementId, { project = null, limit = 8 } = {}) {
    const id = String(requirementId ?? '').trim()
    if (!id) return []
    try {
      const rows = project
        ? this.db.prepare('SELECT * FROM code_touches WHERE requirement_id = ? AND project_id = ? ORDER BY commits DESC').all(id, this.ensureProject(project, { create: false })?.id ?? slugify(project))
        : this.db.prepare('SELECT * FROM code_touches WHERE requirement_id = ? ORDER BY commits DESC').all(id)
      return groupTouchesByModule(rows, { limit })
    } catch {
      return []
    }
  }

  /** 代码索引的原始行（含具体文件与提交样本）。 */
  listCodeFiles(requirementId, { project = null, limit = 40 } = {}) {
    const id = String(requirementId ?? '').trim()
    if (!id) return []
    try {
      return project
        ? this.db.prepare('SELECT * FROM code_touches WHERE requirement_id = ? AND project_id = ? ORDER BY commits DESC LIMIT ?').all(id, this.ensureProject(project, { create: false })?.id ?? slugify(project), Number(limit))
        : this.db.prepare('SELECT * FROM code_touches WHERE requirement_id = ? ORDER BY commits DESC LIMIT ?').all(id, Number(limit))
    } catch {
      return []
    }
  }

  /** 每个项目的扫描状态（含带号覆盖率 —— 索引可信度的唯一输入约束）。 */
  codeCoverage() {
    try {
      return this.db
        .prepare(
          `SELECT s.*, p.name AS project_name,
             (SELECT COUNT(*) FROM code_touches t WHERE t.project_id = s.project_id) AS touch_rows,
             (SELECT COUNT(DISTINCT t.requirement_id) FROM code_touches t WHERE t.project_id = s.project_id) AS requirements
           FROM code_scans s LEFT JOIN projects p ON p.id = s.project_id ORDER BY s.scanned_at DESC`,
        )
        .all()
    } catch {
      return []
    }
  }

  /** 某个模块最近被谁在动（不带需求号的提交也算）—— 漂移对账/评审都用得上。 */
  listRecentModuleActivity({ project = null, module = null, limit = 20 } = {}) {
    try {
      const where = []
      const args = []
      if (project) {
        where.push('project_id = ?')
        args.push(this.ensureProject(project, { create: false })?.id ?? slugify(project))
      }
      if (module) {
        where.push('module LIKE ?')
        args.push(`%${module}%`)
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
      return this.db.prepare(`SELECT * FROM code_recent ${clause} ORDER BY last_seen DESC, commits DESC LIMIT ?`).all(...args, Number(limit))
    } catch {
      return []
    }
  }

  // ── P2：文档漂移三方对账 ───────────────────────────────────────────────
  /**
   * 给一条/全部需求拍文档快照（版本号 + 正文 hash + 摘要，**不存全文**）。
   * @param {{ id?: string|null, all?: boolean, fetchText?: Function, limit?: number }} [opts]
   */
  async refreshDocSnapshots({ id = null, all = false, fetchText = null, limit = 50 } = {}) {
    const targets = id
      ? [this.getRequirement(id)].filter(Boolean)
      : all
        ? this.listRequirements({ archived: 'exclude', limit: Number(limit) }).items
        : []
    const results = []
    for (const req of targets) {
      const url = req.doc_url ?? this.listLinks(req.id).find((l) => l.kind === 'doc')?.url ?? null
      if (!url) {
        results.push({ id: req.id, skipped: '没有需求文档链接' })
        continue
      }
      const snap = await snapshotDoc(url, { fetchText })
      const ts = nowMs()
      this.db
        .prepare(
          `INSERT OR REPLACE INTO doc_snapshots (requirement_id, url, title, version, hash, excerpt, checks, changed_at, fetched_at, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          req.id,
          url,
          snap.title ?? null,
          snap.version ?? null,
          snap.hash ?? null,
          snap.excerpt ?? null,
          snap.checks ? JSON.stringify(snap.checks) : null,
          snap.changedAt ?? null,
          ts,
          snap.ok ? null : (snap.error ?? '快照失败'),
        )
      results.push({ id: req.id, ok: snap.ok, version: snap.version ?? null, hash: snap.hash ?? null, changedAt: snap.changedAt ?? null, error: snap.ok ? null : snap.error })
    }
    return { ok: true, snapshots: results }
  }

  /** 已完成的对账结果（面板直接读它）。 */
  listDrift({ verdict = null, limit = 200 } = {}) {
    try {
      const where = verdict ? 'WHERE d.verdict = ?' : ''
      const args = verdict ? [verdict] : []
      return this.db
        .prepare(
          `SELECT d.*, r.title AS req_title, r.status AS req_status, p.name AS project_name
             FROM requirement_drift d
             LEFT JOIN requirements r ON r.id = d.requirement_id
             LEFT JOIN projects p ON p.id = r.project_id
             ${where}
            ORDER BY CASE d.verdict WHEN 'doc-stale' THEN 0 WHEN 'unknown' THEN 1 WHEN 'doc-newer' THEN 2 WHEN 'silent' THEN 3 ELSE 4 END,
                     d.computed_at DESC
            LIMIT ?`,
        )
        .all(...args, Number(limit))
    } catch {
      return []
    }
  }

  /**
   * 算对账：文档（快照）+ 代码（code_touches 最近）+ 记录（work_logs 最近）→ requirement_drift。
   * 纯本地（不联网），所以可以随时重算；文档侧的时间要先跑一次 refreshDocSnapshots。
   */
  computeDrift({ silentDays = 30, today = null, syncTodos = true } = {}) {
    const requirements = this.listRequirements({ archived: 'include', limit: 500 }).items
    const ts = nowMs()
    const upsert = this.db.prepare(
      `INSERT OR REPLACE INTO requirement_drift
        (requirement_id, verdict, doc_version, doc_changed_at, doc_hash, code_last_at, session_last_at, evidence, computed_at, signals, signal_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const rows = []
    for (const req of requirements) {
      const snap = this.db.prepare('SELECT * FROM doc_snapshots WHERE requirement_id = ?').get(req.id) ?? null
      const code = this.db.prepare('SELECT MAX(last_seen) AS last FROM code_touches WHERE requirement_id = ?').get(req.id)?.last ?? null
      const session = this.db.prepare('SELECT MAX(date) AS last FROM work_logs WHERE requirement_id = ?').get(req.id)?.last ?? null
      // 文档侧时间：优先 Confluence 的 `version.when`；没有就退化成"上次拍快照的时间"
      const docChangedAt = snap?.changed_at ?? null
      const docAt = docChangedAt ? String(docChangedAt).slice(0, 10) : snap?.fetched_at ? new Date(Number(snap.fetched_at)).toISOString().slice(0, 10) : null
      // 关键：文档最后更新**之后**的记录里有没有「变更语义」—— 这才是漂移证据
      const records = this.db
        .prepare('SELECT date, title, detail, source, kind FROM work_logs WHERE requirement_id = ? ORDER BY date DESC LIMIT 100')
        .all(req.id)
      // 没有文档基准时不收集信号（收集了也不能判定，反而会造出假阳性待办）
      const signals = docAt ? changeSignalsIn(records, { afterDay: docAt, limit: 5 }) : []
      const verdict = verdictOf({ docChangedAt: docAt, codeLastAt: code, sessionLastAt: session, signals, today, silentDays })
      const evidence = [...verdict.evidence, snap?.version ? `文档版本 v${snap.version}` : null, verdict.reason].filter(Boolean).join('　|　')
      upsert.run(req.id, verdict.verdict, snap?.version ?? null, docAt, snap?.hash ?? null, code, session, evidence, ts, signals.length ? JSON.stringify(signals) : null, signals.length)
      rows.push({
        requirementId: req.id,
        title: req.title,
        verdict: verdict.verdict,
        reason: verdict.reason,
        evidence: verdict.evidence,
        signals,
        docChangedAt: docAt,
        codeLastAt: code,
        sessionLastAt: session,
        docVersion: snap?.version ?? null,
      })
    }
    // P4：开关打开时顺手同步待办（幂等；关闭时 syncDriftTodos 自己会短路）。
    // ⚠️ syncTodos:false 是给 syncDriftTodos() 用的：它自己会先重算再同步，避免互相调用成死循环
    let todoSync = null
    if (syncTodos) {
      try {
        todoSync = this.syncDriftTodos({ skipRecompute: true })
      } catch {
        todoSync = null
      }
    }
    return { ok: true, computedAt: ts, silentDays: Number(silentDays), rows, todoSync }
  }

  /** 文档快照（面板上显示"这条需求的文档最近读过没/版本多少"）。 */
  listDocSnapshots({ limit = 200 } = {}) {
    try {
      return this.db.prepare('SELECT * FROM doc_snapshots ORDER BY fetched_at DESC LIMIT ?').all(Number(limit))
    } catch {
      return []
    }
  }

  // ── P3：一键评审影响报告 ───────────────────────────────────────────────
  /**
   * 生成一条需求的「评审影响报告」（DESIGN §9.4）：相关历史需求 + 冲突点 + 要问的问题 + 文档缺口。
   * 全部基于前三期的本地数据（台账 / git 索引 / 文档快照），**不联网**，所以随时可跑。
   */
  buildReviewReport(id, { project = null, platform = null, relatedLimit = 8, now = null, candidate = false } = {}) {
    const row = this.getRequirement(id)
    let target = row ? this.attachLinksOne(this.requirementDetail(row.id)) : null
    // 候选（还没采纳进台账）也能评审：按需求号临时构造 target —— 判断"值不值得采纳"要在采纳之前
    if (!target && candidate) {
      const cand = this.db.prepare('SELECT * FROM discover_candidates WHERE no = ?').get(String(id))
      if (!cand) return { ok: false, error: `没有找到候选 ${id}` }
      target = {
        id: String(cand.no),
        no: String(cand.no),
        title: cand.title ?? null,
        status: 'candidate',
        projectId: cand.project_id ?? null,
        projects: cand.project_id ? [{ projectId: cand.project_id, projectName: cand.project_id, platform: null, primary: true }] : [],
        links: [
          cand.doc_url ? { kind: 'doc', url: cand.doc_url, title: '需求文档' } : null,
          cand.story_url ? { kind: 'other', url: cand.story_url, title: '禅道需求单' } : null,
        ].filter(Boolean),
        codeTouches: this.listCodeTouches(String(cand.no), { limit: 12 }),
        // 候选之间互相比：这批历史里跟它重的（采纳之前就能看到"谁跟谁是一件事"）
        overlaps: (this.listDiscoverCandidates({ limit: 500 }).find((x) => String(x.no) === String(cand.no))?.overlaps ?? []),
        __candidate: true,
        __reqStatus: cand.req_status ?? null,
        __openedBy: cand.opened_by ?? null,
      }
    }
    if (!target) return { ok: false, error: `没有找到需求 ${id}` }
    // 候选：台账里所有需求（含归档，归档只作参考），各自带上代码落点
    const candidates = this.listRequirements({ archived: 'include', limit: 500 }).items.map((item) => ({
      ...item,
      codeTouches: this.listCodeTouches(item.id, { limit: 12 }),
    }))
    const related = findRelatedRequirements(target, candidates, { limit: relatedLimit })
    // 漂移：本地重算一次（纯本地、幂等），保证报告里的结论是新的
    try {
      this.computeDrift()
    } catch {
      /* 算不动不影响报告主体 */
    }
    const driftRow = this.listDrift({ limit: 500 }).find((r) => r.requirement_id === target.id) ?? null
    const snapshot = this.listDocSnapshots({ limit: 500 }).find((r) => r.requirement_id === target.id) ?? null
    if (target.__candidate && target.__reqStatus) target.status = String(target.__reqStatus)
    const coverageRow = this.codeCoverage().find((c) => c.project_id === (project ?? target.projectId)) ?? null
    // 优先用抓快照时对全文算的命中标记（摘要截断会造成假警报）
    const gaps = docGaps(snapshot?.excerpt ?? null, snapshot?.checks ?? null)
    const reuse = reuseCheck({ related })
    const frontend = frontendCheck({ target, related, docSnapshot: snapshot })
    const markdown = renderReviewReport({
      target,
      related,
      reuse,
      frontend,
      drift: driftRow,
      gaps,
      docSnapshot: snapshot,
      coverage: coverageRow ? Number(coverageRow.coverage) : null,
      project: project ? this.ensureProject(project, { create: false }) : null,
      platform,
      now,
    })
    return {
      ok: true,
      markdown,
      requirement: { id: target.id, title: target.title, status: target.status, projects: target.projects ?? [] },
      related,
      reuse,
      frontend,
      drift: driftRow,
      gaps,
      docSnapshot: snapshot ? { version: snapshot.version, changed_at: snapshot.changed_at, fetched_at: snapshot.fetched_at } : null,
      coverage: coverageRow ? Number(coverageRow.coverage) : null,
    }
  }

  // ── P4：变更待办（默认关闭；开启后把 doc-stale 变成可执行的一条）────────
  /** 待办开关：存在 meta 里（`drift.todoEnabled`），默认跟随配置、配置缺省 = 关。 */
  driftTodoEnabled() {
    const stored = getMeta(this.db, 'drift.todoEnabled', null)
    if (stored === null || stored === undefined) return this.config?.driftTodo?.enabled === true
    return String(stored) === 'true' || stored === true
  }

  setDriftTodoEnabled(enabled) {
    setMeta(this.db, 'drift.todoEnabled', enabled ? 'true' : 'false')
    return { ok: true, enabled: Boolean(enabled) }
  }

  listDriftTodos({ status = 'open', limit = 100 } = {}) {
    try {
      const where = status === 'all' ? '' : 'WHERE t.status = ?'
      const args = status === 'all' ? [] : [String(status)]
      return this.db
        .prepare(
          `SELECT t.*, r.title AS req_title, r.status AS req_status, p.name AS project_name
             FROM drift_todos t
             LEFT JOIN requirements r ON r.id = t.requirement_id
             LEFT JOIN projects p ON p.id = r.project_id
             ${where}
            ORDER BY t.status ASC, t.created_at DESC LIMIT ?`,
        )
        .all(...args, Number(limit))
    } catch {
      return []
    }
  }

  closeDriftTodo(id, { reason = '手工标记完成' } = {}) {
    const res = this.db
      .prepare("UPDATE drift_todos SET status = 'done', closed_at = ?, updated_at = ?, close_reason = ? WHERE id = ? AND status = 'open'")
      .run(nowMs(), nowMs(), String(reason), Number(id))
    return { ok: true, changed: Number(res.changes ?? 0) }
  }

  /**
   * 按最新对账结果同步待办（幂等）：
   *   · `doc-stale` 的需求 → 建/更新一条 open 待办（signature = 变更信号指纹，同一批变更新来会更新同一条）；
   *   · 已经不再 `doc-stale` 的需求 → **自动关闭**它之前那条（并在 close_reason 里写明原因）。
   * 开关关闭时不做任何事（返回 enabled:false），避免噪声。
   */
  syncDriftTodos({ dueDays = 0, force = false, skipRecompute = false } = {}) {
    const enabled = this.driftTodoEnabled()
    if (!enabled && !force) return { ok: true, enabled: false, created: 0, updated: 0, closed: 0, todos: [] }
    // 必须先按最新快照重算一遍：否则文档补上之后，这里读到的还是旧结论 → 待办关不掉（实测踩到）
    if (!skipRecompute) {
      try {
        this.computeDrift({ syncTodos: false })
      } catch {
        /* 重算失败就按现有结论同步 */
      }
    }
    const rows = this.listDrift({ limit: 500 })
    const ts = nowMs()
    const due = dueDays > 0 ? new Date(ts + Number(dueDays) * 86400000).toISOString().slice(0, 10) : null
    let created = 0
    let updated = 0
    let closed = 0
    const upsert = this.db.prepare(
      `INSERT INTO drift_todos (requirement_id, title, detail, signal_date, signature, status, due_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)
       ON CONFLICT(requirement_id, signature) WHERE status = 'open' DO UPDATE SET
         title = excluded.title, detail = excluded.detail, due_at = excluded.due_at, updated_at = excluded.updated_at`,
    )
    for (const row of rows) {
      if (row.verdict !== 'doc-stale') continue
      let signals = []
      try {
        signals = row.signals ? JSON.parse(row.signals) : []
      } catch {
        signals = []
      }
      // 签名 = **漂移期**（以文档版本边界为界），不是"最新那条变更"：
      // 同一漂移期内又来一条新变更 → 更新同一条待办；文档更新后再漂移 → 才是新的一条（实测踩到过按日期签名导致重复）
      const signature = `stale|${row.doc_changed_at ?? '-'}|${row.doc_version ?? '-'}`
      const before = this.db.prepare("SELECT id FROM drift_todos WHERE requirement_id = ? AND signature = ? AND status = 'open'").get(row.requirement_id, signature)
      const title = `把 ${row.requirement_id} 的这次变更补进需求文档`
      const detail = [
        `文档停在 ${row.doc_changed_at ?? '未知'}${row.doc_version ? `（v${row.doc_version}）` : ''}`,
        ...signals.map((sig) => `${sig.date}「${sig.text}」`),
        row.req_title ? `需求：${row.req_title}` : null,
        '（由 dsh-project-hub 变更对账自动生成）',
      ]
        .filter(Boolean)
        .join('\n')
      upsert.run(row.requirement_id, title, detail, signals[0]?.date ?? row.doc_changed_at ?? null, signature, due, ts, ts)
      if (before) updated += 1
      else created += 1
      // 收敛：同一需求下**其它**开放待办（旧签名/手工建的）一并关掉，保证"一条需求同时只有一条在跟进"
      const superseded = this.db
        .prepare("UPDATE drift_todos SET status = 'done', closed_at = ?, updated_at = ?, close_reason = ? WHERE requirement_id = ? AND status = 'open' AND signature <> ?")
        .run(ts, ts, '已并入同需求的新待办', row.requirement_id, signature)
      closed += Number(superseded.changes ?? 0)
    }
    // 闭环：不再 doc-stale 的需求，把它之前那条自动关掉
    const openRows = this.db.prepare("SELECT * FROM drift_todos WHERE status = 'open'").all()
    const staleIds = new Set(rows.filter((r) => r.verdict === 'doc-stale').map((r) => r.requirement_id))
    for (const todo of openRows) {
      if (staleIds.has(todo.requirement_id)) continue
      const res = this.db
        .prepare("UPDATE drift_todos SET status = 'done', closed_at = ?, updated_at = ?, close_reason = ? WHERE id = ? AND status = 'open'")
        .run(ts, ts, '文档已更新/已不再判定为漂移，自动关闭', todo.id)
      closed += Number(res.changes ?? 0)
    }
    return { ok: true, enabled: true, created, updated, closed, todos: this.listDriftTodos({ status: 'open', limit: 50 }) }
  }

  // ── 发现：历史需求候选箱（只排队，采纳了才进台账）──────────────────────
  /**
   * 扫共享源找出"看起来是需求"的东西：Confluence 文档树（含**别人建的**）+ git 带号分支。
   * 只写候选箱，**不动台账**。
   * @param {{ rootPageId?: string|null, sinceDay?: string|null, git?: boolean, fetchText?: Function, maxPages?: number }} [opts]
   */
  async discoverCandidates({
    rootPageId = null,
    sinceDay = null,
    git = true,
    zentao = true,
    zentaoProducts = null,
    zentaoMaxPages = 3,
    zentaoMaxDetails = 20,
    fetchText = null,
    maxPages = 2000,
    base: baseUrl = null,
    wikiBase: wikiBaseArg = null,
    zentaoBase: zenBaseArg = null,
    rootPageIdArg = null,
    zentaoProductsArg = null,
    today = null,
  } = {}) {
    const rootArg = rootPageId ?? rootPageIdArg
    const settings = this.discoverSettings()
    const zentaoBase = zenBaseArg ?? settings.zentaoBase
    const wikiBase = baseUrl ?? wikiBaseArg ?? settings.wikiBase
    if (zenBaseArg || rootArg || zentaoProductsArg || wikiBaseArg) {
      this.saveDiscoverSettings({ rootPageId: rootArg ?? undefined, zentaoBase: zenBaseArg ?? undefined, wikiBase: wikiBaseArg ?? undefined, zentaoProducts: zentaoProductsArg ?? undefined })
    }
    const known = new Set(this.listRequirements({ archived: 'include', limit: 1000 }).items.map((r) => String(r.no ?? r.id)))
    const myModules = new Set()
    for (const req of this.listRequirements({ archived: 'exclude', limit: 200 }).items) {
      for (const row of this.listCodeTouches(req.id, { limit: 20 })) myModules.add(row.module)
    }
    // ⚠️ 需求列表是大页面（实测 ~350KB），而**分页器在页面最末**：默认字节上限会把它截掉 →
    //    翻页模板取不到、只能停在第一页。所以这里给足上限（并留一点余量）。
    const fetcher = typeof fetchText === 'function' ? fetchText : (url) => fetchPage(url, { maxBytes: 4 * 1024 * 1024 })
    // CQL 要绝对地址：优先配置，其次从台账里已有的文档链接推 origin（实测漏了这步 → "Failed to parse URL from /rest/..."）
    const base = wikiBase ?? this.originFromKnownDocs() ?? null
    const report = { confluence: null, git: null, base }

    let fromPages = []
    const root = rootArg ?? settings.rootPageId ?? null
    if (root) {
      // 上次是不是扫到一半被打断了？是的话从游标续扫（这个实例的会话会中途失效）
      const prev = this.db.prepare("SELECT cursor FROM discover_state WHERE source = 'confluence'").get()
      const startAt = prev?.cursor && String(prev.cursor).startsWith('offset:') ? Number(String(prev.cursor).slice(7)) || 0 : 0
      const scan = await scanConfluenceTree({ rootPageId: root, fetchText: fetcher, sinceDay, maxPages, base, startAt })
      // `ok:false` + `partial:true` 表示"抓了一部分就停了" —— 已抓到的页照样用（实测丢了 600 页）
      if (scan.pages?.length > 0) fromPages = candidatesFromPages(scan.pages)
      report.confluence = {
        ok: scan.ok,
        partial: scan.partial === true,
        total: scan.total ?? 0,
        pages: scan.pages?.length ?? 0,
        calls: scan.calls,
        candidates: fromPages.length,
        from: scan.startedAt ?? startAt,
        nextStart: scan.nextStart ?? 0,
        finished: scan.finished === true,
        error: scan.error ?? null,
        // 会话失效是这类内部站点最常见的失败：把"怎么办"直接写进报告，面板/工具照原样显示
        hint: scan.error ? '文档树要靠浏览器登录态（中继）。请在浏览器里打开一次该站点确认已登录，然后再扫；已读到的部分会保留，游标会接着上次继续。' : null,
      }
      this.db
        .prepare('INSERT OR REPLACE INTO discover_state (source, cursor, scanned_at, scanned, found, note) VALUES (?, ?, ?, ?, ?, ?)')
        .run('confluence', `offset:${scan.nextStart ?? 0}`, nowMs(), scan.pages?.length ?? 0, fromPages.length, scan.error ?? null)
    } else {
      report.confluence = { ok: false, skipped: '没有配置需求文档根页面（discover.rootPageId）' }
    }

    // 禅道：**权威来源**（需求号/标题/状态登记在案）。产品列表可配置，也可从台账项目推
    let fromStories = []
    if (zentao) {
      const products = (zentaoProducts ?? settings.zentaoProducts ?? []).map(String).filter(Boolean)
      if (products.length === 0) {
        report.zentao = { ok: false, skipped: '没有配置禅道产品（discover.zentaoProducts 或 scan 参数 zentaoProducts）' }
      } else {
        const scan = await scanZentaoStories({
          fetchText: fetcher,
          productIds: products,
          base: zentaoBase ?? 'https://zentao.example.com',
          // 详情页里有 `STORY #N`（= 需求号）与**描述区里的需求 wiki** —— 禅道是权威入口，默认拉详情
          withDetail: true,
          maxDetails: zentaoMaxDetails,
          maxPages: zentaoMaxPages,
        })
        fromStories = candidatesFromStories(scan.stories, { extractNo: extractRequirementNo })
        report.zentao = {
          ok: true,
          calls: scan.calls,
          stories: scan.stories.length,
          candidates: fromStories.length,
          products: scan.products,
          pagination: true,
          wikiFound: fromStories.filter((x) => x.wikiUrl).length,
          error: scan.products.find((p) => p.error)?.error ?? null,
        }
        this.db
          .prepare('INSERT OR REPLACE INTO discover_state (source, cursor, scanned_at, scanned, found, note) VALUES (?, ?, ?, ?, ?, ?)')
          .run('zentao', products.join(','), nowMs(), scan.stories.length, fromStories.length, report.zentao.error)
      }
    }

    let fromTouches = []
    if (git) {
      const touchRows = this.db
        .prepare(
          `SELECT t.requirement_id, t.project_id, t.module, t.path, t.commits, t.first_seen, t.last_seen, t.sample
             FROM code_touches t ORDER BY t.last_seen DESC LIMIT 5000`,
        )
        .all()
      fromTouches = candidatesFromTouches({ touches: touchRows, known })
      report.git = { ok: true, touches: touchRows.length, candidates: fromTouches.length }
      this.db
        .prepare('INSERT OR REPLACE INTO discover_state (source, cursor, scanned_at, scanned, found, note) VALUES (?, ?, ?, ?, ?, NULL)')
        .run('git', null, nowMs(), touchRows.length, fromTouches.length)
    }

    // 已在台账里的一律不进候选（含归档：归档的是"处理过"的）
    const merged = mergeCandidates({ fromPages, fromTouches, fromStories, myModules, today: today ?? dateInTz() }).filter((item) => !known.has(String(item.no)))

    const ignored = new Set(this.db.prepare("SELECT no FROM discover_candidates WHERE status = 'ignored'").all().map((r) => r.no))
    const adopted = new Set(this.db.prepare("SELECT no FROM discover_candidates WHERE status = 'adopted'").all().map((r) => r.no))
    let saved = 0
    const upsert = this.db.prepare(
      `INSERT INTO discover_candidates
        (no, title, doc_url, doc_id, doc_version, doc_changed_at, doc_creator, project_id, title_from, modules, code_commits, code_last_at, same_module_as, signals, score, status, discovered_at, updated_at, story_url, story_id, opened_by, req_status, source)
       VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(no) DO UPDATE SET
         title = excluded.title, doc_url = excluded.doc_url, doc_id = excluded.doc_id,
         doc_changed_at = excluded.doc_changed_at, project_id = COALESCE(excluded.project_id, discover_candidates.project_id),
         title_from = excluded.title_from, modules = excluded.modules, code_commits = excluded.code_commits,
         code_last_at = excluded.code_last_at, same_module_as = excluded.same_module_as,
         signals = excluded.signals, score = excluded.score, updated_at = excluded.updated_at,
         story_url = excluded.story_url, story_id = excluded.story_id, opened_by = excluded.opened_by,
         req_status = excluded.req_status, source = excluded.source
       WHERE discover_candidates.status = 'candidate'`,
    )
    const ts = nowMs()
    const seen = new Set()
    for (const item of merged) {
      if (ignored.has(item.no) || adopted.has(item.no)) continue
      seen.add(String(item.no))
      upsert.run(
        item.no,
        item.title ?? null,
        item.docUrl ?? null,
        item.docId ?? null,
        item.docChangedAt ?? null,
        item.projectId ?? null,
        item.titleFrom ?? null,
        JSON.stringify(item.modules ?? []),
        Number(item.codeCommits ?? 0),
        item.codeLastAt ?? null,
        JSON.stringify(item.sameModuleAs ?? []),
        JSON.stringify(item.signals ?? []),
        Number(item.score ?? 0),
        ts,
        ts,
        item.storyUrl ?? null,
        item.storyId ?? null,
        item.openedBy ?? null,
        item.reqStatus ?? null,
        item.storyUrl ? 'zentao' : item.docUrl ? 'confluence' : 'git',
      )
      saved += 1
    }
    // 候选箱以**最近一次扫描**为准：这轮没再出现的候选要清掉（否则上一轮的假候选会赖着不走 —— 实测踩到）。
    // ⚠️ 但**按来源分别清理**：某个来源这轮根本没扫到东西（会话失效/失败）时，绝不能拿它当"这些候选不存在"把
    //    上一轮的结果清掉 —— 实测第 2 轮会话失效读到 0 页，把第 1 轮发现的 66 条文档候选全清了。
    // ignored / adopted 是人工结论，永远保留。
    let dropped = 0
    // ⚠️ 只有**全量**扫描才能清理"这轮没扫到"的候选。
    //    增量（sinceDay / 只翻前几页）眼里只有最近那批 —— 拿它当全量会把上一轮的历史候选全清掉（实测清了 151 条）。
    const fullScan = !sinceDay
    const zentaoFull = (report.zentao?.products ?? []).every((p) => p.total !== null && p.fetched >= p.total)
    const sourceOk = {
      git: report.git?.ok === true,
      confluence: fullScan && report.confluence?.finished === true && (report.confluence?.pages ?? 0) > 0,
      zentao: fullScan && report.zentao?.ok === true && zentaoFull,
    }
    const stale = this.db.prepare("SELECT no, source, doc_url FROM discover_candidates WHERE status = 'candidate'").all()
    const del = this.db.prepare("DELETE FROM discover_candidates WHERE no = ? AND status = 'candidate'")
    for (const row of stale) {
      if (seen.has(String(row.no))) continue
      // 按**来源**判定：某来源这轮没扫到（失败/跳过）就不能拿它当"候选不存在"
      const source = row.source ?? (row.doc_url ? 'confluence' : 'git')
      if (sourceOk[source] === false) continue
      dropped += Number(del.run(row.no).changes ?? 0)
    }
    return { ok: true, saved, dropped, candidates: this.listDiscoverCandidates({ limit: 200 }), report }
  }

  /**
   * 发现的运行期设置：**meta 覆盖配置**（仓库里不能写内部站点，所以站点地址允许运行期设一次并记住）。
   * @returns {{ rootPageId:string|null, zentaoBase:string|null, wikiBase:string|null, zentaoProducts:string[] }}
   */
  discoverSettings() {
    const meta = (key) => getMeta(this.db, key, null)
    const products = meta('discover.zentaoProducts')
    const interval = meta('discover.intervalMinutes')
    return {
      /** 定时**增量**发现周期（分钟）；0=关闭。存 meta → 开关即时生效，不用改配置也不用重启 */
      intervalMinutes: Number(interval ?? this.config?.discover?.intervalMinutes ?? 0) || 0,
      rootPageId: meta('discover.rootPageId') ?? this.config?.discover?.rootPageId ?? null,
      zentaoBase: meta('discover.zentaoBase') ?? this.config?.discover?.zentaoBase ?? null,
      wikiBase: meta('discover.wikiBase') ?? this.config?.discover?.baseUrl ?? null,
      zentaoProducts: products
        ? String(products)
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        : (this.config?.discover?.zentaoProducts ?? []).map(String),
    }
  }

  /** 记住运行期设置（只写传了的字段）。 */
  saveDiscoverSettings({ rootPageId = undefined, zentaoBase = undefined, wikiBase = undefined, zentaoProducts = undefined, intervalMinutes = undefined } = {}) {
    const write = (key, value) => {
      if (value === undefined || value === null || value === '') return
      setMeta(this.db, key, Array.isArray(value) ? value.join(',') : String(value))
    }
    write('discover.intervalMinutes', intervalMinutes)
    write('discover.rootPageId', rootPageId)
    write('discover.zentaoBase', zentaoBase)
    write('discover.wikiBase', wikiBase)
    write('discover.zentaoProducts', zentaoProducts)
    return this.discoverSettings()
  }

  /** 从台账里已有的文档/设计链接推一个站点 origin（`https://host`），给 CQL 拼绝对地址用。 */
  originFromKnownDocs() {
    try {
      const rows = this.db.prepare("SELECT url FROM requirement_links WHERE url LIKE 'http%' LIMIT 50").all()
      for (const row of rows) {
        const m = String(row.url ?? '').match(/^(https?:\/\/[^/]+)\//i)
        if (m) return m[1]
      }
      const req = this.db.prepare("SELECT doc_url FROM requirements WHERE doc_url LIKE 'http%' LIMIT 1").get()
      const m = String(req?.doc_url ?? '').match(/^(https?:\/\/[^/]+)\//i)
      return m ? m[1] : null
    } catch {
      return null
    }
  }

  listDiscoverCandidates({ status = 'candidate', limit = 200 } = {}) {
    try {
      // 候选之间互相比（同模块/同关键词）：**全量**算完再截断，否则会漏掉排在后面但确实重叠的
      const all = this.db.prepare('SELECT * FROM discover_candidates WHERE status = ? ORDER BY score DESC, COALESCE(doc_changed_at, code_last_at) DESC').all(String(status))
      const overlaps = candidateOverlaps(all)
      return all.slice(0, Number(limit)).map((row) => ({ ...row, overlaps: overlaps.get(String(row.no)) ?? [] }))
    } catch {
      return []
    }
  }

  discoverState() {
    try {
      return this.db.prepare('SELECT * FROM discover_state ORDER BY source').all()
    } catch {
      return []
    }
  }

  /**
   * 采纳一个候选 → 进台账（带文档链接、项目、标签「历史导入」），并读一次文档标题/创建人/产品。
   * @param {string} no 需求号
   */
  async adoptCandidate(no, { project = null, platform = null, readTitle = true, fetchText = null } = {}) {
    const key = String(no ?? '').trim()
    if (!key) return { ok: false, error: '缺少需求号' }
    const row = this.db.prepare('SELECT * FROM discover_candidates WHERE no = ?').get(key)
    if (!row) return { ok: false, error: `候选箱里没有 ${key}` }
    const projectId = project ?? row.project_id ?? this.primaryProjectId()
    const target = this.ensureProject(projectId, { create: false })
    const docUrl = row.doc_url ? String(row.doc_url) : null
    const storyUrl = row.story_url ? String(row.story_url) : null
    const saved = await this.saveRequirement({
      id: deriveRequirementId(target?.id ?? 'HS', key),
      no: key,
      // 有文档就留空标题 → 让 saveRequirement 去读文档标题（顺带把创建人/产品/版本也读回来）；没文档才用 git 猜的名字
      title: docUrl ? null : (row.title ?? `需求 ${key}`),
      docUrl,
      project: target?.id ?? null,
      projects: target?.id ? [{ project: target.id, platform: platform ?? null }] : undefined,
      status: 'planning',
      tags: ['历史导入'],
      // 禅道需求单是权威来源 → 作为「其它」链接一并存下来，方便点回原单
      links: storyUrl ? [{ kind: 'other', url: storyUrl, title: '禅道需求单' }] : undefined,
      readTitle: Boolean(readTitle && docUrl),
      fetchText,
    })
    this.db.prepare("UPDATE discover_candidates SET status = 'adopted', adopted_at = ?, updated_at = ? WHERE no = ?").run(nowMs(), nowMs(), key)
    return { ok: true, requirement: saved?.requirement ?? null, titleRead: saved?.titleRead ?? null, adopted: key }
  }

  ignoreCandidate(no, { reason = null } = {}) {
    const key = String(no ?? '').trim()
    const res = this.db.prepare("UPDATE discover_candidates SET status = 'ignored', updated_at = ? WHERE no = ?").run(nowMs(), key)
    return { ok: Number(res.changes ?? 0) > 0, ignored: key, reason }
  }

  primaryProjectId() {
    const row = this.db.prepare("SELECT project_id FROM work_logs WHERE project_id IS NOT NULL GROUP BY project_id ORDER BY COUNT(*) DESC LIMIT 1").get()
    return row?.project_id ?? null
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
  report({ from = null, to = null, project = null, requirement = null, limit = 60 } = {}) {
    const days = this.timeline({ from, to, project, requirement, limit })
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
    if (requirement) {
      const req = this.getRequirement(requirement, { project })
      logWhere.push('requirement_id LIKE ?')
      logArgs.push(req ? req.id : `%${requirement}%`)
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
        // 只有手工记录、没有扫描活动的项目：projectName 要回查 projects 表补上
        //（否则面板直接渲染 projectName 会是空的）
        for (const p of projects) {
          if (p.projectName || !p.projectId) continue
          p.projectName = this.db.prepare('SELECT name FROM projects WHERE id = ?').get(p.projectId)?.name ?? null
        }
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
      activities += 1
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
      }
      // ② 需求级活动 + 工作记录
      for (const r of day.requirements) {
        const known = this.findRequirementByNo(project?.id ?? '', r.digits)
        const reqId = known?.id ?? deriveRequirementId(this.reqPrefix(project), r.digits)
        touched.add(`${reqId}|${day.date}`)
        activities += 1
        // dryRun 也要报「将会写几条」：靠部分唯一索引反查是否已存在（否则预览恒为 0，见测试报告 F2）
        if (dryRun) {
          if (!this.hasScanLog(day.date, project?.id ?? '', reqId, summary.sessionId)) logs += 1
          continue
        }
        {
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
      if (day.requirements.length === 0) {
        if (dryRun) {
          if (!this.hasScanLog(day.date, project?.id ?? '', '', summary.sessionId)) logs += 1
          continue
        }
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

  /** 扫描派生的那条记录是否已存在（dryRun 预览与幂等判断共用）。 */
  hasScanLog(date, projectId, requirementId, sessionId) {
    const row = this.db
      .prepare(
        `SELECT 1 AS hit FROM work_logs
         WHERE date = ? AND project_id = ? AND requirement_id = ? AND session_id = ? AND source = 'session-scan' LIMIT 1`,
      )
      .get(String(date), String(projectId ?? ''), String(requirementId ?? ''), String(sessionId ?? ''))
    return Boolean(row)
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
