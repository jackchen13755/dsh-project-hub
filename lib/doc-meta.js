/**
 * 从需求文档页面里读「结构化信息」：标题、相关人员（谁是产品）、UI 设计链接。
 *
 * 实测来源（用户给的真实页面，Confluence 7.x）：
 *   · 页面标题在 `<h1 id="title-text">`；`<title>` 会带站点后缀（`… - Demo Space - Example Wiki`），
 *     而 **Confluence REST API 的 `title` 是干净的**，所以有 pageId 时优先用 REST 的；
 *   · 页面正文里有一张「相关人员」表：`产品：X` / `UI：Y` / `前端：Z` / `后端：…` / `QA：…`
 *     —— 这就是「标注出谁是产品」的数据来源；
 *   · 同一张表里还有「UI 文件：PC端：<figma url> / APP端：<figma url>」→ 直接收成 UI 设计链接；
 *   · **服务端 HTML 里没有创建者**（`创建者/最近更新者` 是前端 JS 渲染的），
 *     且页面 JS 包里恰好有一行 `//作者 someone@example.com` 的**插件作者注释** —— 拿它当创建者就是误判。
 *     创建者只能走 `/rest/api/content/<id>?expand=history,version,space`。
 */
const SCRIPT_RE = /<script[\s\S]*?<\/script>/gi
const STYLE_RE = /<style[\s\S]*?<\/style>/gi
const TAG_RE = /<[^>]+>/g

/** 角色表的键（只认这些，避免把「产品」当成普通词扫进来）。 */
const ROLE_KEYS = [
  '产品经理',
  '产品负责人',
  '产品',
  'UI',
  'UE',
  'UX',
  '交互',
  '设计',
  '视觉',
  '前端',
  '后端',
  '服务端',
  '客户端',
  '移动端',
  '测试',
  'QA',
  '运维',
  '运营',
  '数据',
  'DBA',
  'PM',
  'PO',
  '开发',
  '负责人',
]

/** 设计稿站点的 host 特征（按这些认「UI 信息」）。 */
const UI_HOSTS = [/figma\.com/i, /mastergo\.com/i, /lanhuapp\.com/i, /lanhu\./i, /modao\.cc/i, /axure/i, /zeplin\.io/i, /蓝湖/]

