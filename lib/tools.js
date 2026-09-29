/**
 * 模型可见的工具面（`ph_*`）。
 *
 * 注册成**原始 JSON Schema 定义**（不走 `defineTool`）：本插件零依赖、不 import
 * `@deepseek-ai/dsh-tools`，避免版本漂移与安装期依赖解析；契约只要求
 * `output { schema, render }` + `name/description/parameters/execute`。
 */
import { resolveDocTitle } from './doc-title.js'
import { deriveRequirementId } from './paths.js'
import { normLinkKind } from './store.js'
import { buildRequirementBrief } from './brief.js'

const TEXT = (text) => [{ type: 'text', text }]
const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required })
const str = (description) => ({ type: 'string', description })
const bool = (description) => ({ type: 'boolean', description })
const num = (description) => ({ type: 'number', description })
const strArr = (description) => ({ type: 'array', items: { type: 'string' }, description })
const TEXT_OUT = (extra = {}, required = ['text']) => ({
  schema: obj({ text: str('Human-readable result.') , ...extra }, required),
  render: (_args, value) => TEXT(value.text),
})

const ARCHIVED_ARG = {
  type: 'string',
  enum: ['exclude', 'only', 'include'],
  description: '归档过滤：exclude（默认，只看未归档）| only（只看已归档）| include（都要）。',
}
const KIND_ARG = {
  type: 'string',
  enum: ['dev', 'bug', 'doc', 'review', 'meeting', 'release', 'other'],
  description: '记录类型：dev 开发 / bug 修缺陷 / doc 文档 / review 评审 / meeting 会议 / release 发布 / other 其它。',
}

/** 工具执行时的当前会话工作目录（项目缺省值就取它）。 */
export function cwdOf(exec) {
  try {
    return exec?.agent?.session?.header?.cwd ?? null
  } catch {
    return null
  }
}

function bullets(lines) {
  return lines.filter(Boolean).join('\n')
}

/** 链接按类渲染（每类可以多条）。 */
function renderLinkLines(links = []) {
  if (links.length === 0) return ['（还没有链接：需求文档 / WBS / 后端设计 / UI 设计 都可以加，且每类可多条）']
  const order = ['doc', 'wbs', 'design', 'ui', 'other']
  const grouped = new Map()
  for (const link of links) {
    if (!grouped.has(link.kind)) grouped.set(link.kind, [])
    grouped.get(link.kind).push(link)
  }
  const lines = []
  for (const kind of order) {
    const rows = grouped.get(kind)
    if (!rows || rows.length === 0) continue
    const label = rows[0].kindLabel ?? kind
    rows.forEach((link, index) => {
      const head = index === 0 ? `${label}（${rows.length} 条）` : ' '.repeat(label.length + 4)
      lines.push(`${head}：${link.url}${link.title ? `  《${link.title}》` : ''}${link.note ? `  （${link.note}）` : ''}`)
    })
  }
  return lines
}

