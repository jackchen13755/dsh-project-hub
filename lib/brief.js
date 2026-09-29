/**
 * 需求简报（提示词）：把一条需求整理成「给人/给 agent 的上下文」。
 *
 * 三个用途共用同一份渲染，保证口径一致：
 *   ① 面板「开新会话」——在新会话所在项目工作区里，把这段文本作为首条消息；
 *   ② agent 工具 `ph_brief`——让模型自己把需求上下文捞出来；
 *   ③ HTTP `GET /project-hub/api/brief`——供外部脚本/别的插件取用。
 *
 * 渲染原则：先给「要做什么」（标题/项目/状态），再按类列全部链接（每条都带 URL，便于点开），
 * 然后给最近几天的开发记录，最后给一句可执行的任务提示。**不夹带任何隐私之外的推测**。
 */
import { LINK_LABELS as LINK_LABEL } from './store.js'

const KIND_LABEL = { dev: '开发', bug: '缺陷', doc: '文档', review: '评审', meeting: '会议', release: '发布', other: '其它' }

/**
 * 「端」归一化：把 PC / PC端 / web / 后台 认成同一类，APP / App端 / 移动端 / 安卓 / iOS 认成同一类。
 * 用途：文档里带端的链接（`PC端：<figma>`）要按本次开发的端裁剪，别把另一端的东西塞进提示词。
 */
export function normPlatform(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text) return null
  if (/^(pc|web|h5|后台|桌面|desktop)(端|版)?$/.test(text) || /\bpc\b/.test(text) || text.includes('web')) return 'PC'
  if (/^(app|移动|手机|安卓|android|ios|iphone|ipad)(端|版)?$/.test(text) || text.includes('app') || text.includes('移动') || text.includes('安卓')) return 'APP'
  if (text.includes('服务端') || text.includes('后端') || text.includes('server') || text.includes('api')) return '服务端'
  if (text.includes('小程序') || text.includes('mini')) return '小程序'
  if (text.includes('pad') || text.includes('平板')) return 'Pad'
  return String(value).trim()
}

/**
 * 明确就是「端名」的标题集合 —— **必须完全相等**才算带端的链接。
 *
 * 为什么不用「包含」判断：`《后端设计》` 里含「后端」，用包含法会把这条**通用资料**当成
 * 「服务端」端的东西剔出去（本项目实测踩到：APP 端提示词里把后端设计文档给丢了）。
 */
const PLATFORM_TITLES = new Set([
  'pc',
  'pc端',
  'web',
  'web端',
  'h5',
  'h5端',
  '后台',
  'app',
  'app端',
  '移动',
  '移动端',
  '手机',
  '手机端',
  '安卓',
  'android',
  'ios',
  '服务端',
  '后端',
  'server',
  '小程序',
  'pad',
  'pad端',
  '平板',
])

/**
 * 按端裁剪链接：**没标端的算通用（要带上）**；标题正好是另一个端的剔出去。
 * @returns {{ included: any[], excluded: any[], labels: string[] }} labels = 被剔除的端（去重）
 */
export function briefPlatformSlice(links, platform) {
  const target = normPlatform(platform)
  const included = []
  const excluded = []
  for (const link of links ?? []) {
    const title = String(link?.title ?? '').trim().toLowerCase()
    const isPlatformTag = PLATFORM_TITLES.has(title)
    const label = isPlatformTag ? normPlatform(title) : null
    if (!isPlatformTag || !target || label === target) included.push(link)
    else excluded.push(link)
  }
  const labels = [...new Set(excluded.map((l) => String(l.title).trim()))]
  return { included, excluded, labels }
}

/**
 * @param {import('./store.js').Store} store
 * @param {string} idOrNo 需求 ID / 需求号
 * @param {{ project?: string|null, platform?: string|null, logLimit?: number, task?: string|null, includeLinks?: boolean }} [opts]
 * @returns {{ ok: boolean, brief: string, requirement: any|null, project: any|null, platform: string|null, links: any[] }}
 */
