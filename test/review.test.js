/**
 * P3：一键「评审影响报告」（DESIGN.md §9.4）。
 *
 * 这份报告的底线是**只说有证据的话**：每条相关性都要能指回"哪条需求、哪个模块/哪份稿"，
 * 证据不足时必须明说 —— 所以测试重点在「有证据时怎么说」和「没证据时不许编」两头。
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { docGaps, findRelatedRequirements, renderReviewReport, reviewQuestions, titleTokens } from '../lib/review.js'
import { buildTools } from '../lib/tools.js'
import { openStore, useTempHome } from './helpers.js'

let tmp = null
let store = null
let byName = null

beforeEach(() => {
  tmp = useTempHome()
  store = openStore()
  byName = new Map(buildTools({ store, config: {}, version: '0.1.0-test' }).map((t) => [t.name, t]))
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

const PC_DOC = 'https://www.figma.com/design/SHARED1234/PC-Board'
const DESIGN_DOC = 'https://design.example.com/queue-api'

async function seed() {
  // 目标需求：5922（还没开发 → 没有代码落点）
  await store.saveRequirement({
    id: 'SPMS-5922',
    no: '5922',
    project: 'spms',
    title: '【5922】Queue 数据记录',
    readTitle: false,
    links: [{ kind: 'ui', url: PC_DOC, title: 'PC端' }, { kind: 'design', url: DESIGN_DOC, title: '后端设计 v1' }],
  })
  // 历史需求 A：同 Figma 稿 + 同模块
  await store.saveRequirement({
    id: 'SPMS-6001',
    project: 'spms',
    title: '【6001】Queue 列表改造',
    readTitle: false,
    links: [{ kind: 'ui', url: PC_DOC, title: 'PC端' }, { kind: 'design', url: DESIGN_DOC, title: '后端设计' }],
  })
  // 历史需求 B：只有同模块
  await store.saveRequirement({ id: 'SPMS-6002', project: 'spms', title: '房态看板', readTitle: false })
  // 历史需求 C：没有任何关联
  await store.saveRequirement({ id: 'HS-7001', project: 'hs_config', title: '无关需求', readTitle: false })
  // 代码落点：A 与 B 都改过同一个模块；目标需求自己也有一条（模拟已开工）
  const touch = store.db.prepare(
    'INSERT OR REPLACE INTO code_touches (requirement_id, project_id, path, module, commits, first_seen, last_seen, sample, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
  )
  touch.run('SPMS-6001', 'spms', 'isomorph/views/LostAndFound/index.tsx', 'isomorph/views/LostAndFound', 5, '2026-08-01', '2026-09-20', 'feat: 列表改造（#6001）', Date.now())
  touch.run('SPMS-6002', 'spms', 'isomorph/views/LostAndFound/Options.tsx', 'isomorph/views/LostAndFound', 2, '2026-07-01', '2026-08-20', 'fix: 选项顺序（#6002）', Date.now())
  touch.run('SPMS-5922', 'spms', 'isomorph/views/LostAndFound/queue.tsx', 'isomorph/views/LostAndFound', 1, '2026-09-25', '2026-09-28', 'feat: 队列记录（#5922）', Date.now())
}

test('titleTokens：中英混合标题都能取到 token（中文 2-gram）', () => {
  const tokens = titleTokens('【5922】Queue 数据记录')
  assert.ok(tokens.has('queue'))
  assert.ok(tokens.has('数据') && tokens.has('据记') && tokens.has('记录'))
})

test('findRelatedRequirements：同稿 > 同模块 > 关键词，无关的不进榜', async () => {
  await seed()
  const target = store.attachLinksOne(store.requirementDetail('SPMS-5922'))
  const candidates = store.listRequirements({ archived: 'include', limit: 100 }).items.map((item) => ({ ...item, codeTouches: store.listCodeTouches(item.id) }))
  const related = findRelatedRequirements(target, candidates)

  const byId = new Map(related.map((r) => [r.id, r]))
  assert.ok(byId.has('SPMS-6001'), '同稿 + 同模块的必须上榜')
  assert.ok(byId.has('SPMS-6002'), '同模块的必须上榜')
  assert.equal(byId.has('HS-7001'), false, '完全无关的不许凑数')
  assert.ok(byId.get('SPMS-6001').score > byId.get('SPMS-6002').score, '同稿+同模块 > 只同模块')
  assert.equal(byId.get('SPMS-6001').sharedFigma.length, 1)
  assert.ok(byId.get('SPMS-6001').sharedModules.includes('isomorph/views/LostAndFound'))
  assert.ok(byId.get('SPMS-6001').reasons.some((x) => x.includes('Figma')))
  assert.ok(byId.get('SPMS-6001').reasons.some((x) => x.includes('后端设计文档')))
})

test('docGaps：优先用全文命中标记（摘要截断不许造成假警报）', () => {
  // 摘要里只有背景，但全文标记说权限/接口都写了 → 不能报"没看到"
  const gaps = docGaps('只有一段背景', ['权限/角色', '接口定义'])
  assert.equal(gaps.source, 'full-text')
  assert.deepEqual(gaps.present.sort(), ['接口定义', '权限/角色'].sort())
  assert.ok(!gaps.missing.includes('权限/角色'), '全文写了就不该报缺')
  assert.ok(gaps.missing.includes('回滚/灰度'))
  // 字符串（从 DB 读出来的 JSON）也要认
  assert.equal(docGaps(null, JSON.stringify(['数据迁移'])).source, 'full-text')
  // 没有标记时退回扫摘要
  assert.equal(docGaps('权限与角色').source, 'excerpt')
})

test('docGaps：缺什么说什么，写了的不报缺', () => {
  const gaps = docGaps('本需求涉及权限与角色：谁能审批。接口字段见附录，含入参出参。异常为空时提示。')
  assert.equal(gaps.checked, true)
  assert.ok(gaps.present.includes('权限/角色'))
  assert.ok(gaps.present.includes('接口定义'))
  assert.ok(gaps.present.includes('边界与异常'))
  assert.ok(gaps.missing.includes('回滚/灰度'))
  assert.ok(gaps.missing.includes('数据迁移'))
  assert.equal(docGaps(null).checked, false, '没有摘要时不许假装检查过')
})

test('reviewQuestions：每条问题都从证据出发；没有证据就明说', async () => {
  await seed()
  const target = store.attachLinksOne(store.requirementDetail('SPMS-5922'))
  const candidates = store.listRequirements({ archived: 'include', limit: 100 }).items.map((item) => ({ ...item, codeTouches: store.listCodeTouches(item.id) }))
  const related = findRelatedRequirements(target, candidates)
  const questions = reviewQuestions({
    target,
    related,
    drift: { verdict: 'doc-stale', reason: '文档停在 2026-08-17，但记录里出现了变更：2026-09-21「逻辑改成先扣库存」' },
    gaps: docGaps('只有一段背景'),
    coverage: 0.4,
  })
  const text = questions.join('\n')
  assert.match(text, /同一份 Figma 稿/)
  assert.match(text, /isomorph\/views\/LostAndFound/)
  assert.match(text, /记录里出现了文档之外的变更/)
  assert.match(text, /回归范围/)
  assert.match(text, /没看到：/) // 文档缺口的提醒

  // 完全没有关联需求 + 没有代码落点 → 必须承认证据不足，而不是编一个冲突
  const empty = reviewQuestions({ target: { id: 'X', projects: [], codeTouches: [] }, related: [], drift: null, gaps: { checked: false, missing: [] }, coverage: 0 })
  assert.match(empty.join('\n'), /没有代码落点证据/)
  assert.match(empty.join('\n'), /带号覆盖率 0%/)
})

test('报告口径：文档在前、开发在后（work-since-doc）不许被写成"文档没跟上"', async () => {
  const { renderReviewReport } = await import('../lib/review.js')
  const markdown = renderReviewReport({
    target: { id: 'X', title: 'T' },
    related: [],
    drift: { verdict: 'work-since-doc', reason: '文档 2026-08-17 之后一直在开发（最新 2026-09-29）—— 正常顺序' },
    gaps: { checked: false, missing: [] },
    coverage: 0.5,
  })
  assert.ok(!markdown.includes('文档之外的变更'), '正常推进不该出现在冲突点里')
  assert.match(markdown, /漂移对账：\*\*work-since-doc\*\*/)
})

