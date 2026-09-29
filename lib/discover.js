/**
 * 历史需求的「发现」（不是"导入"）。
 *
 * 为什么这么做：历史需求文档上千页、而且**很多是别人建的**，全量导入等于把台账变成垃圾场。
 * 所以这里只做两件事：
 *   ① 从**共享源**里发现"看起来是需求"的东西（Confluence 文档树 / git 带号分支）；
 *   ② 把它们排进**候选箱**，人工（或评审时按需）采纳了才进台账。
 *
 * 另一个现实约束：同事的 DSH 会话日志我们看不到（每台机器各自的），
 * 能看到的只有他们留下的**结果** —— git 提交/分支 + 文档。所以发现只能依赖共享源。
 */
import { extractRequirementNo } from './req-no.js'

/** 从 Confluence 搜索结果里取页面信息（CQL 分页返回的形状）。 */
export function parseSearchResults(payload, { base = null } = {}) {
  // 响应自带 `_links.base`（如 https://wiki.<host>）—— 用它拼绝对地址，
  // 否则存进台账的是 `/pages/viewpage.action?...` 这种相对地址，面板上点不开（实测踩到）
  const root = String(base ?? payload?._links?.base ?? '').replace(/\/$/, '')
  const rows = []
  for (const item of payload?.results ?? []) {
    const id = item?.content?.id ?? item?.id ?? null
    if (!id) continue
    const relative = item?.url ?? item?.content?._links?.webui ?? null
    rows.push({
      id: String(id),
      title: String(item?.title ?? item?.content?.title ?? '').trim(),
      // 用 pageId 拼规范地址（相对 URL 在不同实例下形态不一，别依赖它）
      url: `${root}/pages/viewpage.action?pageId=${id}`,
      changedAt: item?.lastModified ? String(item.lastModified).slice(0, 10) : null,
      excerpt: String(item?.excerpt ?? ''),
    })
  }
  return { total: Number(payload?.totalSize ?? rows.length), rows }
}

/**
 * 从文档页里提炼"需求候选"：标题里带需求号（【5922】/SPMS-5922/(5922)）才算。
 * @param {Array<{id,title,url,changedAt}>} pages
 * @returns {Array<{no,title,docUrl,docId,docChangedAt,title_from}>}
 */
export function candidatesFromPages(pages) {
  const out = []
  const seen = new Set()
  for (const page of pages ?? []) {
    const no = extractRequirementNo(page?.title)
    if (!no || seen.has(no)) continue
    seen.add(no)
    out.push({
      no,
      title: page.title,
      docUrl: page.url ?? null,
      docId: page.id ?? null,
      docChangedAt: page.changedAt ?? null,
      title_from: 'confluence',
    })
  }
  return out
}

/**
 * 从代码索引里提炼候选：`code_touches` 里出现过的需求号，但台账里没有的。
 * 这是**零成本骨架** —— 需求号 + 代码落点 + 首末时间，不需要任何文档。
 * @param {{ touches: Array<{requirement_id, project_id, module, commits, first_seen, last_seen, sample}>,
 *   known: Set<string>|string[] }} input
 */
