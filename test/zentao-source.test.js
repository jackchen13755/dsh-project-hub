/**
 * 禅道需求单作为**权威来源**并入发现（DESIGN §9.10 的来源 ③）。
 *
 * 夹具用的是实测的真实 HTML 结构（zentao.example.com 经典 index.php 10.6 的需求列表页）：
 *   <tr data-id='6022'> … <td class='c-id'><a href='…storyID=6022'>6022</a>
 *   <td class='c-title' title='…'>  <td class='c-openedBy' title='Zhang San'>  <td class='c-status'><span class='status-active'>激活</span>
 * 分页权威总数在表头链接 `recTotal=461&recPerPage=20` 里 —— 不能拿本页行数当总数。
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { candidatesFromStories, parsePager, parseStoryDetail, parseStoryList, scanZentaoStories, storyUrl } from '../lib/zentao-source.js'
import { mergeCandidates } from '../lib/discover.js'
import { extractRequirementNo } from '../lib/req-no.js'
import { openStore, useTempHome } from './helpers.js'

let tmp = null
let store = null

beforeEach(() => {
  tmp = useTempHome()
  store = openStore()
})

afterEach(() => {
  try {
    store?.close()
  } catch {
    /* 已关闭 */
  }
  store = null
  tmp?.restore()
  tmp = null
})

const ROW = (id, title, openedBy, status) => `
<tr data-id='${id}' data-estimate='0' data-cases='0'>
  <td class='c-id' title=''><div class='checkbox-primary'><input type='checkbox' name='storyIDList[]' value='${id}' id='storyIDList${id}' /></div><a href='/index.php?m=story&f=view&storyID=${id}' >${id}</a> </td>
  <td class='c-pri' title=''><span class='label-pri label-pri-1' title='1'>1</span></td>
  <td class='c-title' title='${title}'><a href='/index.php?m=story&f=view&storyID=${id}' style='color: '>${title}</a> </td>
  <td class='c-openedBy' title='${openedBy}'>${openedBy}</td>
  <td class='c-assignedTo' title=''><span class=''></span></td>
  <td class='c-status' title=''><span class='status-active'>${status}</span></td>
  <td class='c-stage' title=''>未开始</td>
  <td class='c-taskCount' title=''>0</td>
</tr>`

const PAGE = (rows) => `<table><thead><tr><th><a href='/index.php?m=product&f=browse&productID=1&branch=0&browseType=unclosed&param=0&orderBy=stage_asc&recTotal=461&recPerPage=20' class='header'>阶段</a></th></tr></thead><tbody>${rows}</tbody></table>`

test('parseStoryList：按真实结构解析出需求号/标题/创建人/状态，并读分页权威值', () => {
  const html = PAGE(ROW(6022, '【5922】L&F Q3 Enhancements/Queue数据记录', 'Zhang San', '激活') + ROW(6031, '2026 BSC SLC数据需求 - 10月 Updates', 'Li Si', '已关闭'))
  const { rows, pager } = parseStoryList(html)
  assert.equal(pager.total, 461, '总数取表头 recTotal（不是本页行数）')
  assert.equal(pager.perPage, 20)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].storyId, '6022')
  assert.equal(rows[0].title, '【5922】L&F Q3 Enhancements/Queue数据记录')
  assert.equal(rows[0].openedBy, 'Zhang San')
  assert.equal(rows[0].status, '激活')
  assert.equal(rows[0].url, 'https://zentao.example.com/index.php?m=story&f=view&storyID=6022')
  // 第二条标题里没需求号 → 后面会被过滤掉
  assert.equal(extractRequirementNo(rows[1].title), null)
})

test('storyUrl / parsePager：规范地址与分页值', () => {
  assert.equal(storyUrl(6022), 'https://zentao.example.com/index.php?m=story&f=view&storyID=6022')
  assert.equal(parsePager('<a href="x?recTotal=1234&recPerPage=50">').total, 1234)
  assert.equal(parsePager('没有任何分页信息').total, null)
})