/** 页面 → 纯文本（脚本/样式先剥掉，否则 JS 包里的字符串会污染解析）。 */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(SCRIPT_RE, ' ')
    .replace(STYLE_RE, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|td|th)>/gi, '\n')
    .replace(TAG_RE, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** 页面标题：Confluence 的 `#title-text` → `<title>`（剥站点后缀）→ 正文里第一个像标题的 h1。 */
export function pageTitle(html) {
  const raw = String(html ?? '')
  const titleText = raw.match(/<h1[^>]*id=["']title-text["'][^>]*>([\s\S]*?)<\/h1>/i)
  if (titleText) return htmlToText(titleText[1]).slice(0, 300) || null
  const docTitle = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (docTitle) {
    const cleaned = stripConfluenceSuffix(htmlToText(docTitle[1]))
    if (cleaned) return cleaned.slice(0, 300)
  }
  for (const m of raw.matchAll(/<h1([^>]*)>([\s\S]*?)<\/h1>/gi)) {
    if (/id=["'](logo|breadcrumbs)/i.test(m[1])) continue
    const text = htmlToText(m[2])
    if (text && text.length <= 200) return text
  }
  return null
}

/**
 * 剥掉 Confluence 拼在 `<title>` 后面的「 - 空间名 - 站点名」。
 * 只在**确实有两段后缀**时才动手（单段有可能就是标题本身的一部分）。
 */
export function stripConfluenceSuffix(title) {
  const text = String(title ?? '').trim()
  const parts = text.split(' - ')
  if (parts.length < 3) return text
  // 只用**通用**站点词判断（不写具体公司/站点名：那种写法既是隐私问题，也换一个站点就失效）
  const tail = parts.slice(-2).join(' ').toLowerCase()
  if (/confluence|atlassian|wiki|docs?|portal|intranet|knowledge|space|知识库|文档中心/.test(tail)) {
    return parts.slice(0, -2).join(' - ').trim()
  }
  return text
}

/** 角色表：`产品：张三` / `UI：李四` → `{ 产品: '张三', UI: '李四' }`（键保持页面原样）。 */
export function parseRoles(text) {
  const roles = {}
  const src = String(text ?? '')
  for (const key of ROLE_KEYS) {
    const re = new RegExp(`(?:^|[\\s|（(【])${key}\\s*[:：]\\s*([^|\\n，,；;、<>]{1,30})`, 'i')
    const m = src.match(re)
    if (!m) continue
    // 值里可能粘着下一个角色名（`张三 QA`），截断到下一个角色键之前
    let value = m[1].trim()
    for (const other of ROLE_KEYS) {
      const cut = value.search(new RegExp(`\\s${other}\\s*[:：]`, 'i'))
      if (cut > 0) value = value.slice(0, cut).trim()
    }
    if (value) roles[key] = value
  }
  return roles
}

/** 谁是「产品」：产品经理 > 产品负责人 > 产品。 */
export function productFromRoles(roles) {
  for (const key of ['产品经理', '产品负责人', '产品']) {
    if (roles && roles[key]) return roles[key]
  }
  return null
}

/**
 * URL 前面的标签：`PC端：` / `移动端：` 这种先认，认不到再退到任意 `短词：`
 * （HTML 里 `<a href=…>PC</a>` 被展开成 `PC：<url>`，所以短词兜底很有用）。
 */
function labelBefore(src, index) {
  const before = String(src ?? '').slice(Math.max(0, index - 80), index)
  // 「X端：」这种明确标签优先（窗口内取最后一个）：`PC端：PC：<url>` 要拿到 PC端 而不是 PC
  const tight = [...before.matchAll(/([A-Za-z\u4e00-\u9fa5]{1,10}(?:端|版|稿))\s*[:：]?\s*/g)].at(-1)
  if (tight) return tight[1]
  const loose = [...before.matchAll(/([A-Za-z\u4e00-\u9fa5]{1,8})\s*[:：]\s*/g)].at(-1)
  if (loose && !/^(https?|www)$/i.test(loose[1])) return loose[1]
  return null
}

function isUiUrl(url) {
  return UI_HOSTS.some((re) => re.test(String(url ?? '')))
}

/**
 * 页面里的 UI 设计链接（Figma/MasterGo/蓝湖/墨刀…），带上它前面那个平台标签（PC端 / APP端 / 移动端）。
 * 同一 URL 只收一次。
 */
export function parseUiLinks(text, { limit = 12 } = {}) {
  const out = []
  const seen = new Set()
  const src = String(text ?? '')
  const urlRe = /(https?:\/\/[^\s"'<>|）)】]+)/gi
  for (const m of src.matchAll(urlRe)) {
    const url = m[1].replace(/[.,;；，、]+$/, '')
    if (!isUiUrl(url) || seen.has(url)) continue
    seen.add(url)
    const label = labelBefore(src, m.index)
    out.push({ url, title: label, source: 'doc-page' })
    if (out.length >= limit) break
  }
  return out
}

/** URL → Confluence pageId（`/pages/viewpage.action?pageId=N`、`/spaces/X/pages/N/…`）。 */
export function confluencePageId(url) {
  const raw = String(url ?? '')
  const byQuery = raw.match(/[?&]pageId=(\d+)/i)
  if (byQuery) return byQuery[1]
  const byPath = raw.match(/\/pages\/(\d+)(?:[/?#]|$)/i)
  if (byPath) return byPath[1]
  return null
}

/** 该 URL 看起来是不是 Confluence（决定要不要去打它的 REST API）。 */
export function confluenceApiUrl(url) {
  const raw = String(url ?? '')
  if (!/^https?:\/\//i.test(raw)) return null
  const id = confluencePageId(raw)
  if (!id) return null
  try {
    const base = new URL(raw)
    return `${base.origin}/rest/api/content/${id}?expand=history,version,space,metadata.labels`
  } catch {
    return null
  }
}

/** 把 Confluence REST 的结果并进 meta（title 以 REST 为准：它不带站点后缀）。 */
export function applyConfluenceMeta(meta, json) {
  if (!json || typeof json !== 'object') return meta
  const next = { ...meta, confluence: true }
  if (json.title) next.title = String(json.title)
  if (json.space) next.space = json.space.name ? `${json.space.name}` : (json.space.key ?? null)
  const created = json.history?.createdBy
  if (created) next.creator = created.displayName ?? created.username ?? created.userKey ?? null
  if (json.history?.createdDate) next.createdDate = json.history.createdDate
  const updatedBy = json.version?.by
  if (updatedBy) next.updatedBy = updatedBy.displayName ?? updatedBy.username ?? null
  if (json.version?.when) next.updatedDate = json.version.when
  return next
}

/**
 * 解析一段页面/文档内容（不联网）：标题 + 角色 + 产品 + UI 链接。
 * Confluence 的创建者不在这里 —— 见 `applyConfluenceMeta`。
 */
export function parseDocMeta(content, { url = null, isHtml = null } = {}) {
  const raw = String(content ?? '')
  const html = isHtml === null ? /<[a-z!][\s\S]*>/i.test(raw) : isHtml
  // ⚠️ 设计稿链接经常只在 `href` 里（页面上显示的是「PC端」这种短文本），
  // 所以先把 `<a href="URL">文本</a>` 展开成「文本：URL」再走文本解析 —— 两条路都不漏。
  const expanded = html ? raw.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => ` ${htmlToText(inner)}：${href} `) : raw
  const text = html ? htmlToText(expanded) : raw
  const title = html ? pageTitle(raw) : (raw.match(/^\s*#\s+(.+)$/m)?.[1]?.trim() ?? null)
  const roles = parseRoles(text)
  return {
    title: title ?? null,
    roles,
    product: productFromRoles(roles),
    uiLinks: parseUiLinks(text),
    text,
  }
}
