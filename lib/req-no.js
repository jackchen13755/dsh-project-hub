/**
 * 从标题里认「需求号」。
 *
 * 实测本团队的需求文档标题几乎都带号，形如：
 *   `【5921】Profile Search/Create/Edit 需求变更`
 *   `[5921] 房态看板改造`
 *   `SPMS-5921 房态看板改造`
 *   `5921 房态看板改造` / `5921-房态看板改造` / `#5921 房态看板改造`
 * 读标题之后自动把 `no` 填上（进而拼出 `SPMS-5921` 这样的需求 ID），省一次手输。
 *
 * 刻意保守：**只认这几种「明显是号」的形态**，不猜。尤其
 *   · 纯数字只在「首位 + 后面跟分隔符」时才算（避免把年份、座机号、ID 里的数字当需求号）；
 *   · 4 位且落在 1900–2099 的裸数字当成年份，不算需求号。
 */
const BRACKET_PATTERNS = [
  /【\s*(\d{1,8})\s*】/, // 【5921】
  /\[\s*(\d{1,8})\s*\]/, // [5921]
  /（\s*(\d{1,8})\s*）/, // （5921）
  /\(\s*(\d{1,8})\s*\)/, // (5921)
]
const PREFIX_PATTERN = /\b([A-Za-z][A-Za-z0-9_]{1,15})-(\d{1,8})\b/ // SPMS-5921
const HASH_PATTERN = /#\s*(\d{1,8})\b/ // #5921
const LEADING_PATTERN = /^(\d{2,8})(?=\s|[-_.、,，:：]|$)/ // 5921 房态看板 / 5921-房态看板

function isYearLike(value) {
  const n = Number(value)
  return String(value).length === 4 && n >= 1900 && n <= 2099
}

/**
 * @param {string|null|undefined} title 文档标题
 * @returns {string|null} 需求号（纯数字字符串），没认出来返回 null
 */
export function extractRequirementNo(title) {
  const text = String(title ?? '').trim()
  if (!text) return null
  for (const re of BRACKET_PATTERNS) {
    const m = text.match(re)
    if (m) return m[1]
  }
  const prefixed = text.match(PREFIX_PATTERN)
  if (prefixed) return prefixed[2]
  const hashed = text.match(HASH_PATTERN)
  if (hashed && !isYearLike(hashed[1])) return hashed[1]
  const leading = text.match(LEADING_PATTERN)
  if (leading && !isYearLike(leading[1])) return leading[1]
  return null
}

/** 标题洗完号之后剩下的正文（面板提示用；认不出号就原样返回）。 */
export function stripRequirementNo(title) {
  const no = extractRequirementNo(title)
  if (!no) return String(title ?? '').trim()
  return String(title ?? '')
    .replace(new RegExp(`[【\\[（(]\\s*${no}\\s*[】\\]）)]`), ' ')
    .replace(new RegExp(`\\b[A-Za-z][A-Za-z0-9_]{1,15}-${no}\\b`), ' ')
    .replace(new RegExp(`#\\s*${no}\\b`), ' ')
    .replace(new RegExp(`^${no}(?=\\s|[-_.、,，:：]|$)`), ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
