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
 * @param {import('./store.js').Store} store
 * @param {string} idOrNo 需求 ID / 需求号
 * @param {{ project?: string|null, logLimit?: number, task?: string|null, includeLinks?: boolean }} [opts]
 * @returns {{ ok: boolean, brief: string, requirement: any|null, project: any|null, links: any[] }}
 */
export function buildRequirementBrief(store, idOrNo, opts = {}) {
  const { project = null, logLimit = 8, task = null, includeLinks = true } = opts
  const row = store.getRequirement(idOrNo, { project })
  if (!row) return { ok: false, brief: '', requirement: null, project: null, links: [] }
  const req = store.attachLinksOne(store.requirementDetail(row.id))
  const proj = req.projectId ? store.db.prepare('SELECT * FROM projects WHERE id = ?').get(req.projectId) : null
  const logs = store.listLogs({ requirement: req.id, limit: logLimit, archived: 'include' }).items

  const lines = []
  lines.push(`# 需求 ${req.id}${req.title ? `：${req.title}` : ''}`)
  lines.push('')
  lines.push(`- 项目：${req.projectName ?? req.projectId ?? '未指定'}${proj?.root ? `（工作目录 ${proj.root}）` : ''}`)
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
    const links = req.links ?? []
    if (links.length === 0) lines.push('（还没有登记链接）')
    for (const kind of ['doc', 'wbs', 'design', 'ui', 'other']) {
      const rows = links.filter((l) => l.kind === kind)
      if (rows.length === 0) continue
      lines.push(`### ${LINK_LABEL[kind] ?? kind}（${rows.length} 条）`)
      for (const link of rows) lines.push(`- ${link.url}${link.title ? `　《${link.title}》` : ''}${link.note ? `　（${link.note}）` : ''}`)
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
      `先读完上面这些资料（需求文档 / WBS / 后端设计 / UI 设计），复述一遍我的理解，然后给出实现方案与改动点清单；不确定的地方直接问我，不要猜。`,
  )
  return { ok: true, brief: lines.join('\n'), requirement: req, project: proj ? { id: proj.id, name: proj.name, root: proj.root ?? null } : null, links: req.links ?? [] }
}