test('renderReviewReport：五节齐全 + 明写边界；无关联时也说清楚', async () => {
  await seed()
  const report = store.buildReviewReport('SPMS-5922', { now: '2026-09-29 20:00' })
  assert.equal(report.ok, true)
  for (const section of ['## 1. 相关历史需求', '## 2. 潜在冲突点', '## 3. 建议在会上问清楚', '## 4. 文档缺口检查', '## 5. 复用检查（能不能不做）', '## 6. 前端交互检查', '## 7. 证据与边界']) {
    assert.ok(report.markdown.includes(section), `报告缺小节：${section}`)
  }
  assert.match(report.markdown, /SPMS-6001/)
  assert.match(report.markdown, /同一份 Figma 设计稿/)
  assert.match(report.markdown, /不是冲突概率/)
  assert.match(report.markdown, /可能可复用/, '复用检查要有内容（SPMS-6001 同稿同模块）')
  assert.ok(!report.markdown.includes('目前没有 UI 稿'), '这条需求有 Figma 链接 → 不该说没有稿')
  assert.match(report.markdown, /看不到的东西/)
  assert.ok(report.related.length >= 2)

  // 一个完全孤立的需求：报告要老实说"证据不足"，而不是空着或编
  await store.saveRequirement({ id: 'ZZ-1', project: 'zz', title: '孤零零', readTitle: false })
  const lonely = store.buildReviewReport('ZZ-1')
  assert.match(lonely.markdown, /证据不足/)
  assert.equal(lonely.related.length, 0)
})

