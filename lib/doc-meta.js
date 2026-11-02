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

/**
 * 「端」的规范名 + 识别规则（规范名与面板「端」下拉的 PLATFORM_CHOICES 一致）。
 *
 * ⚠️ 两个坑（都实测踩到）：
 *   ① 顺序有意义：先认长词（小程序/Pad/H5），再认泛词（APP 会吃掉「移动端/客户端」，
 *      PC 会吃掉「Web端/网页端」）。返回时按**在文里出现的位置**排序，不按本表顺序；
 *   ② 拉丁端名（pc/app/h5/pad/ios…）必须按**标识符边界**匹配：`demo-app`、`demo-client` 这种
 *      项目名里含 app，用普通 `\b` 会被误判成「这条需求做 APP 端」（实测踩到）。
 *      所以前后都不许紧挨着字母/数字/`_`/`.`/`-`。
 */
const EDGE_L = '(?<![A-Za-z0-9_.-])'
const EDGE_R = '(?![A-Za-z0-9_.-])'
const PLATFORM_RULES = [
  ['小程序', /(?:微信|支付宝|抖音)?小程序/],
  ['Pad', new RegExp(`ipad|平板|${EDGE_L}pad${EDGE_R}`, 'i')],
  ['H5', new RegExp(`${EDGE_L}h5${EDGE_R}|移动\\s*web`, 'i')],
  ['APP', new RegExp(`${EDGE_L}(?:app|ios|android)${EDGE_R}|安卓|手机端|移动端|客户端`, 'i')],
  ['PC', new RegExp(`${EDGE_L}(?:pc|web|desktop)${EDGE_R}|网页端|电脑端|桌面端|浏览器端`, 'i')],
  ['服务端', /服务端|后端|server\s*端/i],
]

/** 只认「这整词就是个端名」才当端（`后端设计` 这种**资料名**不能被当成服务端）。 */
const PLATFORM_TITLE_RE =
  /^(?:pc|web|app|ios|android|安卓|h5|pad|平板|小程序|移动端|手机端|客户端|电脑端|网页端|桌面端|服务端|后端)(?:\s*端|\s*版|\s*稿)?$/i

/** 角色表行（`后端：赵六`）：认端之前先剥掉，否则「后端」会被误当成「服务端」。 */
const ROLE_ASSIGN_RE = new RegExp(`(?:${ROLE_KEYS.join('|')})\\s*[:：]\\s*([^\\n|]{0,40})`, 'gi')
/** 像「人名」的值（1-4 个中英文名，可用顿号/空格分隔）：只有这种才当角色表剥掉。 */
const NAMES_ONLY_RE = /^[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z]{0,3}(?:[\s、，,/／][\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z]{0,3})*$/
/**
 * 值里带这些东西 → **不是人名**，不能当角色表剥掉。
 * 起因（实测）：`前端：PC 和 APP 都要` 被当成"人名列表"整行剥掉 → PC/APP 两个端全丢。
 */
const NOT_A_NAME_RE = /端|版|稿|小程序|PC|APP|H5|Pad|iOS|Android|Web|服务|接口|改造|涉及|影响|支持|都|需|和|与|及|或/i