export function buildTools({ store, config = {}, version = '0.0.0' }) {
  const projectFor = (args, exec) => {
    if (args?.project) return args.project
    const cwd = cwdOf(exec)
    return cwd ?? null
  }

  const saveRequirement = {
    name: 'ph_save_requirement',
    description:
      'Save or update ONE requirement record in the project ledger, keyed by requirement id. ' +
      'Links: 需求文档 docUrl / WBS wbsUrl / 后端设计 designUrl / UI 设计 uiUrl，且**每一类都可以有多条**（用 links 数组）。' +
      'Given docUrl (or a doc link) the document title is read back automatically and saved (readTitle=false to skip). ' +
      '需求 id 缺省时按 `<项目名大写>-<需求号>` 自动拼接（如 SPMS-5921）。',
    parameters: obj(
      {
        id: str('需求 ID（如 SPMS-5921）。缺省时用 project + no 自动拼。'),
        no: str('需求号（如 5921）。只给号时自动拼出 id。'),
        project: str('所属项目（项目 id / 名称 / 别名 / 工作目录绝对路径）。缺省用当前会话工作目录。'),
        title: str('需求标题。缺省时用需求文档标题。'),
        docUrl: str('需求文档地址（URL 或本地文件路径）—— 语义是「替换该类主链接」。'),
        wbsUrl: str('WBS 地址（替换主链接）。'),
        wbsNote: str('WBS 备注（如排期、里程碑）。'),
        designUrl: str('后端设计文档地址（替换主链接）。'),
        designNote: str('后端设计备注。'),
        uiUrl: str('UI 设计链接（Figma / MasterGo / 蓝湖等；替换该类主链接）。'),
        uiNote: str('UI 设计备注。'),
        links: {
          type: 'array',
          description:
            '多条链接：UI / 需求 / WBS / 设计 都可多条。kind 认 doc(需求文档) | wbs | design(后端设计) | ui(UI 设计) | other，也认中文（需求/WBS/后端设计/UI设计）。默认按 (kind,url) 追加或更新。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', description: 'doc | wbs | design | ui | other（或中文标签）。' },
              url: str('链接地址。'),
              title: str('这条链接的标题（文档类缺省会自动读回）。'),
              note: str('备注。'),
            },
            required: ['url'],
          },
        },
        replaceLinks: bool('true = links 里没出现的类别整类替换（面板整份保存时用）；默认只追加/更新。'),
        projects: {
          type: 'array',
          description:
            '这条需求要在哪些项目里开发（**可以多个**），每项自带「端」：`{project, platform, root?}`。' +
            '第一条 = 主项目（决定需求 ID 前缀）。传了就整体替换；只传 project 时按单项目处理。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              project: str('项目 id / 名称 / 绝对路径。'),
              platform: str('这一端做什么：PC / APP / 服务端 / 小程序…（开新会话时提示词按它裁剪）。'),
              root: str('可选：该项目的目录（候选项目里带着时用）。'),
            },
            required: ['project'],
          },
        },
        platform: str('单项目写法时的「端」（PC / APP…）。'),
        status: str('状态：draft | planning | developing | testing | released | paused | dropped。'),
        priority: str('优先级（自由文本，如 P0/P1）。'),
        tags: strArr('标签。'),
        readTitle: bool('是否读取需求文档标题（默认 true）。'),
      },
      [],
    ),
    output: TEXT_OUT({ id: str('需求 ID。'), created: bool('是否新建。'), linkCount: num('链接条数。') }, ['text']),
    async execute(args, exec) {
      const project = projectFor(args, exec)
      const res = await store.saveRequirement({
        id: args.id,
        no: args.no,
        project,
        title: args.title,
        docUrl: args.docUrl,
        wbsUrl: args.wbsUrl,
        wbsNote: args.wbsNote,
        designUrl: args.designUrl,
        designNote: args.designNote,
        uiUrl: args.uiUrl,
        uiNote: args.uiNote,
        links: args.links,
        replaceLinks: args.replaceLinks,
        /** 多项目：每个项目自带「端」；不传时沿用单 project 字段 */
        projects: Array.isArray(args.projects) ? args.projects : undefined,
        platform: args.platform,
        status: args.status,
        priority: args.priority,
        tags: args.tags,
        readTitle: args.readTitle,
      })
      const r = res.requirement
      return {
        id: r.id,
        created: res.created,
        linkCount: (r.links ?? []).length,
        text: bullets([
          `${res.created ? '已新建' : '已更新'}需求 ${r.id}${r.title ? ` · ${r.title}` : ''}`,
          (r.projects ?? []).length > 1
            ? `项目（多项目，第一条是主项目）：${r.projects.map((p) => `${p.projectName ?? p.projectId}${p.platform ? `·${p.platform}` : ''}`).join('、')}`
            : `项目：${(r.projectName ?? r.projectId) || '-'}${(r.projects ?? [])[0]?.platform ? `·${r.projects[0].platform}` : ''}    状态：${r.status ?? '-'}`,
          ...renderLinkLines(r.links ?? []),
          res.titleRead?.ok ? `文档标题：${res.titleRead.title}（来源 ${res.titleRead.source}）` : null,
          res.noFromTitle ? `需求号 ${res.noFromTitle} 取自文档标题` : null,
          r.creator || r.product ? `创建人：${r.creator ?? '-'}　产品：${r.product ?? '-'}` : null,
          res.uiFromDoc ? `文档里的 UI 设计链接已自动带入 ${res.uiFromDoc} 条` : null,
          res.titleRead && !res.titleRead.ok ? `（文档标题没读到：${res.titleRead.error}）` : null,
          `→ ph_get_requirement {"id":"${r.id}"} 看详情`,
        ]),
      }
    },
  }

  const getRequirement = {
    name: 'ph_get_requirement',
    description: 'Read ONE requirement with its links (需求文档 / WBS / 后端设计 / UI 设计, each may have several), its development records and the days it was worked on.',
    parameters: obj({ id: str('需求 ID 或需求号。'), project: str('可选：项目（用于按号查找）。') }, ['id']),
    output: TEXT_OUT({ id: str('需求 ID。'), linkCount: num('链接条数。') }, ['text']),
    execute(args) {
      const row = store.getRequirement(args.id, { project: args.project ?? null })
      if (!row) {
        return { id: args.id, text: `没有找到需求 ${args.id}。可以用 ph_search 或 ph_list_requirements 找一下。` }
      }
      const req = store.attachLinksOne(store.requirementDetail(row.id))
      const logs = store.listLogs({ requirement: row.id, limit: 30, archived: 'include' })
      const days = store.timeline({ requirement: row.id, limit: 14 })
      return {
        id: req.id,
        linkCount: (req.links ?? []).length,
        text: bullets([
          `${req.id}${req.title ? ` · ${req.title}` : ''}`,
          (req.projects ?? []).length > 0
            ? `项目：${req.projects.map((p) => `${p.projectName ?? p.projectId}${p.platform ? `·${p.platform}` : ''}${p.primary ? '（主）' : ''}`).join('、')}    状态：${req.status ?? '-'}${req.priority ? `    优先级：${req.priority}` : ''}`
            : `项目：${(req.projectName ?? req.projectId) || '-'}    状态：${req.status ?? '-'}${req.priority ? `    优先级：${req.priority}` : ''}`,
          req.product ? `产品：${req.product}　创建人：${req.creator ?? '-'}` : null,
          (req.codeTouches ?? []).length
            ? `代码落点（git 事实，近一年的带号提交）：${req.codeTouches.map((t) => `${t.module}（${t.commits} 次，最近 ${t.lastSeen}）`).join('；')}`
            : null,
          (req.figmaOverlaps ?? []).length
            ? `⚠ 同稿冲突信号：与 ${req.figmaOverlaps.map((o) => `${o.id}${o.title ? `（${o.title}）` : ''}`).join('、')} 引用同一份 Figma 稿（${req.figmaOverlaps[0].fileKey.slice(0, 12)}…）`
            : null,
          Object.keys(req.roles ?? {}).length ? `角色：${Object.entries(req.roles).map(([k, v]) => `${k} ${v}`).join('　·　')}` : null,
          ...renderLinkLines(req.links ?? []),
          req.tags?.length ? `标签：${req.tags.join(', ')}` : null,
          req.archivedAt ? '（该需求已归档）' : null,
          req.lastWorkedAt ? `最近开发：${req.lastWorkedAt}` : null,
          '',
          `开发记录 ${logs.total} 条：`,
          ...logs.items.slice(0, 12).map((l) => `  ${l.date}  [${l.kind}] ${l.title ?? ''}${l.source === 'session-scan' ? '（会话扫描）' : ''}`),
          days.length ? '' : null,
          days.length ? '按天活动（会话扫描）：' : null,
          ...days.map((d) => `  ${d.date}  ${d.msgs} 条消息${d.projects[0]?.requirements?.[0]?.msgs ? ` / 该需求 ${d.projects[0].requirements[0].msgs} 条` : ''}`),
        ]),
      }
    },
  }

  const listRequirements = {
    name: 'ph_list_requirements',
    description: 'List requirement records, optionally filtered by project, keyword or status.',
    parameters: obj(
      {
        project: str('项目过滤。'),
        q: str('关键词（匹配需求 ID / 标题 / 文档标题 / 标签）。'),
        status: str('状态过滤。'),
        archived: ARCHIVED_ARG,
        limit: num('最多返回条数（默认 30）。'),
      },
      [],
    ),
    output: TEXT_OUT({ count: num('条数。'), total: num('总数。') }, ['text']),
    execute(args) {
      const res = store.listRequirements({
        project: args.project ?? null,
        q: args.q ?? null,
        status: args.status ?? null,
        archived: args.archived ?? 'exclude',
        limit: args.limit ?? 30,
      })
      if (res.total === 0) return { count: 0, total: 0, text: '（没有匹配的需求）' }
      return {
        count: res.items.length,
        total: res.total,
        text: bullets([
          `共 ${res.total} 条，显示 ${res.items.length} 条：`,
          ...res.items.map(
            (r) =>
              `- ${r.id}${r.title ? ` · ${r.title}` : ''}  [${(r.projectName ?? r.projectId) || '-'} / ${r.status ?? '-'}]` +
              `${r.lastWorkDate ? `  最近开发 ${r.lastWorkDate}` : ''}${r.workCount ? `  记录 ${r.workCount} 条` : ''}${r.links?.length ? `  链接 ${r.links.length} 条` : ''}${r.archivedAt ? '  （已归档）' : ''}`,
          ),
        ]),
      }
    },
  }

  const listProjects = {
    name: 'ph_list_projects',
    description: 'List projects in the ledger plus the project candidates discovered from the current workspace, the host workspace registry and past sessions.',
    parameters: obj({ cwd: str('可选：以哪个工作目录为基准找候选项目（缺省用当前会话工作目录）。') }, []),
    output: TEXT_OUT({ count: num('条数。') }, ['text']),
    execute(args, exec) {
      const cwd = args.cwd ?? cwdOf(exec)
      const projects = store.listProjects({ cwd })
      const candidates = store.candidateProjects(cwd)
      return {
        count: projects.length,
        text: bullets([
          `台账里的项目 ${projects.length} 个：`,
          ...projects.map(
            (p) => `- ${p.name}（${p.id}）${p.root ? `  ${p.root}` : ''}${p.requirementCount ? `  需求 ${p.requirementCount} 条` : ''}${p.lastWorkedDate ? `  最近开发 ${p.lastWorkedDate}` : ''}`,
          ),
          '',
          `候选项目（当前工作区 / 宿主工作区注册表 / 历史会话）${candidates.length} 个：`,
          ...candidates.slice(0, 30).map((c) => `- ${c.name}（${c.id}）  [${c.source}]${c.root ? `  ${c.root}` : ''}`),
          cwd ? `\n（基准工作目录：${cwd}）` : null,
        ]),
      }
    },
  }

  const logWork = {
    name: 'ph_log_work',
    description:
      'Add or edit ONE development record — e.g. "今天解决了 bug 55036"（kind=bug）、"评审了 X 需求的设计"（kind=review）。' +
      '传 id 即为**编辑**（只改传了的字段；扫描派生的记录也能改，且不会被下次增量扫描覆盖）。' +
      'Add defaults to today and to the current session project.',
    parameters: obj(
      {
        id: num('记录 id：传了就是编辑这条记录（只改传了的字段）。'),
        title: str('记录标题，如「修复 55036 分页越界」（新增必填；编辑时可省）。'),
        date: str('日期 YYYY-MM-DD，缺省今天。'),
        project: str('项目（缺省当前会话工作目录）。'),
        requirement: str('关联需求 ID / 需求号（可空，如纯 bug 修复）。'),
        kind: KIND_ARG,
        detail: str('详情。'),
        minutes: num('耗时分钟。'),
      },
      [],
    ),
    output: TEXT_OUT({ id: num('记录 id。'), created: bool('是否新建。') }, ['text']),
    execute(args, exec) {
      if (args.id !== undefined) {
        const updated = store.updateLog(args.id, {
          date: args.date,
          project: args.project,
          requirement: args.requirement,
          kind: args.kind,
          title: args.title,
          detail: args.detail,
          minutes: args.minutes,
        })
        if (!updated) return { id: Number(args.id), created: false, text: `没找到记录 #${args.id}` }
        return {
          id: updated.id,
          created: false,
          text: `已更新 #${updated.id}：${updated.date}  [${updated.kind}] ${updated.title}（项目 ${(updated.projectName ?? updated.projectId) || '-'}${updated.requirementId ? ` / 需求 ${updated.requirementId}` : ''}）`,
        }
      }
      if (!args.title) return { id: 0, created: false, text: '新增记录需要 title' }
      const log = store.addLog({
        date: args.date,
        project: projectFor(args, exec),
        requirement: args.requirement,
        kind: args.kind ?? 'dev',
        title: args.title,
        detail: args.detail,
        minutes: args.minutes,
        source: 'manual',
      })
      return {
        id: log.id,
        created: true,
        text: `已记录 #${log.id}：${log.date}  [${log.kind}] ${log.title}（项目 ${(log.projectName ?? log.projectId) || '-'}${log.requirementId ? ` / 需求 ${log.requirementId}` : ''}）`,
      }
    },
  }

  const search = {
    name: 'ph_search',
    description: 'Search the whole ledger across requirements, development records and per-day activity; filter by project, requirement, date range or kind.',
    parameters: obj(
      {
        q: str('关键词。'),
        project: str('按项目过滤。'),
        requirement: str('按需求过滤（ID 或号）。'),
        from: str('起始日期 YYYY-MM-DD。'),
        to: str('结束日期 YYYY-MM-DD。'),
        kind: KIND_ARG,
        archived: ARCHIVED_ARG,
        limit: num('每类最多返回条数（默认 30）。'),
      },
      [],
    ),
    output: TEXT_OUT({ requirements: num('命中需求数。'), logs: num('命中记录数。') }, ['text']),
    execute(args) {
      const res = store.search({
        q: args.q ?? null,
        project: args.project ?? null,
        requirement: args.requirement ?? null,
        from: args.from ?? null,
        to: args.to ?? null,
        kind: args.kind ?? null,
        archived: args.archived ?? 'exclude',
        limit: args.limit ?? 30,
      })
      const fmtDay = (d) =>
        `- ${d.date}  ${d.msgs} 条消息 / ${d.projects.length} 个项目：` +
        d.projects
          .map((p) => `${(p.projectName ?? p.projectId) || '未指定'}${p.requirements.length ? `（${p.requirements.map((r) => r.id).join('、')}）` : ''}`)
          .join('；')
      return {
        requirements: res.requirementTotal,
        logs: res.logTotal,
        text: bullets([
          `需求命中 ${res.requirementTotal} 条，开发记录命中 ${res.logTotal} 条。`,
          res.requirements.length ? '\n需求：' : null,
          ...res.requirements.slice(0, 15).map((r) => `- ${r.id}${r.title ? ` · ${r.title}` : ''}  [${(r.projectName ?? r.projectId) || '-'}]`),
          res.logs.length ? '\n开发记录：' : null,
          ...res.logs.slice(0, 20).map((l) => `- ${l.date} [${l.kind}] ${l.title ?? ''}${l.requirementId ? `  (${l.requirementId})` : ''}`),
          res.days.length ? '\n按天活动：' : null,
          ...res.days.slice(0, 14).map(fmtDay),
        ]),
      }
    },
  }

  const scanSessions = {
    name: 'ph_scan_sessions',
    description:
      'Scan DSH session logs (multi-frame zstd) and record which project / which requirement was worked on, day by day. ' +
      'Incremental only: sessions whose mtime+size are unchanged since the last scan are skipped; dryRun=true only reports.',
    parameters: obj(
      {
        dryRun: bool('只报告不写库。'),
        since: str('只扫 mtime 晚于该时间戳（毫秒）或日期 YYYY-MM-DD 的会话。'),
        limit: num('本轮最多真正扫描多少个会话（默认 300；文件枚举看全量，超出部分留给下一轮）。'),
      },
      [],
    ),
    output: TEXT_OUT({ changed: num('本次实际扫描的会话数。'), logs: num('新增开发记录数。') }, ['text']),
    async execute(args) {
      const since = args.since ? (String(args.since).includes('-') ? Date.parse(`${args.since}T00:00:00+08:00`) : Number(args.since)) : null
      const res = await store.scanSessions({ dryRun: args.dryRun === true, since, limit: args.limit ?? 300 })
      return {
        changed: res.changed,
        logs: res.logs,
        text: bullets([
          `会话文件 ${res.files} 个：实际扫描 ${res.changed} 个，跳过 ${res.skipped} 个（未变化/空会话）${args.dryRun ? '（dryRun，未写库）' : ''}。`,
          `写入活动 ${res.activities} 条、开发记录 ${res.logs} 条；覆盖日期：${res.days.join(', ') || '（无）'}`,
          res.errors.length ? `错误 ${res.errors.length} 个：${res.errors.slice(0, 3).map((e) => `${String(e.file ?? '').split('/').slice(-2).join('/')} → ${e.error}`).join(' | ')}` : null,
          res.sessions.length ? '\n明细：' : null,
          ...res.sessions.slice(0, 20).map((s) => `- ${s.cwd ?? '?'} → ${s.projectId ?? '?'}  ${s.msgs} 条消息  ${s.days.join(' ')}${s.title ? `  「${s.title}」` : ''}`),
        ]),
      }
    },
  }

  const report = {
    name: 'ph_report',
    description: 'Development report: for each day, which projects were worked on and which requirements — built from session scans plus manual records.',
    parameters: obj({ from: str('起始日期 YYYY-MM-DD。'), to: str('结束日期 YYYY-MM-DD。'), project: str('项目过滤。'), limit: num('最多天数（默认 30）。') }, []),
    output: TEXT_OUT({ days: num('天数。') }, ['text']),
    execute(args) {
      const res = store.report({ from: args.from ?? null, to: args.to ?? null, project: args.project ?? null, limit: args.limit ?? 30 })
      if (res.days.length === 0) return { days: 0, text: '（这段时间没有任何开发记录；先跑 ph_scan_sessions 扫一遍会话）' }
      return {
        days: res.days.length,
        text: bullets([
          `${res.totals.days} 天 / ${res.totals.projectCount} 个项目 / ${res.totals.requirementCount} 个需求 / ${res.totals.logCount} 条记录`,
          '',
          ...res.days.map((d) => {
            const head = `${d.date}（${d.msgs} 条消息，${d.sessionCount} 个会话${d.logCount ? `，${d.logCount} 条记录` : ''}）`
            const lines = d.projects.map((p) => {
              const reqs = p.requirements.map((r) => `${r.id}${r.title ? `(${r.title})` : ''}×${r.msgs}`).join('、')
              return `    - ${(p.projectName ?? p.projectId) || '未指定项目'}：${reqs || '（无需求号）'}`
            })
            return [head, ...lines].join('\n')
          }),
        ]),
      }
    },
  }

  const archive = {
    name: 'ph_archive',
    description:
      'Archive / restore / hard-delete a requirement, development record or project. Archived rows stay in the database and are hidden from default lists; ' +
      '`hard:true` permanently deletes (irreversible — a deleted requirement also drops all of its links).',
    parameters: obj(
      {
        target: { type: 'string', enum: ['requirement', 'log', 'project'], description: '归档对象。' },
        id: str('对象 id（需求的 id / 记录的数字 id / 项目 id）。'),
        archived: bool('true 归档（默认），false 恢复。'),
        hard: bool('true = 彻底删除（不可恢复，忽略 archived）。面板归档视图里的「删除」按钮走的就是这条。'),
      },
      ['target', 'id'],
    ),
    output: TEXT_OUT({ changed: num('实际改动的行数。'), deleted: bool('是否彻底删除。') }, ['text']),
    execute(args) {
      if (args.hard === true) {
        if (args.target === 'requirement') {
          const deleted = store.deleteRequirement(args.id)
          return { changed: deleted, deleted: Boolean(deleted), text: deleted ? `已彻底删除需求 ${args.id}（连同它的全部链接，不可恢复）` : `没找到需求 ${args.id}` }
        }
        if (args.target === 'log') {
          const deleted = store.deleteLog(args.id)
          return { changed: deleted, deleted: Boolean(deleted), text: deleted ? `已彻底删除记录 #${args.id}（不可恢复）` : `没找到记录 #${args.id}` }
        }
        return { changed: 0, deleted: false, text: '项目不支持彻底删除（避免误删一整条台账线）；需要的话先归档它。' }
      }
      const flag = args.archived !== false
      if (args.target === 'requirement') {
        const res = store.archiveRequirement(args.id, flag)
        return { changed: res.changed, deleted: false, text: res.changed ? `${flag ? '已归档' : '已恢复'}需求 ${args.id}` : `没找到需求 ${args.id}` }
      }
      if (args.target === 'log') {
        const res = store.archiveLog(args.id, flag)
        return { changed: res.changed, deleted: false, text: res.changed ? `${flag ? '已归档' : '已恢复'}记录 #${args.id}` : `没找到记录 #${args.id}` }
      }
      const res = store.archiveProject(args.id, flag)
      return { changed: res.changed, deleted: false, text: res.changed ? `${flag ? '已归档' : '已恢复'}项目 ${args.id}` : `没找到项目 ${args.id}` }
    },
  }

  const docTitle = {
    name: 'ph_doc_title',
    description:
      'Read a requirement document (URL or local file) and return its structure: 标题、谁创建的、谁是「产品」、角色表（UI/前端/后端/QA…）、' +
      '以及页面里的 UI 设计链接（Figma/MasterGo/蓝湖…）。内部站点（Confluence/禅道）走浏览器中继带登录态读。',
    parameters: obj({ url: str('文档 URL 或本地路径。') }, ['url']),
    output: TEXT_OUT(
      {
        title: str('读到的标题。'),
        creator: str('谁创建的（Confluence 走 REST，禅道/正文从页面里认）。'),
        product: str('谁是「产品」（页面角色表里的 产品/产品经理）。'),
        roles: { type: 'object', description: '角色表全量：{ 产品, UI, 前端, 后端, QA… }。' },
        uiLinks: { type: 'array', description: '页面里的 UI 设计链接（Figma/MasterGo/蓝湖…），带 PC端/APP端 标签。' },
      },
      ['text'],
    ),
    async execute(args) {
      const res = await resolveDocTitle(args.url, { timeoutMs: config.docTimeoutMs })
      if (!res.ok) return { title: '', text: `没读到标题：${res.error}` }
      const roleLines = Object.entries(res.roles ?? {}).map(([role, who]) => `${role} ${who}`)
      return {
        title: res.title,
        creator: res.creator ?? '',
        product: res.product ?? '',
        roles: res.roles ?? {},
        uiLinks: res.uiLinks ?? [],
        text: bullets([
          `${res.title}（来源 ${res.source}${res.viaSession ? ` · 经 ${res.strategy}` : ''}）`,
          res.creator ? `创建人：${res.creator}${res.createdDate ? `（${String(res.createdDate).slice(0, 10)}）` : ''}` : null,
          res.product ? `产品：${res.product}　← 需求负责人` : null,
          roleLines.length ? `角色：${roleLines.join('　·　')}` : null,
          res.space ? `空间：${res.space}` : null,
          (res.uiLinks ?? []).length ? `UI 设计链接 ${res.uiLinks.length} 条：` : null,
          ...(res.uiLinks ?? []).map((l) => `  · ${l.title ? `[${l.title}] ` : ''}${l.url}`),
        ]),
      }
    },
  }

  const link = {
    name: 'ph_link',
    description:
      'Manage the links of ONE requirement: 需求文档 / WBS / 后端设计 / UI 设计（Figma、MasterGo、蓝湖…）/ 其它，**每类都可以有多条**。' +
      'action=add 追加（或按 (kind,url) 更新标题/备注）、remove 删一条、list 列全部。',
    parameters: obj(
      {
        action: { type: 'string', enum: ['add', 'remove', 'list'], description: 'add | remove | list。' },
        id: str('需求 ID（如 SPMS-5921）。'),
        kind: str('doc(需求文档) | wbs | design(后端设计) | ui(UI 设计) | other，也认中文（需求/ WBS /后端设计/UI设计/设计稿）。'),
        url: str('链接地址（add / remove 用）。'),
        title: str('这条链接的标题（add 用；文档类缺省自动读回）。'),
        note: str('备注（add 用）。'),
        linkId: num('链接 id（remove 用它更精确，可替代 kind+url）。'),
        readTitle: bool('add 文档类链接时是否读回标题（默认 true）。'),
      },
      ['action', 'id'],
    ),
    output: TEXT_OUT({ ok: bool('是否成功。'), count: num('操作后的链接条数。') }, ['text', 'ok']),
    async execute(args) {
      const row = store.getRequirement(args.id)
      if (!row) return { ok: false, count: 0, text: `没有找到需求 ${args.id}` }
      if (args.action === 'list') {
        return { ok: true, count: store.listLinks(row.id).length, text: bullets([`${row.id} 的链接：`, ...renderLinkLines(store.listLinks(row.id))]) }
      }
      if (args.action === 'remove') {
        const removed = store.removeLink({ id: args.linkId ?? null, requirementId: row.id, kind: args.kind ?? null, url: args.url ?? null })
        store.syncPrimaryMirrors(row.id)
        const links = store.listLinks(row.id)
        return { ok: removed > 0, count: links.length, text: removed ? `已删除 ${removed} 条链接\n${renderLinkLines(links).join('\n')}` : '没找到要删的链接（可用 ph_link action=list 看 id）' }
      }
      if (!args.url) return { ok: false, count: store.listLinks(row.id).length, text: 'add 需要 url' }
      let title = args.title ? String(args.title) : null
      if (!title && normLinkKind(args.kind) === 'doc' && args.readTitle !== false) {
        const res = await resolveDocTitle(args.url, { timeoutMs: config.docTimeoutMs })
        if (res?.ok) title = res.title
      }
      const added = store.upsertLink(row.id, { kind: args.kind, url: args.url, title, note: args.note ?? null })
      store.syncPrimaryMirrors(row.id)
      const links = store.listLinks(row.id)
      return { ok: Boolean(added), count: links.length, text: bullets([`已添加 ${added?.kindLabel ?? ''}链接：${added?.url ?? args.url}`, ...renderLinkLines(links)]) }
    },
  }

  const brief = {
    name: 'ph_brief',
    description:
      'Render ONE requirement as a ready-to-use brief/prompt: 需求 ID/标题/**本次开发的项目与端**/状态 + 相关资料链接（需求文档/WBS/后端设计/UI 设计）' +
      '+ 最近开发记录 + 明确「本次只做哪一端」的任务提示。面板「开新会话」用的就是同一份文本。',
    parameters: obj(
      {
        id: str('需求 ID 或需求号。'),
        project: str('可选：按哪个项目来做这份简报（多项目需求用它挑；不传用主项目）。提示词会剔除属于其它端的资料。'),
        platform: str('可选：本次要做的端（PC / APP / 服务端…）；不传就用该项目自带的端。'),
        branch: bool('true = 提示词里加上「从 master 拉新分支并切换」（分支名 feature/YYYYMMDD-需求名称英文-需求号）。'),
        task: str('可选：覆盖结尾那句任务提示。'),
        logs: num('带上多少条最近开发记录（默认 8，0 = 不带）。'),
      },
      ['id'],
    ),
    output: TEXT_OUT({ ok: bool('是否找到需求。'), brief: str('简报全文。'), platform: str('本次要做的端。') }, ['text', 'ok']),
    execute(args) {
      const result = buildRequirementBrief(store, args.id, {
        project: args.project ?? null,
        platform: args.platform ?? null,
        branch: args.branch === true,
        task: args.task ?? null,
        logLimit: args.logLimit ?? args.logs ?? 8,
      })
      if (!result.ok) return { ok: false, brief: '', text: `没有找到需求 ${args.id}` }
      return { ok: true, brief: result.brief, platform: result.platform ?? '', branch: result.branch ?? '', text: result.brief }
    },
  }

  const drift = {
    name: 'ph_drift',
    description:
      '需求漂移对账（DESIGN §9.3）：把「需求文档（意图）× 代码（事实）× 会话/记录（过程）」三条时间线对齐，' +
      '标出 `doc-stale`（代码/记录比文档新 → 变更可能没回写文档）、`code-pending`（文档更新但没开发）、' +
      '`silent`（很久没动静）、`aligned`。action=refresh 会先去抓一次文档版本/正文指纹（**只存 hash 与摘要，不存全文**）。',
    parameters: obj(
      {
        action: { type: 'string', enum: ['list', 'refresh'], description: 'list 读上次结果；refresh 先抓文档快照再重算。' },
        id: str('可选：只对这条需求 refresh。'),
        silentDays: num('多久没动静算「很久」（默认 30 天）。'),
      },
      [],
    ),
    output: TEXT_OUT({ items: { type: 'array', description: '对账结果。' } }, ['text']),
    async execute(args) {
      if (args.action === 'refresh') {
        const snapshots = await store.refreshDocSnapshots({ id: args.id ?? null, all: !args.id, limit: 50 })
        const computed = store.computeDrift({ silentDays: args.silentDays ?? 30 })
        const stale = computed.rows.filter((r) => r.verdict === 'doc-stale')
        return {
          items: computed.rows,
          text: bullets([
            `文档快照：${snapshots.snapshots.filter((s) => s.ok).length}/${snapshots.snapshots.length} 成功（只存版本号 + 正文 hash + 摘要）`,
            `对账完成：${computed.rows.length} 条需求`,
            stale.length ? `⚠ 文档可能没跟上 ${stale.length} 条：${stale.map((r) => r.requirementId).join('、')}` : '没有「文档没跟上」的需求',
          ]),
        }
      }
      const items = store.listDrift({ limit: 200 })
      if (items.length === 0) return { items: [], text: '还没有对账结果。先 ph_drift {"action":"refresh"}' }
      return {
        items,
        text: bullets([
          `对账结果（${items.length} 条）：`,
          ...items.slice(0, 20).map((r) => `${r.verdict === 'doc-stale' ? '⚠ ' : ''}${r.requirement_id}　${r.verdict}　文档 ${r.doc_changed_at ?? '-'} / 代码 ${r.code_last_at ?? '-'} / 记录 ${r.session_last_at ?? '-'}`),
        ]),
      }
    },
  }

  return [saveRequirement, getRequirement, listRequirements, listProjects, logWork, link, brief, drift, search, scanSessions, report, archive, docTitle]
}

export { deriveRequirementId }
