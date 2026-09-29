/**
 * P2：文档漂移三方对账（DESIGN.md §9.3）。
 *
 * 三条时间线：
 *   · **文档**（意图）：Confluence REST 的 `version.when` / 正文 hash；
 *   · **代码**（事实）：git 索引里这条需求最后一次改动的日期；
 *   · **会话/记录**（过程）：台账里这条需求最后一条开发记录的日期。
 *
 * 判定只做**时序比较**，不做语义判断（语义留给 agent/人）—— 目的是把"文档没跟上"这件事
 * 从"没人知道"变成"面板上有一行、带证据"。
 */

/** 判定用的四个结论。 */
export const DRIFT_VERDICTS = {
  'doc-stale': '⚠ 文档可能没跟上',
  'code-pending': '已评审未开发',
  silent: '很久没动静',
  aligned: '文档跟上了',
  unknown: '数据不足',
}

/** 把各种日期写法归一成 `YYYY-MM-DD`（比较用）；认不出返回 null。 */
export function dayOf(value) {
  if (value === null || value === undefined || value === '') return null
  const text = String(value).trim()
  const direct = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (direct) return `${direct[1]}-${direct[2]}-${direct[3]}`
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) return null
  const d = new Date(parsed)
  const p2 = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

/**
 * 判定一条需求的漂移状态。
 *
 * @param {{ docChangedAt?: string|null, codeLastAt?: string|null, sessionLastAt?: string|null,
 *   today?: string|null, silentDays?: number }} input
 * @returns {{ verdict: string, reason: string, evidence: string[] }}
 */
export function verdictOf(input = {}) {
  const { today = null, silentDays = 30 } = input
  const doc = dayOf(input.docChangedAt)
  const code = dayOf(input.codeLastAt)
  const session = dayOf(input.sessionLastAt)
  const work = [code, session].filter(Boolean).sort().pop() ?? null
  const now = dayOf(today) ?? dayOf(new Date().toISOString()) ?? null

  const evidence = []
  if (doc) evidence.push(`文档：${doc}`)
  if (code) evidence.push(`代码：${code}`)
  if (session) evidence.push(`记录：${session}`)
  if (!doc && !work) return { verdict: 'unknown', reason: '还没有文档快照，也没有代码/记录 —— 拉一次文档版本再判断', evidence }

  // ① 「很久没动静」优先：三条线里最新的那个都超过 silentDays 了，就没必要再催"文档没跟上"
  const latest = [doc, work].filter(Boolean).sort().pop() ?? null
  const silentCut = now ? addDays(now, -Number(silentDays)) : null
  if (latest && silentCut && latest < silentCut) {
    return { verdict: 'silent', reason: `最新动静停在 ${latest}（超过 ${silentDays} 天没人动）`, evidence }
  }
  // ② 再比文档与代码/记录：谁新谁旧
  if (doc && work && work > doc) {
    return {
      verdict: 'doc-stale',
      reason: `代码/记录（${work}）比文档（${doc}）新 —— 变更很可能没回写文档`,
      evidence,
    }
  }
  if (doc && !work) return { verdict: 'code-pending', reason: `文档更新于 ${doc}，还没有代码/记录 —— 可能已评审未开发`, evidence }
  if (!doc && work) return { verdict: 'unknown', reason: `有代码/记录（${work}）但没有文档快照 —— 拉一次文档版本才能对账`, evidence }
  if (doc && work && work <= doc) return { verdict: 'aligned', reason: `文档（${doc}）不早于代码/记录（${work}）`, evidence }
  return { verdict: 'unknown', reason: '数据不足', evidence }
}

function addDays(day, delta) {
  const [y, m, d] = String(day).split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() + delta)
  const p2 = (v) => String(v).padStart(2, '0')
  return `${date.getUTCFullYear()}-${p2(date.getUTCMonth() + 1)}-${p2(date.getUTCDate())}`
}

/** 正文指纹（判断"变没变"）：djb2，够快够稳，不是密码学用途。 */
export function hashText(text) {
  const src = String(text ?? '')
  let hash = 5381
  for (let i = 0; i < src.length; i += 1) hash = ((hash << 5) + hash + src.charCodeAt(i)) % 4294967296
  return hash.toString(16)
}

/** 摘要：只留前 N 个字符（**不存全文**，够定位"变了哪段"就行）。 */
export function excerptOf(text, { limit = 400 } = {}) {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean
}