export function buildRequirementBrief(store, idOrNo, opts = {}) {
  const { project = null, platform = null, logLimit = 8, task = null, includeLinks = true } = opts
  const row = store.getRequirement(idOrNo, { project })
  if (!row) return { ok: false, brief: '', requirement: null, project: null, links: [] }
  const req = store.attachLinksOne(store.requirementDetail(row.id))
  const proj = req.projectId ? store.db.prepare('SELECT * FROM projects WHERE id = ?').get(req.projectId) : null
  const logs = store.listLogs({ requirement: req.id, limit: logLimit, archived: 'include' }).items

  // ── 目标项目 / 端 ────────────────────────────────────────────────────
  // 一条需求可以在多个项目里开发，每个项目各自带「端」（PC / APP…）：
  // 传了 project 就用它那一条（端也取它的），否则用主项目。
  const projectList = req.projects ?? []
  const wanted = project ? String(project).trim().toLowerCase() : null
  const picked =
    (wanted
      ? projectList.find(
          (item) => String(item.projectId ?? '').toLowerCase() === wanted || String(item.projectName ?? '').toLowerCase() === wanted,
        )
      : null) ??
    projectList.find((item) => item.primary) ??
    projectList[0] ??
    null
  const targetPlatform = platform ?? picked?.platform ?? null
  const otherPlatforms = [...new Set(projectList.map((item) => item.platform).filter((p) => p && normPlatform(p) !== normPlatform(targetPlatform)))]

  const lines = []
  lines.push(`# 需求 ${req.id}${req.title ? `：${req.title}` : ''}`)
  lines.push('')
  lines.push(`- 本次开发项目：${picked?.projectName ?? picked?.projectId ?? req.projectName ?? req.projectId ?? '未指定'}${(picked?.root ?? proj?.root) ? `（工作目录 ${picked?.root ?? proj?.root}）` : ''}`)
  if (targetPlatform) lines.push(`- **本次只做：${targetPlatform} 端**`)
  if (projectList.length > 1) {
    lines.push(`- 这条需求还挂在其它项目/端上（本次**不要**动它们）：${projectList.filter((item) => item !== picked).map((item) => `${item.projectName ?? item.projectId}${item.platform ? `·${item.platform}` : ''}`).join('、')}`)
  }
  lines.push(`- 状态：${req.status ?? '-'}${req.priority ? `　优先级：${req.priority}` : ''}`)
  if (req.tags?.length) lines.push(`- 标签：${req.tags.join('、')}`)
  if (req.product) lines.push(`- 产品（需求负责人）：${req.product}`)
  if (req.creator) lines.push(`- 创建人：${req.creator}`)
  const roleLines = Object.entries(req.roles ?? {}).filter(([role]) => role !== '产品' && role !== '产品经理')
  if (roleLines.length) lines.push(`- 相关人员：${roleLines.map(([role, who]) => `${role} ${who}`).join('　·　')}`)
  if (req.lastWorkedAt) lines.push(`- 最近开发：${req.lastWorkedAt}`)

  if (includeLinks) {
    lines.push('')
    lines.push('## 资料链接')
    const allLinks = req.links ?? []
    // 按端裁剪：没标端的算通用；标了别的端的**不进提示词**（不然模型会照着另一端的稿子做）
    const { included: links, excluded, labels } = briefPlatformSlice(allLinks, targetPlatform)
    if (links.length === 0) lines.push('（还没有登记链接）')
    for (const kind of ['doc', 'wbs', 'design', 'ui', 'other']) {
      const rows = links.filter((l) => l.kind === kind)
      if (rows.length === 0) continue
      lines.push(`### ${LINK_LABEL[kind] ?? kind}（${rows.length} 条）`)
      for (const link of rows) lines.push(`- ${link.url}${link.title ? `　《${link.title}》` : ''}${link.note ? `　（${link.note}）` : ''}`)
    }
    if (excluded.length > 0) {
      lines.push(
        '',
        `（另有 ${excluded.length} 条属于 ${labels.join(' / ')} 的资料**本次不用看**：${excluded.map((l) => l.title ?? l.url).join('、')}）`,
      )
    }
  }

  if (logs.length > 0) {
    lines.push('')
    lines.push('## 最近的开发记录')
    for (const log of logs) lines.push(`- ${log.date}　[${KIND_LABEL[log.kind] ?? log.kind}]　${log.title ?? ''}${log.source === 'session-scan' ? '（会话扫描）' : ''}`)
  }

  lines.push('')
  lines.push('## 请做的第一件事')
  lines.push(
    task ??
      [
        targetPlatform
          ? `本次只做 **${targetPlatform} 端** 的开发，工作目录就是上面那个项目的 ${picked?.root ?? proj?.root ?? '(未记录)'}：`
          : '先读完上面这些资料（需求文档 / WBS / 后端设计 / UI 设计）：',
        targetPlatform ? `- 只实现与 ${targetPlatform} 端相关的部分；文档里其它端（${otherPlatforms.length ? otherPlatforms.join('、') : '其它端'}）的内容**不要实现、不要照抄**` : null,
        targetPlatform ? '- 文档中只描述其它端的段落直接跳过，并在结论里说明「与本次无关」' : null,
        '- 先复述一遍你的理解（要做什么、影响哪些模块），再给出实现方案与改动点清单；不确定的地方直接问我，不要猜。',
      ]
        .filter(Boolean)
        .join('\n'),
  )
  return {
    ok: true,
    brief: lines.join('\n'),
    requirement: req,
    project: picked
      ? { id: picked.projectId, name: picked.projectName ?? picked.projectId, root: picked.root ?? null, platform: targetPlatform }
      : proj
        ? { id: proj.id, name: proj.name, root: proj.root ?? null, platform: targetPlatform }
        : null,
    platform: targetPlatform,
    links: (req.links ?? []).filter((l) => briefPlatformSlice([l], targetPlatform).included.length > 0),
  }
}
