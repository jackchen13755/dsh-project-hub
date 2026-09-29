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
 *   · ⚠️ 实测这个实例**不支持 `pageID` 翻页**（带 `pageID` 直接返回 0 行，页面也没有 pager 区块）——
 *     所以这里只取每个产品列表页给出的那一批（默认最近 20 条），并在报告里如实写出"该产品共 N 条、本次取 M 条"。
 *     要看更久的历史：多给几个产品 ID，或按需求号用文档/git 来源补齐（两个来源会按需求号合并）。
 */

/** 禅道需求单的规范地址（面板/工具里点得开）。 */
export function storyUrl(storyId, { base = 'https://zentao.example.com' } = {}) {
  return `${String(base).replace(/\/$/, '')}/index.php?m=story&f=view&storyID=${Number(storyId)}`
}

/** 从列表页里读分页权威值（`recTotal` / `recPerPage`）。 */
export function parsePager(html) {
  const text = String(html ?? '')
  const total = Number(text.match(/recTotal=(\d+)/)?.[1] ?? text.match(/["']recTotal["']\s*[:=]\s*(\d+)/)?.[1] ?? NaN)
  const perPage = Number(text.match(/recPerPage=(\d+)/)?.[1] ?? text.match(/["']recPerPage["']\s*[:=]\s*(\d+)/)?.[1] ?? NaN)
  return {
    total: Number.isFinite(total) ? total : null,
    perPage: Number.isFinite(perPage) ? perPage : null,
  }
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
export async function scanZentaoStories({ fetchText, productIds = [], base = 'https://zentao.example.com', orderBy = 'id_desc' }) {
  const root = String(base).replace(/\/$/, '')
  const stories = []
  const products = []
  let calls = 0
  for (const productId of productIds) {
    const product = { productId: String(productId), total: null, perPage: null, fetched: 0, error: null }
    const url = `${root}/index.php?m=product&f=browse&productID=${encodeURIComponent(productId)}&orderBy=${encodeURIComponent(orderBy)}`
    const res = await fetchText(url)
    calls += 1
    if (!res?.ok) {
      product.error = res?.error ?? '取需求列表失败'
      products.push(product)
      continue
    }
    const parsed = parseStoryList(res.text, { base: root })
    product.total = parsed.pager.total
    product.perPage = parsed.pager.perPage
    product.fetched = parsed.rows.length
    stories.push(...parsed.rows.map((row) => ({ ...row, productId: String(productId) })))
    products.push(product)
  }
  return { stories, products, calls, pagination: false }
}

/** 需求单里标题带需求号的抽出来（禅道标题形态实测：`【5922】…`、`10 【5316】…`、`SPMS-1234 …`）。 */
export function candidatesFromStories(stories, { extractNo }) {
  const out = []
  const seen = new Set()
  for (const story of stories ?? []) {
    const no = extractNo(story?.title)
    if (!no || seen.has(no)) continue
    seen.add(no)
    out.push({
      no,
      title: story.title,
      storyUrl: story.url,
      storyId: story.storyId,
      status: story.status,
      openedBy: story.openedBy,
      productId: story.productId,
      title_from: 'zentao',
    })
  }
  return out
}
