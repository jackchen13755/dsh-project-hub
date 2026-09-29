/**
 * 禅道（story/需求单）作为**权威来源**接入发现。
 *
 * 为什么是权威：需求号、标题、状态、创建人在禅道里是"登记在案"的，比 wiki 标题和 git 分支名都准；
 * 所以禅道来源的候选放在候选箱最前面，采纳时优先用它的标题与状态。
 *
 * 实测（本团队 zentao.example.com，经典 index.php 10.6）：
 *   · 列表页 `m=product&f=browse&productID=<id>&orderBy=id_desc` 是**服务端渲染**的，
 *     行结构：`<tr data-id='6022'>… <td class='c-id'><a href='/index.php?m=story&f=view&storyID=6022'>6022</a>`
 *     `<td class='c-title' title='…'>` `<td class='c-openedBy' title='Zhang San'>` `<td class='c-status'><span class='status-active'>激活</span>`
 *   · 分页权威总数在表头链接里：`recTotal=461`、`recPerPage=20`（不能拿"本页行数"当总数）
 *   · **翻页**：页面底部有分页器（Zentao 10.x 由前端按模板拼链接）：
 *     `<ul class='pagerProductBrowse' data-rec-total='430' data-rec-per-page='20' data-page='1'
 *          data-link-creator='/index.php?m=product&f=browse&productID=15&branch=&browseType=unclosed&param=0&orderBy=&recTotal=430&recPerPage={recPerPage}&pageID={page}'>`
 *     → 我们**直接用它的模板**把 `{page}`/`{recPerPage}` 替换掉翻页（别自己拼参数：实测少了 `param=0` 会返回 0 行）。
 */

/** 禅道需求单的规范地址（面板/工具里点得开）。 */
export function storyUrl(storyId, { base = 'https://zentao.example.com' } = {}) {
  return `${String(base).replace(/\/$/, '')}/index.php?m=story&f=view&storyID=${Number(storyId)}`
}

/**
 * 解析**需求单详情页**。
 *
 * 实测（用户指出的 join key）：story 详情页
 *   · `<title>STORY #5783 DBF活动风控支持 - 数据中心 - 禅道</title>` → **storyID 就是需求号**
 *   · **描述区**（`detail-content`）里就是需求 wiki：`https://<wiki>/pages/viewpage.action?pageId=159221810`
 * 于是禅道可以当**权威入口**：需求号 + 标题 + 状态 + 创建人 + 需求文档地址，一次拿全。
 */
