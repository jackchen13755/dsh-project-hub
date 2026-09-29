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

/**
 * 判定结论。
 *
 * ⚠️ 口径修正（用户 2026-09-29 指出）：**不能**用「代码/记录比文档新」当漂移证据 ——
 * 正常流程就是「先有文档，再有开发」，代码比文档新是**健康态**。
 * 真正能说明"变更没回写文档"的证据是：**文档最后更新之后，过程记录里出现了"变更语义"**
 * （改成/新增/去掉/不需要/调整…）—— 那是"做了文档里没有的事"的直接痕迹，见 `changeSignalsIn()`。
 */
export const DRIFT_VERDICTS = {
  'doc-stale': '⚠ 文档可能没跟上（记录里有变更）',
  'work-since-doc': '正常推进（文档在前、开发在后）',
  'doc-newer': '文档最近有更新（看看是补变更还是改计划）',
  silent: '很久没动静',
  unknown: '数据不足',
}

/**
 * 「变更语义」词表：记录里出现这些词，说明过程记录描述了**比文档更新的改动**。
 * 只用于给证据，不做语义理解 —— 命中就把原话贴给评审的人看。
 */
const CHANGE_WORDS = [
  '改成',
  '改为',
  '改一下',
  '调整为',
  '调整成',
  '新增',
  '加一个',
  '去掉',
  '删掉',
  '不需要',
  '不用了',
  '取消',
  '换成',
  '替换为',
  '补充',
  '变更',
  '需求改',
  '口径改',
  '逻辑改',
  '再改',
  '重新定义',
  'rename',
  'drop',
  'instead of',
]

/**
 * 找出「文档最后更新之后」出现的变更语义记录。
 * @param {Array<{date?:string, title?:string, detail?:string, source?:string, kind?:string}>} records
 * @param {{ afterDay?: string|null, limit?: number }} [opts] afterDay 之后（不含当天）才算
 * @returns {Array<{ date:string, text:string, word:string, source?:string }>}
 */
export function changeSignalsIn(records, { afterDay = null, limit = 5 } = {}) {
  const after = dayOf(afterDay)
  const out = []
  for (const record of records ?? []) {
    const day = dayOf(record?.date)
    if (after && (!day || day <= after)) continue
    const text = `${record?.title ?? ''}　${record?.detail ?? ''}`.trim()
    if (!text) continue
    const word = CHANGE_WORDS.find((w) => text.toLowerCase().includes(w.toLowerCase()))
    if (!word) continue
    out.push({ date: day ?? String(record?.date ?? ''), text: text.slice(0, 120), word, source: record?.source ?? null })
    if (out.length >= limit) break
  }
  return out
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
  const { today = null, silentDays = 30, signals = [] } = input
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

  // ① 「很久没动静」优先：最新的动静都超过 silentDays 了，就别再催文档
  const latest = [doc, work].filter(Boolean).sort().pop() ?? null
  const silentCut = now ? addDays(now, -Number(silentDays)) : null
  if (latest && silentCut && latest < silentCut) {
    return { verdict: 'silent', reason: `最新动静停在 ${latest}（超过 ${silentDays} 天没人动）`, evidence }
  }
  // ② 有「变更语义」记录才算漂移 —— 这是"做了文档里没有的事"的直接痕迹
  //    ⚠️ 但**必须有文档基准**（抓过快照、知道文档停在什么时候）才能说"文档落后"：
  //    没有基准时，记录里的"改成/新增"推不出"文档没回写"（实测踩到：没抓过快照的需求被误判 doc-stale 并生成待办）。
  const hits = (signals ?? []).filter(Boolean)
  if (!doc && hits.length > 0) {
    return { verdict: 'unknown', reason: `记录里有变更语义（${hits[0].date}「${hits[0].text.slice(0, 40)}」），但还没抓过文档快照 —— 先抓快照才能判断文档是否落后`, evidence }
  }
  if (hits.length > 0) {
    const first = hits[0]
    return {
      verdict: 'doc-stale',
      reason: `文档停在 ${doc ?? '未知'}，但记录里出现了变更：${first.date}「${first.text}」（命中「${first.word}」）`,
      evidence: [...evidence, `变更记录 ${hits.length} 条`],
      signals: hits,
    }
  }
  // ③ 文档在前、开发在后 = **正常推进**（不是漂移）
  if (doc && work && work > doc) {
    return {
      verdict: 'work-since-doc',
      reason: `文档 ${doc} 之后一直在开发（最新 ${work}）—— 这是正常顺序，没有发现"文档外变更"的痕迹`,
      evidence,
    }
  }
  if (doc && !work) return { verdict: 'doc-newer', reason: `文档更新于 ${doc}，此后还没有代码/记录 —— 可能是补了变更，也可能还没开工，看一眼`, evidence }
  if (!doc && work) return { verdict: 'unknown', reason: `有代码/记录（${work}）但没有文档快照 —— 拉一次文档版本才能对账`, evidence }
  if (doc && work) return { verdict: 'doc-newer', reason: `文档（${doc}）与代码/记录（${work}）同期更新，文档不落后`, evidence }
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