test('评审时还没有 UI 稿：如实说明，并给出"按代码 + 正文先审"的两条路', async () => {
  await store.saveRequirement({ id: 'SPMS-7001', project: 'spms', title: '没有 UI 稿的需求', readTitle: false })
  store.db
    .prepare('INSERT OR REPLACE INTO code_touches (requirement_id, project_id, path, module, commits, first_seen, last_seen, sample, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('SPMS-7001', 'spms', 'isomorph/views/LostAndFound/index.tsx', 'isomorph/views/LostAndFound', 3, '2026-09-01', '2026-09-20', 'feat: 改交互', Date.now())
  const report = store.buildReviewReport('SPMS-7001')
  assert.match(report.markdown, /目前没有 UI 稿/, '没有 Figma 链接就要明说')
  assert.match(report.markdown, /从代码推/, '给出"按代码先审"的路径')
  assert.match(report.markdown, /无稿情形/, '问题清单要区分无稿情形（谁出稿/何时出/先按哪套交互做）')
  assert.match(report.markdown, /isomorph\/views\/LostAndFound/, '仍要列出改动落点')
})

test('renderReviewReport：无参数也能渲染（纯函数不吃 store）', () => {
  const markdown = renderReviewReport({ target: { id: 'X' }, related: [], drift: null, gaps: { checked: false, missing: [] }, docSnapshot: null, coverage: null, project: null, platform: null })
  assert.match(markdown, /^# 评审影响报告：X/m)
  assert.match(markdown, /证据不足/)
})

test('快照 + 报告：正文**后面**才写的章节也要算（不许被 400 字摘要截断误判）', async () => {
  const { snapshotDoc } = await import('../lib/doc-snapshot.js')
  const filler = '背景说明。'.repeat(200) // 先把 400 字摘要塞满
  const html = `<html><body><h1 id="title-text">【5922】Queue</h1><p>${filler}</p><p>接口定义：POST /api/queue；权限：仅前台可改；回滚：加开关。</p></body></html>`
  const snap = await snapshotDoc('https://wiki.example.com/x', { fetchText: async () => ({ ok: true, text: html }) })
  assert.ok(snap.checks.includes('接口定义'), '全文里的接口定义要被算进来')
  assert.ok(snap.checks.includes('权限/角色'))
  assert.ok(snap.checks.includes('回滚/灰度'))
  assert.ok(!snap.excerpt.includes('接口定义'), '摘要里确实看不到（所以只看摘要会误判）')
  const { docGaps } = await import('../lib/review.js')
  const gaps = docGaps(snap.excerpt, snap.checks)
  assert.ok(!gaps.missing.includes('接口定义'), '用全文标记后不再误报缺失')
  assert.ok(gaps.missing.includes('数据迁移'), '真没写的还是要报')
})

test('工具面：ph_review 返回 Markdown 与相关需求', async () => {
  await seed()
  const result = await byName.get('ph_review').execute({ id: 'SPMS-5922' })
  assert.equal(result.ok, true)
  assert.match(result.text, /评审影响报告/)
  assert.ok(result.related.some((r) => r.id === 'SPMS-6001'))

  const missing = await byName.get('ph_review').execute({ id: 'NO-SUCH' })
  assert.equal(missing.ok, false)
  assert.match(missing.text, /没有找到需求/)
})

test('API：POST /review-report 与 GET /review-report', async () => {
  const { captureApi, callApi } = await import('./helpers.js')
  await seed()
  const api = captureApi(store, { version: 't' })
  const post = await callApi(api.handler, { method: 'POST', url: '/project-hub/api/review-report', body: { id: 'SPMS-5922' } })
  assert.equal(post.statusCode, 200)
  assert.match(post.json.markdown, /## 7. 证据与边界/)
  const get = await callApi(api.handler, { method: 'GET', url: '/project-hub/api/review-report?id=SPMS-5922' })
  assert.equal(get.statusCode, 200)
  assert.match(get.json.markdown, /## 7. 证据与边界/)
  assert.ok(get.json.related.length >= 2)
  const bad = await callApi(api.handler, { method: 'GET', url: '/project-hub/api/review-report' })
  assert.equal(bad.statusCode, 400)
  const notFound = await callApi(api.handler, { method: 'GET', url: '/project-hub/api/review-report?id=NOPE' })
  assert.equal(notFound.statusCode, 404)
})