test('candidatesFromStories：号优先取标题里的，没有就用 storyID；同号去重', () => {
  // 用户给的 join key：禅道 storyID 就是需求号（storyID=5783 ↔ 分支 …-5783 ↔ wiki 页）
  const stories = [
    { storyId: '5922', title: '【5922】Queue 数据记录', url: 'u1', status: '激活', openedBy: 'Zhang San' },
    { storyId: '5783', title: 'DBF活动风控支持', url: 'u2', noFromDetail: '5783', wikiUrl: 'https://wiki.example.com/pages/viewpage.action?pageId=159221810' },
    { storyId: '5922', title: '【5922】重复的需求单', url: 'u3' },
  ]
  const candidates = candidatesFromStories(stories, { extractNo: extractRequirementNo })
  assert.equal(candidates.length, 2, '同号去重')
  const byNo = new Map(candidates.map((c) => [c.no, c]))
  assert.equal(byNo.get('5922').storyUrl, 'u1')
  assert.equal(byNo.get('5922').status, '激活')
  assert.equal(byNo.get('5922').title_from, 'zentao')
  assert.equal(byNo.get('5783').wikiUrl.includes('pageId=159221810'), true, '描述里的 wiki 跟着候选走')
})

test('scanZentaoStories：每个产品一次请求（这个实例不支持 pageID 翻页），如实报告该产品总数', async () => {
  const seen = []
  const fetchText = async (url) => {
    seen.push(url)
    assert.ok(!url.includes('pageID'), '不许带 pageID（实测会返回 0 行）')
    if (url.includes('productID=1')) {
      const rows = Array.from({ length: 20 }, (_, i) => ROW(6000 + i, `【${6000 + i}】需求`, 'Someone', '激活')).join('')
      return { ok: true, text: PAGE(rows) } // recTotal=461
    }
    return { ok: true, text: PAGE('') }
  }
  const result = await scanZentaoStories({ fetchText, productIds: ['1', '9'], withDetail: false })
  assert.equal(result.calls, 2, '两个产品两次请求（本用例只测列表路径）')
  assert.equal(result.pagination, false)
  assert.equal(result.stories.length, 20)
  assert.equal(result.products[0].total, 461, '报告里要写清该产品共多少条')
  assert.equal(result.products[0].fetched, 20, '以及本次取了多少条')
  assert.equal(result.products[1].fetched, 0)
})

test('parseStoryDetail：storyID 就是需求号，描述区里的 wiki 就是需求文档（用户给的 join key）', () => {
  const html = `<html><head><title>STORY #5783 DBF活动风控支持 - 数据中心 - 禅道</title></head><body>
    <div class='detail-content article-content'><p>需求文档：<a href='https://wiki.example.com/pages/viewpage.action?pageId=159221810'>https://wiki.example.com/pages/viewpage.action?pageId=159221810</a></p>
    <p>背景：活动风控…</p></div></div></body></html>`
  const detail = parseStoryDetail(html)
  assert.equal(detail.noFromTitle, '5783', 'STORY #5783 → 需求号')
  assert.equal(detail.storyTitle, 'DBF活动风控支持')
  assert.equal(detail.wikiUrl, 'https://wiki.example.com/pages/viewpage.action?pageId=159221810')
  assert.equal(detail.wikiPageId, '159221810')
  assert.match(detail.description, /活动风控/)
})

test('禅道候选：需求号优先用详情/标题里的号，其次 storyID；并把描述里的 wiki 当文档地址', () => {
  const stories = [
    { storyId: '5783', title: 'DBF活动风控支持', url: 'u1', status: '激活', openedBy: 'Zhang San', noFromDetail: '5783', wikiUrl: 'https://wiki.example.com/pages/viewpage.action?pageId=159221810' },
    { storyId: '6001', title: '没有号的普通单', url: 'u2' },
    { storyId: '5922', title: '【5922】Queue 数据记录', url: 'u3' },
  ]
  const candidates = candidatesFromStories(stories, { extractNo: extractRequirementNo })
  const byNo = new Map(candidates.map((c) => [c.no, c]))
  assert.equal(byNo.has('5783'), true, '详情的 STORY #N')
  assert.equal(byNo.get('5783').wikiUrl.includes('pageId=159221810'), true)
  assert.equal(byNo.has('6001'), true, '没有号就拿 storyID 当需求号（本团队 storyID == 需求号）')
  assert.equal(byNo.has('5922'), true, '列表标题里的【N】也认')
})