export function parseStoryDetail(html) {
  const text = String(html ?? '')
  const pageTitle = (text.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim()
  const titleNo = pageTitle.match(/STORY\s*#?(\d{3,6})/i)?.[1] ?? null
  // 页面标题形如 `STORY #5783 DBF活动风控支持 - 数据中心 - 禅道`：去掉前缀与被「 - 」分隔的后缀（模块名/站点名）
  const storyTitle =
    pageTitle
      .replace(/^STORY\s*#?\d+\s*/i, '')
      .split(/\s+-\s+/)[0]
      .trim() || null
  // 描述区（禅道 10.x：`<div class="detail-content article-content">`；老版本是 `detail-content`）
  const block =
    text.match(/<div[^>]*class=['"][^'"]*detail-content[^'"]*['"][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)?.[1] ??
    text.match(/<div[^>]*class=['"][^'"]*detail-content[^'"]*['"][^>]*>([\s\S]{0,4000})/i)?.[1] ??
    ''
  const wikiFromBlock = block.match(/https?:\/\/[^\s"'<>]*?(?:viewpage\.action\?pageId=\d+|\/display\/[^\s"'<>]+|\/pages\/\d+)/i)?.[0] ?? null
  const wikiAnywhere = text.match(/https?:\/\/[^\s"'<>]*?viewpage\.action\?pageId=(\d+)/i)
  const wikiUrl = wikiFromBlock ?? (wikiAnywhere ? wikiAnywhere[0] : null)
  const description = block
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    pageTitle,
    storyTitle,
    noFromTitle: titleNo,
    wikiUrl,
    wikiPageId: wikiUrl?.match(/pageId=(\d+)/)?.[1] ?? null,
    description: description.slice(0, 500) || null,
  }
}

/** 从列表页里读分页权威值（`recTotal` / `recPerPage`）。 */
export function parsePager(html) {
  const text = String(html ?? '')
  const num = (value) => (Number.isFinite(Number(value)) && value !== null && value !== undefined && value !== '' ? Number(value) : null)
  // 分页器的权威值（优先级）> 链接里的 recTotal/recPerPage
  const total = num(text.match(/data-rec-total=['"](\d+)['"]/i)?.[1]) ?? num(text.match(/recTotal=(\d+)/)?.[1])
  const perPage = num(text.match(/data-rec-per-page=['"](\d+)['"]/i)?.[1]) ?? num(text.match(/recPerPage=(\d+)/)?.[1])
  const page = num(text.match(/data-page=['"](\d+)['"]/i)?.[1]) ?? 1
  // 翻页用它给的模板（自己拼参数会踩坑：少 `param=0` 直接返回 0 行）
  const linkCreator = text.match(/data-link-creator=['"]([^'"]+)['"]/i)?.[1] ?? null
  return { total, perPage, page, linkCreator }
}

/** 用分页器模板拼第 N 页的地址。 */
export function pageUrlFrom(template, page, { base = 'https://zentao.example.com', perPage = 20 } = {}) {
  if (!template) return null
  const path = String(template).replace(/\{recPerPage\}/g, String(perPage)).replace(/\{page\}/g, String(page))
  if (/^https?:\/\//i.test(path)) return path
  return `${String(base).replace(/\/$/, '')}${path.startsWith('/') ? '' : '/'}${path}`
}

function cell(html, className) {
  const re = new RegExp(`<td[^>]*class=['"][^'"]*${className}[^'"]*['"][^>]*>([\\s\\S]*?)</td>`, 'i')
  const raw = html.match(re)?.[1] ?? ''
  const attr = raw.match(/title=['"]([^'"]*)['"]/i)?.[1]
  const text = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  return { text, title: attr ? attr.replace(/\s+/g, ' ').trim() : null }
}

/**
 * 解析需求列表页 → 一行一条。
 * @returns {{ rows: Array<{storyId, title, status, stage, openedBy, assignedTo, priority, url}>, pager: {total, perPage} }}
 */
export function parseStoryList(html, { base = 'https://zentao.example.com' } = {}) {
  const text = String(html ?? '')
  const rows = []
  for (const chunk of text.split(/<tr\b/i).slice(1)) {
    const idMatch = chunk.match(/data-id=['"](\d+)['"]/i) ?? chunk.match(/name=['"]storyIDList\[\]['"]\s+value=['"](\d+)['"]/i)
    if (!idMatch) continue
    const storyId = idMatch[1]
    const titleCell = cell(chunk, 'c-title')
    const title = (titleCell.title ?? titleCell.text ?? '').trim()
    if (!title) continue
    rows.push({
      storyId,
      title,
      status: cell(chunk, 'c-status').text || null,
      stage: cell(chunk, 'c-stage').text || null,
      openedBy: cell(chunk, 'c-openedBy').text || null,
      assignedTo: cell(chunk, 'c-assignedTo').text || null,
      priority: cell(chunk, 'c-pri').text || null,
      url: storyUrl(storyId, { base }),
    })
  }
  return { rows, pager: parsePager(text) }
}

/**
 * 扫若干个产品的需求列表（按 id 倒序取最近的，翻页到 maxPages 为止）。
 * @param {{ fetchText:Function, productIds:Array<string|number>, base?:string, maxPages?:number, browseType?:string }} opts
 */
export async function scanZentaoStories({ fetchText, productIds = [], base = 'https://zentao.example.com', orderBy = 'id_desc', withDetail = true, maxDetails = 20, maxPages = 3 }) {
  const root = String(base).replace(/\/$/, '')
  const stories = []
  const products = []
  let calls = 0
  for (const productId of productIds) {
    const product = { productId: String(productId), total: null, perPage: null, fetched: 0, pages: 0, error: null }
    // 首页地址要与分页器同款参数（实测：自造 `orderBy=id_desc` 时页面不渲染分页器 → 翻不了页）
    let url = `${root}/index.php?m=product&f=browse&productID=${encodeURIComponent(productId)}&branch=&browseType=unclosed&param=0&orderBy=${encodeURIComponent(orderBy === 'id_desc' ? '' : orderBy)}`
    const rows = []
    for (let page = 1; page <= Math.max(1, Number(maxPages) || 1); page += 1) {
      const res = await fetchText(url)
      calls += 1
      if (!res?.ok) {
        product.error = res?.error ?? '取需求列表失败'
        break
      }
      const parsed = parseStoryList(res.text, { base: root })
      if (page === 1) {
        product.total = parsed.pager.total
        product.perPage = parsed.pager.perPage
        // 分页器模板：用它拼下一页（自己拼参数会踩坑）
        product.nextPageUrl = pageUrlFrom(parsed.pager.linkCreator, page + 1, { base: root, perPage: parsed.pager.perPage ?? 20 })
      }
      product.pages += 1
      rows.push(...parsed.rows.map((row) => ({ ...row, productId: String(productId) })))
      const perPage = parsed.pager.perPage ?? 20
      const done = parsed.rows.length < perPage || (product.total !== null && page * perPage >= product.total)
      if (done || !product.nextPageUrl) break
      url = product.nextPageUrl
      product.nextPageUrl = pageUrlFrom(parsed.pager.linkCreator, page + 2, { base: root, perPage })
    }
    product.fetched = rows.length
    // 顺带拉详情：**描述区里就是需求 wiki**，而且 <title> 里 `STORY #<号>` 说明 storyID 就是需求号
    if (withDetail) {
      product.details = 0
      for (const row of rows.slice(0, maxDetails)) {
        const detail = await fetchText(`${root}/index.php?m=story&f=view&storyID=${row.storyId}`)
        calls += 1
        if (!detail?.ok) continue
        const parsed2 = parseStoryDetail(detail.text)
        row.detail = parsed2
        row.wikiUrl = parsed2.wikiUrl
        row.noFromDetail = parsed2.noFromTitle
        if (parsed2.storyTitle) row.storyTitle = parsed2.storyTitle
        product.details += 1
      }
    }
    stories.push(...rows)
    products.push(product)
  }
  return { stories, products, calls, pagination: true }
}

/** 需求单里标题带需求号的抽出来（禅道标题形态实测：`【5922】…`、`10 【5316】…`、`SPMS-1234 …`）。 */
export function candidatesFromStories(stories, { extractNo }) {
  const out = []
  const seen = new Set()
  for (const story of stories ?? []) {
    // 需求号来源优先级：详情的 `STORY #N` → 列表标题里的【N】 → storyID 本身
    // （本团队实测：禅道 story ID 就是需求号 —— storyID=5783 对应分支 feature/…-5783 与 wiki 页）
    const no = story?.noFromDetail ?? extractNo(story?.title) ?? (story?.storyId ? String(story.storyId) : null)
    if (!no || seen.has(no)) continue
    seen.add(no)
    out.push({
      no,
      title: story.title,
      storyTitle: story.storyTitle ?? null,
      storyUrl: story.url,
      storyId: story.storyId,
      status: story.status,
      openedBy: story.openedBy,
      productId: story.productId,
      // **描述区里的需求 wiki** → 直接当候选的文档地址（禅道是权威入口）
      wikiUrl: story.wikiUrl ?? null,
      title_from: 'zentao',
    })
  }
  return out
}
