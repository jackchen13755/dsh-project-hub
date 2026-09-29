/**
 * 「遗漏检查」：改一个地方，往往有 N 个地方必须跟着改（多语言、模型/接口、样式、同族页面、另一端…）。
 * 不熟悉系统的人最容易漏的正是这些 —— 而它们**在 git 历史里是有统计规律的**。
 *
 * 做法（只给证据，不下结论）：
 *   1. 取这个模块历史上**所有**改动过的文件（含不带需求号的提交 → `code_recent`）；
 *   2. 按类别归并：多语言 / 模型 / 接口 / 样式 / 同族页面 / 组件；
 *   3. 算出"改这个模块时，历史上有多大比例同时改了某类文件"，把**伴随改动清单**列出来，
 *      连同**具体文件名**（比如 7 个语言文件是哪 7 个）——让评审的人照着勾。
 */

/** 文件路径 → 类别（前端为主，后端按常见约定兜底）。 */
export function classifyPath(path) {
  const p = String(path ?? '')
  if (/(^|\/)locales?\/([^/]+)\.json$/i.test(p)) {
    const lang = p.match(/locales?\/([^/]+)\.json$/i)?.[1] ?? null
    return { kind: 'locale', lang }
  }
  if (/(^|\/)locales?\//i.test(p)) return { kind: 'locale', lang: null }
  if (/(^|\/)(api|services|service|request|requests)(\/|$)/i.test(p)) return { kind: 'api', lang: null }
  if (/(^|\/)models?(\/|$)/i.test(p)) return { kind: 'model', lang: null }
  if (/\.(less|css|scss)$/i.test(p)) return { kind: 'style', lang: null }
  if (/(^|\/)components?(\/|$)/i.test(p)) return { kind: 'component', lang: null }
  if (/(^|\/)views?(\/|$)/i.test(p)) return { kind: 'view', lang: null }
  return { kind: 'other', lang: null }
}

/**
 * 把一个模块历史改动过的文件归并成"伴随改动"画像。
 * @param {Array<{path:string, commits:number, last_seen?:string}>} rows
 */
export function companionProfile(rows) {
  const profile = { locale: [], model: [], api: [], style: [], component: [], view: [] }
  const languages = new Set()
  let total = 0
  let lastSeen = null
  for (const row of rows ?? []) {
    const { kind, lang } = classifyPath(row.path)
    total += Number(row.commits ?? 0)
    const seen = row.last_seen ?? row.lastSeen ?? null
    if (seen && (!lastSeen || seen > lastSeen)) lastSeen = seen
    if (!(kind in profile)) continue
    if (kind === 'locale' && lang) languages.add(lang)
    profile[kind].push({ path: row.path, commits: Number(row.commits ?? 0), lastSeen: seen })
  }
  for (const key of Object.keys(profile)) {
    profile[key] = profile[key].sort((a, b) => b.commits - a.commits).slice(0, 12)
  }
  return {
    ...profile,
    languages: [...languages],
    files: (rows ?? []).length,
    commits: total,
    lastSeen,
    /** 多语言的"齐全度"：历史上一共出现过几种语言文件 */
    localeCount: languages.size,
  }
}

/**
 * 生成遗漏检查项。每条都必须有历史统计做依据，并给出"要确认什么"。
 * @param {{ module?:string, profile:ReturnType<typeof companionProfile>, target?:any, moduleName?:string }} input
 * @returns {Array<{ kind:string, text:string, question:string, files:string[] }>}
 */
export function omissionCheck({ profile, target = null, moduleName = null } = {}) {
  const out = []
  const where = moduleName ? `\`${moduleName}\`` : '这个模块'
  const touchedPaths = new Set((target?.codeTouches ?? []).map((row) => String(row.path ?? '')))
  const touchedLangs = new Set(
    [...touchedPaths].map((p) => classifyPath(p)).filter((x) => x.kind === 'locale' && x.lang).map((x) => x.lang),
  )

  if (profile?.localeCount >= 2) {
    const missing = profile.languages.filter((lang) => !touchedLangs.has(lang))
    out.push({
      kind: 'locale',
      text: `历史上改 ${where} 时**动过多语言**：共 ${profile.localeCount} 种（${profile.languages.join('、')}）` +
        (missing.length && touchedLangs.size > 0 ? `；这次已有落点只覆盖 ${[...touchedLangs].join('、')}，差 ${missing.join('、')}` : ''),
      question: `这次要不要一起改多语言？如果要，别只改一种 —— 按历史清单逐个过：${profile.languages.join('、')}（文案长度差异还要看布局）`,
      files: profile.locale.slice(0, 10).map((x) => x.path),
    })
  }
  if (profile?.model?.length) {
    out.push({
      kind: 'model',
      text: `历史上改 ${where} 时**同时改过 models 层**（${profile.model.length} 个文件，如 ${profile.model.slice(0, 3).map((x) => x.path.split('/').slice(-2).join('/')).join('、')}）`,
      question: '这次改的字段/类型，模型与接口层要不要同步？漏了这层最常见的后果是"页面改了但数据对不上"',
      files: profile.model.slice(0, 6).map((x) => x.path),
    })
  }
  if (profile?.api?.length) {
    out.push({
      kind: 'api',
      text: `历史上改 ${where} 时**同时改过接口层**（${profile.api.length} 个文件）`,
      question: '接口/请求参数要不要一起改？两端联调口径是否已定？',
      files: profile.api.slice(0, 6).map((x) => x.path),
    })
  }
  if (profile?.style?.length) {
    out.push({
      kind: 'style',
      text: `历史上改 ${where} 时**同时改过样式文件**（${profile.style.length} 个 .less/.css）`,
      question: '布局/样式要不要跟着调？改动会不会影响同页面的其它模块？',
      files: profile.style.slice(0, 6).map((x) => x.path),
    })
  }
  if (profile?.view?.length >= 2) {
    out.push({
      kind: 'view',
      text: `同一模块下历史上改过 **${profile.view.length} 个页面文件**（${profile.view.slice(0, 4).map((x) => x.path.split('/').pop()).join('、')}…）`,
      question: '这次是只改一个页面，还是同族页面（列表/详情/弹窗/导出）都要改？漏一处就会出现"列表改了详情没改"',
      files: profile.view.slice(0, 8).map((x) => x.path),
    })
  }
  const platforms = (target?.projects ?? []).map((p) => p.platform).filter(Boolean)
  if (platforms.length > 1) {
    out.push({
      kind: 'platform',
      text: `这条需求挂在 ${platforms.length} 个端（${platforms.join('、')}）`,
      question: `各端都要改吗？只做 ${platforms[0]} 的话，另一端的入口/展示会不会不一致？`,
      files: [],
    })
  }
  return out
}
