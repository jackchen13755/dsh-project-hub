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
import { candidatesFromStories, pageUrlFrom, parsePager, parseStoryDetail, parseStoryList, scanZentaoStories, storyUrl } from '../lib/zentao-source.js'
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

const PAGE = (rows, { total = 461, page = 1, perPage = 20 } = {}) => `<table><thead><tr><th><a href='/index.php?m=product&f=browse&productID=1&branch=0&browseType=unclosed&param=0&orderBy=stage_asc&recTotal=${total}&recPerPage=${perPage}' class='header'>阶段</a></th></tr></thead><tbody>${rows}</tbody></table>
  <ul class='pagerProductBrowse' data-ride='pager' data-rec-total='${total}' data-rec-per-page='${perPage}' data-page='${page}' data-link-creator='/index.php?m=product&f=browse&productID=1&branch=&browseType=unclosed&param=0&orderBy=&recTotal=${total}&recPerPage={recPerPage}&pageID={page}'></ul>`

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

test('scanZentaoStories：按页面里的分页器模板翻页（别自己拼参数 —— 少 param=0 会返回 0 行）', async () => {
  const seen = []
  const pages = { 1: 20, 2: 20, 3: 5 }
  const fetchText = async (url) => {
    seen.push(url)
    const page = Number(url.match(/pageID=(\d+)/)?.[1] ?? 1)
    if (page > 3) throw new Error('不该请求第 4 页')
    const rows = Array.from({ length: pages[page] }, (_, i) => ROW(6000 + (3 - page) * 100 + i, `【${6000 + (3 - page) * 100 + i}】需求`, 'Zhang San', '激活')).join('')
    return { ok: true, text: PAGE(rows, { total: 45, page }) }
  }
  const result = await scanZentaoStories({ fetchText, productIds: ['15'], maxPages: 5, withDetail: false })
  assert.equal(result.pagination, true)
  assert.equal(result.stories.length, 45, '20 + 20 + 5（第 3 页不满就停）')
  assert.equal(result.products[0].total, 45)
  assert.equal(result.products[0].pages, 3)
  assert.equal(seen.length, 3, '只请求 3 页')
  assert.match(seen[1], /pageID=2/)
  assert.match(seen[1], /param=0/, '翻页链接要带上分页器模板里的参数')
  assert.match(seen[1], /browseType=unclosed/)
})

test('parsePager / pageUrlFrom：读分页器权威值，并用模板拼下一页', () => {
  const html = PAGE('', { total: 430, page: 2, perPage: 20 })
  const pager = parsePager(html)
  assert.equal(pager.total, 430)
  assert.equal(pager.perPage, 20)
  assert.equal(pager.page, 2)
  assert.match(pager.linkCreator, /pageID=\{page\}/)
  const next = pageUrlFrom(pager.linkCreator, 3, { base: 'https://zentao.example.com', perPage: 20 })
  assert.match(next, /^https:\/\/zentao\.example\.com\/index\.php\?/)
  assert.match(next, /pageID=3/)
  assert.match(next, /recPerPage=20/)
  assert.equal(pageUrlFrom(null, 2), null, '没有模板就不翻页')
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