test('scanZentaoStories：顺带拉详情（拿 wiki 链接），并统计 detail 数', async () => {
  const fetchText = async (url) => {
    if (url.includes('f=view&storyID=')) {
      const id = url.match(/storyID=(\d+)/)[1]
      return { ok: true, text: `<html><head><title>STORY #${id} 需求 ${id} - 禅道</title></head><body><div class='detail-content article-content'>https://wiki.example.com/pages/viewpage.action?pageId=1${id}</div></div></body></html>` }
    }
    const rows = ROW(5783, 'DBF活动风控支持', 'Zhang San', '激活') + ROW(5784, '另一个需求', 'Li Si', '激活')
    return { ok: true, text: PAGE(rows) }
  }
  const result = await scanZentaoStories({ fetchText, productIds: ['1'], withDetail: true })
  assert.equal(result.products[0].details, 2, '两条都拉了详情')
  assert.equal(result.stories[0].wikiUrl.includes('pageId=15783'), true)
  assert.equal(result.stories[0].noFromDetail, '5783')
  const candidates = candidatesFromStories(result.stories, { extractNo: extractRequirementNo })
  assert.equal(candidates.length, 2)
  assert.equal(candidates[0].no, '5783')
})

test('mergeCandidates：禅道来源是权威 —— 标题/状态以它为准，分数最高', () => {
  const merged = mergeCandidates({
    fromPages: [{ no: '5922', title: '【5922】wiki 上的旧标题', docUrl: 'https://wiki.example.com/p?pageId=1', docId: '1', docChangedAt: '2026-08-17' }],
    fromTouches: [{ no: '5922', title: 'git 猜的标题', projectId: 'spms', modules: [{ module: 'src/a', commits: 3 }], codeCommits: 3, codeLastAt: '2026-09-29' }],
    fromStories: [{ no: '5922', title: '【5922】禅道的权威标题', storyUrl: 'https://zentao.example.com/index.php?m=story&f=view&storyID=6022', storyId: '6022', status: '激活', openedBy: 'Zhang San' }],
    myModules: new Set(),
    today: '2026-09-29',
  })
  assert.equal(merged.length, 1, '三个来源合成一条')
  const item = merged[0]
  assert.equal(item.title, '【5922】禅道的权威标题', '标题以禅道为准')
  assert.equal(item.titleFrom, 'zentao')
  assert.equal(item.reqStatus, '激活')
  assert.equal(item.openedBy, 'Zhang San')
  assert.ok(item.docUrl && item.codeCommits === 3, '文档与代码信息不丢')
  assert.ok(item.signals.includes('禅道需求单（权威来源）'))
  // 禅道描述里的 wiki 也能当文档地址
  const withWiki = mergeCandidates({
    fromStories: [{ no: '5783', title: 'DBF活动风控支持', storyUrl: 'https://zentao.example.com/x', wikiUrl: 'https://wiki.example.com/pages/viewpage.action?pageId=159221810' }],
    myModules: new Set(),
    today: '2026-09-29',
  })
  assert.equal(withWiki[0].docUrl, 'https://wiki.example.com/pages/viewpage.action?pageId=159221810', '禅道描述里的 wiki 直接当文档')
  // 打分：禅道 4 + 文档 2 + 代码 2 + 近 90 天改过代码 3 + 近 90 天改过文档 3 = 14
  assert.equal(item.score, 14)
})

test('store：禅道来源进候选箱（带需求单链接），采纳后链接一并进台账', async () => {
  const html = PAGE(ROW(5922, '【5922】L&F Q3 Enhancements/Queue数据记录', 'Zhang San', '激活'))
  const fetchText = async (url) => {
    if (!url.includes('zentao.example.com')) return { ok: false, error: '不该请求别的站点' }
    return { ok: true, text: html }
  }
  const scan = await store.discoverCandidates({ zentao: true, zentaoProducts: ['1'], git: false, fetchText, today: '2026-09-29' })
  assert.equal(scan.report.zentao.ok, true)
  assert.equal(scan.candidates.length, 1)
  const candidate = store.listDiscoverCandidates()[0]
  assert.equal(candidate.no, '5922')
  assert.equal(candidate.source, 'zentao')
  assert.match(candidate.story_url, /storyID=5922/)
  assert.equal(candidate.opened_by, 'Zhang San')
  assert.equal(candidate.req_status, '激活')

  await store.saveRequirement({ id: 'HS-0', project: 'hs_config', title: '占位', readTitle: false, docUrl: 'https://wiki.example.com/p?pageId=1' })
  const adopted = await store.adoptCandidate('5922', { project: 'hs_config', readTitle: false })
  assert.equal(adopted.ok, true)
  const links = store.listLinks(adopted.requirement.id)
  assert.ok(links.some((l) => l.kind === 'other' && /storyID=5922/.test(l.url)), '禅道需求单链接要进台账')
  assert.equal(store.listDiscoverCandidates().length, 0, '采纳后不再当候选')
})
