/**
 * 开工分支名：`feature/YYYYMMDD-需求名称英文-需求号`
 * （用户给定的格式，2026-09-29 明确要求）。
 *
 * 两个必须钉住的点：
 *   ① **英文**名 —— 需求标题多半是中文（`房态看板改造`），所以只保留拉丁字母/数字段；
 *      全中文标题会得到一个空串，这时退化成 `req`（并在提示词里让 agent 自己按格式调整）；
 *   ② **确定性** —— 同一个需求在同一天必须生成同一个分支名，否则每次点按钮都开出新分支。
 */
import { dateInTz } from './paths.js'

const MAX_SLUG = 40

/**
 * 标题 → 英文 slug：只留 `[A-Za-z0-9]` 段，kebab-case 化并压掉重复分隔符。
 * `【5922】L&F Q3 Enhancements/Queue数据记录` → `l-f-q3-enhancements-queue`
 */
export function englishSlug(title, { max = MAX_SLUG } = {}) {
  const text = String(title ?? '')
    .replace(/[【\[（(]\s*\d{1,8}\s*[】\]）)]/g, ' ') // 去掉标题里的需求号
    .replace(/[\u4e00-\u9fa5]+/g, ' ') // 去掉中文
  const slug = text
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  if (!slug) return ''
  return slug.length > max ? slug.slice(0, max).replace(/-+$/, '') : slug
}

/** 需求号：优先 `no`，否则从需求 ID 尾巴上取数字。 */
export function requirementNumber(requirement) {
  const no = String(requirement?.no ?? '').trim()
  if (no) return no.replace(/[^0-9A-Za-z]/g, '')
  const tail = String(requirement?.id ?? '').match(/(\d{2,8})\s*$/)
  return tail ? tail[1] : ''
}

/**
 * 分支名。`date` 传 `YYYY-MM-DD` 或 `YYYYMMDD` 都行；不传则按 `Asia/Shanghai` 取今天。
 * @returns {string} 形如 `feature/20260929-l-f-q3-enhancements-queue-5922`
 */
export function branchName(requirement, { date = null, tz = 'Asia/Shanghai' } = {}) {
  const raw = date ?? dateInTz(Date.now(), tz)
  const ymd = String(raw).replace(/[^0-9]/g, '').slice(0, 8)
  const slug = englishSlug(requirement?.title) || 'req'
  const no = requirementNumber(requirement)
  return `feature/${ymd}-${slug}${no ? `-${no}` : ''}`
}

/** 分支名格式说明（写进提示词，让 agent 在名字不合适时也能按格式自行调整）。 */
export function branchFormatHint() {
  return 'feature/YYYYMMDD-需求名称英文-需求号（日期 8 位、名称用英文小写连字符、结尾是需求号）'
}