export function candidatesFromTouches({ touches, known }) {
  const knownSet = known instanceof Set ? known : new Set(known ?? [])
  const byNo = new Map()
  for (const row of touches ?? []) {
    const no = String(row?.requirement_id ?? '').trim()
    if (!no || knownSet.has(no)) continue
    // 发布/打标签留下的行不是需求（实测：UAT tag 的时间戳被当成了需求号）
    if (looksLikeTagOrRelease(row?.sample)) continue
    if (/^\d{6}$/.test(no) && /^([01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]$/.test(no)) continue
    if (!byNo.has(no)) {
      byNo.set(no, { no, projectId: row.project_id ?? null, modules: new Map(), commits: 0, firstAt: row.first_seen ?? null, lastAt: row.last_seen ?? null, sample: null, title_from: 'git' })
    }
    const item = byNo.get(no)
    const module = row.module ?? row.path ?? '(未知模块)'
    item.modules.set(module, (item.modules.get(module) ?? 0) + Number(row.commits ?? 0))
    item.commits += Number(row.commits ?? 0)
    if (row.first_seen && (!item.firstAt || row.first_seen < item.firstAt)) item.firstAt = row.first_seen
    if (row.last_seen && (!item.lastAt || row.last_seen > item.lastAt)) item.lastAt = row.last_seen
    if (!item.sample && row.sample) item.sample = row.sample
  }
  return [...byNo.values()].map((item) => ({
    no: item.no,
    title: gitTitle(item),
    projectId: item.projectId,
    modules: [...item.modules.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([module, commits]) => ({ module, commits })),
    codeCommits: item.commits,
    codeLastAt: item.lastAt,
    firstAt: item.firstAt,
  }))
}

/**
 * 发布/打标签的痕迹不算需求：`Merge tag 'tags/uf-20260922-173930-zhangju'`、`uf-…`、`release-wl` 之类。
 * 实测这些会把 UAT 时间戳（173930）带成假需求号。
 */
export function looksLikeTagOrRelease(sample) {
  const text = String(sample ?? '')
  if (/Merge tag '/i.test(text)) return true
  if (/\btags?\/uf-/i.test(text)) return true
  if (/\buf-\d{6,8}[-_]\d{4,6}/i.test(text)) return true
  if (/^Merge (branch|remote-tracking branch) '(release|hotfix|uatfix)[-_/]/i.test(text.trim())) return true
  return false
}

/** 用分支名/提交样本凑一个人能看的标题（没有文档标题时的占位）。 */
function gitTitle(item) {
  const sample = String(item.sample ?? '')
  // 一个合并提交里可能出现多个分支名（`Merge branch 'release-wl' into uatfix/20260908-bug-fix-55457`）——
  // 要取**带这个需求号的那个**，否则标题会写成 "release wl"（实测踩到）
  const branches = [...sample.matchAll(/'([^']+)'/g)].map((m) => m[1])
  const branch = branches.find((name) => new RegExp(`[-_/]${item.no}$`).test(name)) ?? branches[0] ?? null
  const name = branch
    ? branch
        .replace(/^origin\//, '')
        .replace(/^[\w-]*\//, '')
        .replace(/[-_]\d{4,6}$/, '')
        .replace(/^\d{6,8}[-_]?/, '')
        .replace(/[-_]+/g, ' ')
        .trim()
    : sample.replace(/^[a-z]+(\([^)]*\))?:\s*/i, '').trim()
  const suffix = item.lastAt ? `（${String(item.lastAt).slice(0, 10)} 最后改动）` : ''
  return name ? `${name}${suffix}` : `需求 ${item.no}${suffix}`
}

/**
 * 合并两个来源 + 打分（分数只用于排队，不代表"是不是需求"的概率）。
 * 与**你在做的需求**同模块 / 近 90 天有文档改动 / 有代码落点 → 排前面。
 */
export function mergeCandidates({ fromPages = [], fromTouches = [], myModules = new Set(), recentDays = 90, today = null } = {}) {
  const byNo = new Map()
  for (const row of fromTouches) {
    byNo.set(row.no, {
      no: row.no,
      title: row.title,
      titleFrom: 'git',
      projectId: row.projectId ?? null,
      modules: row.modules ?? [],
      codeCommits: row.codeCommits ?? 0,
      codeLastAt: row.codeLastAt ?? null,
      docUrl: null,
      docId: null,
      docChangedAt: null,
      signals: ['有代码落点（git 事实）'],
      score: 0,
    })
  }
  for (const row of fromPages) {
    const key = row.no
    if (!byNo.has(key)) {
      byNo.set(key, {
        no: key,
        title: row.title,
        titleFrom: 'confluence',
        projectId: null,
        modules: [],
        codeCommits: 0,
        codeLastAt: null,
        docUrl: row.docUrl ?? null,
        docId: row.docId ?? null,
        docChangedAt: row.docChangedAt ?? null,
        signals: ['有需求文档（标题里带需求号）'],
        score: 0,
      })
      continue
    }
    const item = byNo.get(key)
    item.docUrl = row.docUrl ?? item.docUrl
    item.docId = row.docId ?? item.docId
    item.docChangedAt = row.docChangedAt ?? item.docChangedAt
    item.title = row.title || item.title // 文档标题比 git 猜出来的名字可信
    item.titleFrom = 'confluence'
    item.signals.push('文档 + 代码都有')
  }
  const cut = today ? new Date(new Date(`${today}T00:00:00Z`).getTime() - Number(recentDays) * 86400000).toISOString().slice(0, 10) : null
  const out = [...byNo.values()]
  for (const item of out) {
    let score = 0
    if (item.docUrl) score += 2
    if (item.codeCommits > 0) score += 2
    if (cut && item.docChangedAt && item.docChangedAt >= cut) {
      score += 3
      item.signals.push(`${recentDays} 天内改过文档`)
    }
    if (cut && item.codeLastAt && item.codeLastAt >= cut) {
      score += 3
      item.signals.push(`${recentDays} 天内改过代码`)
    }
    const shared = (item.modules ?? []).filter((m) => myModules.has(m.module)).map((m) => m.module)
    if (shared.length > 0) {
      score += 5
      item.sameModuleAs = shared
      item.signals.push(`与你在做的需求同模块：${shared.slice(0, 3).join('、')}`)
    }
    item.score = score
    item.modules = (item.modules ?? []).map((m) => m.module)
  }
  out.sort((a, b) => b.score - a.score || String(b.codeLastAt ?? b.docChangedAt ?? '').localeCompare(String(a.codeLastAt ?? a.docChangedAt ?? '')))
  return out
}

/** 走中继按 CQL 分页拉一个文档树下的所有页面。 */
export async function scanConfluenceTree({ rootPageId, fetchText, maxPages = 2000, pageSize = 200, sinceDay = null, base = null, maxCalls = 40, startAt = 0 }) {
  if (!rootPageId) return { ok: false, error: '缺少 rootPageId（需求文档根页面的 pageId）', pages: [], calls: 0 }
  const pages = []
  // 从上次中断的地方接着扫（这个实例的会话会中途失效 —— 实测扫到第 600 页被打断）
  let start = Math.max(0, Number(startAt) || 0)
  const firstStart = start
  let total = null
  let calls = 0
  const cql = [`ancestor=${rootPageId}`, 'type=page', sinceDay ? `lastModified >= "${sinceDay}"` : null].filter(Boolean).join(' AND ')
  let searchBase = String(base ?? '').replace(/\/$/, '')
  while (calls < maxCalls) {
    const url = `${searchBase}/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${pageSize}&start=${start}&expand=version`
    let res = await fetchText(url)
    calls += 1
    // 中途偶发登录页/网络抖动：**退避后重试一次**（实测扫到第 4 页时被打断，结果已抓到的 600 页全丢了；
    // 内部站点的中继会话会中途失效，隔一下再试往往能过）
    if (!res?.ok || !String(res.text ?? '').trim().startsWith('{')) {
      await new Promise((resolve) => setTimeout(resolve, 1200))
      res = await fetchText(url)
      calls += 1
    }
    if (!res?.ok) {
      // **部分成功也要用**：把已抓到的页返回，并如实标注为什么停下；nextStart 让下次接着扫
      return { ok: pages.length > 0, partial: true, error: res?.error ?? `取第 ${start} 页失败`, pages, calls, total, nextStart: start, startedAt: firstStart }
    }
    let payload = null
    try {
      payload = JSON.parse(res.text)
    } catch {
      return { ok: pages.length > 0, partial: true, error: '返回不是 JSON（可能没登录）', pages, calls, total, nextStart: start, startedAt: firstStart }
    }
    if (!searchBase) searchBase = String(payload?._links?.base ?? '').replace(/\/$/, '')
    const parsed = parseSearchResults(payload, { base: searchBase })
    if (total === null) total = parsed.total
    pages.push(...parsed.rows)
    if (parsed.rows.length === 0 || start + pageSize >= (total ?? 0) || pages.length >= maxPages) {
      // 扫到底了 → 游标回到 0（下次从头、配合增量 sinceDay 就够）
      return { ok: true, pages, total, calls, nextStart: 0, startedAt: firstStart, finished: true }
    }
    start += pageSize
  }
  return { ok: true, pages, total, calls, nextStart: start, startedAt: firstStart, finished: false }
}