/** 明写的「项目/工作区/仓库：X」。 */
const PROJECT_LABEL_RE = /(?:所属|归属|对应|影响)?(?:项目|工作区|仓库|代码库|代码仓|工程|repo|repository)\s*(?:名称|名字|名)?\s*[:：]\s*([^\n|，,；;（(]{1,60})/gi

/** 明写的「平台/涉及端：PC、APP」—— 与 UI 稿标签同级，算**强证据**。 */
const PLATFORM_LABEL_RE = /(?:涉及|影响|覆盖|支持|目标|开发)?(?:平台|端|终端)\s*[:：]\s*([^\n|]{1,60})/gi

/** 代码托管地址：`github.com/org/repo` → 同时收 `org/repo` 与 `repo`。 */
const REPO_URL_RE = /(?:github|gitlab|bitbucket|gitee)\.com[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/gi

/** 正文里的拉丁标识符（工程名/仓库名几乎都这么写）；这里宁多勿少，匹配时再用已知项目清单收敛。 */
const LATIN_TOKEN_RE = /(?:^|[^A-Za-z0-9_./-])([A-Za-z][A-Za-z0-9_.-]{2,39})(?![A-Za-z0-9_/-])/g

/** 明显不是项目名的常见词（技术/格式/协议词）。 */
const TOKEN_STOP = new Set([
  'api', 'apis', 'url', 'urls', 'uri', 'http', 'https', 'json', 'html', 'css', 'js', 'ts', 'tsx', 'sql', 'db', 'sdk', 'npm', 'git', 'ssh',
  'app', 'apps', 'pc', 'web', 'h5', 'pad', 'ui', 'ux', 'qa', 'pm', 'po', 'dba', 'sla', 'kpi', 'id', 'ids', 'ok', 'no', 'yes',
  'dev', 'prod', 'test', 'staging', 'demo', 'nginx', 'redis', 'mysql', 'mongo', 'kafka', 'docker', 'k8s', 'linux', 'ios', 'android',
  'png', 'jpg', 'jpeg', 'svg', 'gif', 'pdf', 'doc', 'docs', 'xlsx', 'csv', 'zip', 'md', 'txt', 'log', 'logs',
  'figma', 'lanhu', 'mastergo', 'modao', 'axure', 'zeplin', 'confluence', 'atlassian', 'wiki', 'jira', 'zentao',
  'www', 'com', 'cn', 'io', 'org', 'net', 'edu', 'gov', 'example', 'localhost',
  'new', 'old', 'the', 'and', 'for', 'with', 'use', 'see', 'todo', 'tips', 'step', 'note', 'notes',
  'data', 'list', 'item', 'items', 'name', 'type', 'value', 'code', 'file', 'files', 'path', 'root', 'node',
  'mock', 'spec', 'wbs', 'fix', 'feat', 'bug', 'todo', 'tbd', 'etc', 'v1', 'v2', 'v3',
])

/** 剥掉「后端：赵六」这种角色表行（只剥值看起来像人名的，避免误伤真实描述）。 */
export function stripRoleAssignments(text) {
  return String(text ?? '').replace(ROLE_ASSIGN_RE, (match, value) => {
    const raw = String(value ?? '').trim()
    if (!NAMES_ONLY_RE.test(raw)) return match
    // 「PC 和 APP 都要」形似人名、其实是端描述：必须留着给端识别
    if (NOT_A_NAME_RE.test(raw)) return match
    return ' '
  })
}

/** 一个标签/短词 → 规范端名；不是端名就 null（`后端设计` → null，`PC端` → PC）。 */
export function platformFromLabel(value) {
  const text = String(value ?? '').trim()
  if (!text || !PLATFORM_TITLE_RE.test(text)) return null
  for (const [platform, re] of PLATFORM_RULES) {
    if (new RegExp(re.source, re.flags.replace('g', '')).test(text)) return platform
  }
  return null
}

/**
 * 这条需求涉及哪几个「端」，并把**强证据 / 弱证据**分开。
 *
 * 为什么要分档（实测踩到）：正文里随嘴一句「后端」也算弱证据 → 若据此把项目的端写成「服务端」，
 * `brief.js` 的按端裁剪会把 `PC端/APP端` 那两张设计稿全剔出提示词，等于把资料弄丢。
 * 所以**只有强证据才允许自动写库**（见 store.saveRequirement）：
 *   强：UI 设计稿的标签（`PC端：<figma>`）、明写的「平台/涉及端：PC、APP」；
 *   弱：正文里顺口提到的端（「本次涉及服务端接口改造」）。
 *
 * @returns {{ all: string[], strong: string[] }} `all` 按文中出现先后；`strong` 在前
 */
export function parsePlatformsDetailed(text, { uiLinks = [], limit = 6 } = {}) {
  const src = stripRoleAssignments(text)
  const hits = []
  for (const [platform, re] of PLATFORM_RULES) {
    const m = re.exec(src)
    if (m) hits.push({ platform, at: m.index, strong: false })
  }
  // 明写的平台行（「平台：支持 PC 与 APP」「涉及端：PC、APP」）：整行扫一遍端名，算强证据
  for (const m of src.matchAll(PLATFORM_LABEL_RE)) {
    const value = String(m[1] ?? '')
    for (const [platform, re] of PLATFORM_RULES) {
      if (new RegExp(re.source, re.flags.replace('g', '')).test(value)) hits.push({ platform, at: m.index, strong: true })
    }
  }
  for (const link of uiLinks ?? []) {
    const platform = platformFromLabel(link?.title)
    if (platform) hits.push({ platform, at: -1, strong: true })
  }
  hits.sort((a, b) => Number(b.strong) - Number(a.strong) || a.at - b.at)
  const all = []
  const strong = []
  for (const hit of hits) {
    if (!all.includes(hit.platform)) all.push(hit.platform)
    if (hit.strong && !strong.includes(hit.platform)) strong.push(hit.platform)
  }
  return { all: all.slice(0, limit), strong: strong.slice(0, limit) }
}

/**
 * 这条需求涉及哪几个「端」（只要名单，按在文里出现的先后）。
 * 需要区分「能不能用来写库」时用 `parsePlatformsDetailed`。
 */
export function parsePlatforms(text, options = {}) {
  return parsePlatformsDetailed(text, options).all
}

/**
 * 文档里提到的「工作区 / 仓库」候选串，同样分**强 / 弱**两档。
 *
 *   · 强（`strong`）：明写的「项目/工作区/仓库：X」+ 代码托管地址 → **允许自动挂到需求上**；
 *   · 弱（`weak`）：正文里出现的其它拉丁标识符 → **只当提示**，绝不据此写库。
 *
 * 为什么必须分（实测踩到）：正文里写「影响 report 模块」时，一个叫 `report` 的项目会被
 * 归一化全等命中、被悄悄挂到需求上 —— 这种误挂比"少认一个"糟糕得多。
 */
export function parseProjectTokensDetailed(text, { limit = 40 } = {}) {
  const src = String(text ?? '')
  const strong = []
  const weak = []
  const clean = (raw) =>
    String(raw ?? '')
      .trim()
      .replace(/^[`'"“”《》（(]+|[`'"“”《》）)]+$/g, '')
      .trim()
  const pushTo = (list, raw) => {
    const value = clean(raw)
    if (!value || value.length < 2 || value.length > 60) return
    if (!list.includes(value)) list.push(value)
  }
  const strongSet = new Set()
  const addStrong = (raw) => {
    pushTo(strong, raw)
    const value = clean(raw)
    if (value) strongSet.add(value)
  }
  for (const m of src.matchAll(PROJECT_LABEL_RE)) {
    for (const piece of String(m[1] ?? '').split(/[、,，;；/／|]+|\s{2,}/)) {
      const value = clean(piece)
      if (!value) continue
      if (TOKEN_STOP.has(value.toLowerCase())) continue
      addStrong(value)
    }
  }
  for (const m of src.matchAll(REPO_URL_RE)) {
    addStrong(`${m[1]}/${m[2]}`)
    addStrong(String(m[2]).replace(/\.git$/i, ''))
  }
  for (const m of src.matchAll(LATIN_TOKEN_RE)) {
    const token = m[1]
    if (/^\d/.test(token)) continue
    if (TOKEN_STOP.has(token.toLowerCase())) continue
    if (strongSet.has(token)) continue
    pushTo(weak, token)
  }
  return { strong: strong.slice(0, limit), weak: weak.slice(0, limit), all: [...strong, ...weak].slice(0, limit) }
}

/**
 * 文档里提到的「工作区 / 仓库」候选串（强+弱合并；只想要能写库的那档用 `parseProjectTokensDetailed`）。
 */
export function parseProjectTokens(text, { limit = 40 } = {}) {
  return parseProjectTokensDetailed(text, { limit }).all
}

/**
 * 「这条需求要落在哪些工作区、每个工作区做哪一端」的线索（不联网、不判库）。
 *
 * 调用方按 `strong*` 决定能不能写库，`platforms` / `projectTokens` 用来给人看。
 * @returns {{ platforms: string[], strongPlatforms: string[],
 *   projectTokens: string[], strongProjectTokens: string[], weakProjectTokens: string[] }}
 */
export function parseTargets(text, { uiLinks = [], title = null, limit = 6 } = {}) {
  const src = String(text ?? '')
  const full = `${String(title ?? '')}\n${src}`
  const platforms = parsePlatformsDetailed(src, { uiLinks, limit })
  const tokens = parseProjectTokensDetailed(full)
  return {
    platforms: platforms.all,
    strongPlatforms: platforms.strong,
    projectTokens: tokens.all,
    strongProjectTokens: tokens.strong,
    weakProjectTokens: tokens.weak,
  }
}

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
  const uiLinks = parseUiLinks(text)
  return {
    title: title ?? null,
    roles,
    product: productFromRoles(roles),
    uiLinks,
    text,
    /** 这条需求要落在哪些工作区 / 每个工作区做哪一端（线索，见 parseTargets）。 */
    targets: parseTargets(text, { uiLinks, title }),
  }
}
