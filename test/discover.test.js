/**
 * 发现历史需求（候选箱）。
 *
 * 设计要点（都在这份测试里钉住）：
 *   ① **候选 ≠ 台账**：扫描只写候选箱，采纳了才进台账；
 *   ② 只有**标题里带需求号**的文档才算候选（1239 页里绝大多数是模块说明页，不是需求）；
 *   ③ git 侧是零成本骨架（需求号 + 代码落点），没有文档也能当候选；
 *   ④ 打分把「与你在做的需求同模块」排前面；已在台账/已忽略/已采纳的都不再出现。
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { candidateOverlaps, candidatesFromPages, candidatesFromTouches, looksLikeTagOrRelease, mergeCandidates, parseSearchResults } from '../lib/discover.js'
import { branchRequirementNo } from '../lib/git-index.js'
import { buildTools } from '../lib/tools.js'
import { captureApi, callApi, openStore, useTempHome } from './helpers.js'

let tmp = null
let store = null
let api = null
let byName = null

beforeEach(() => {
  tmp = useTempHome()
  store = openStore()
  api = captureApi(store, { version: '0.1.0-test' })
  byName = new Map(buildTools({ store, config: {}, version: '0.1.0-test' }).map((t) => [t.name, t]))
})

afterEach(() => {
  try {
    store?.close()
  } catch {
    /* 已关闭 */
  }
  store = null
  api = null
  tmp?.restore()
  tmp = null
})

const SEARCH_PAYLOAD = {
  totalSize: 3,
  // 真实响应自带 `_links.base`（实测）—— 靠它把 URL 拼成绝对地址
  _links: { base: 'https://wiki.example.com', context: '' },
  results: [
    { title: '【5922】L&F Q3 Enhancements', url: '/display/SS/x', lastModified: '2026-09-20T10:00:00.000+08:00', content: { id: '161331405' } },
    { title: '11  Housekeeping', url: '/display/SS/hk', lastModified: '2026-09-28T10:00:00.000+08:00', content: { id: '73666409' } },
    { title: 'SPMS-5829 账单锁', url: '/display/SS/lock', lastModified: '2026-09-29T10:00:00.000+08:00', content: { id: '999' } },
  ],
}

test('parseSearchResults：拼出规范 pageId 地址，并带上 totalSize', () => {
  const parsed = parseSearchResults(SEARCH_PAYLOAD, { base: 'https://wiki.example.com' })
  assert.equal(parsed.total, 3)
  assert.equal(parsed.rows[0].url, 'https://wiki.example.com/pages/viewpage.action?pageId=161331405')
  assert.equal(parsed.rows[0].changedAt, '2026-09-20')
})

test('candidatesFromPages：只有标题带需求号的才算候选（模块页不算）', () => {
  const pages = parseSearchResults(SEARCH_PAYLOAD, { base: 'https://wiki.example.com' }).rows
  const candidates = candidatesFromPages(pages)
  assert.deepEqual(candidates.map((c) => c.no).sort(), ['5829', '5922'])
  assert.ok(!candidates.some((c) => c.title.includes('Housekeeping')), '模块说明页不是需求')
  assert.equal(candidates.find((c) => c.no === '5922').docUrl.includes('pageId=161331405'), true)
})

test('candidatesFromTouches：零成本骨架（需求号 + 模块 + 时间），台账已有的排除', () => {
  const touches = [
    { requirement_id: '5829', project_id: 'spms', module: 'isomorph/views/Reservation', commits: 88, first_seen: '2026-09-01', last_seen: '2026-09-29', sample: "Merge branch 'feature/20260922-log-lock-5829'" },
    { requirement_id: '5829', project_id: 'spms', module: 'isomorph/models/Reservation', commits: 9, first_seen: '2026-09-02', last_seen: '2026-09-28', sample: null },
    { requirement_id: '6031', project_id: 'spms', module: 'isomorph/views/Profile', commits: 3, first_seen: '2026-09-10', last_seen: '2026-09-20', sample: null },
  ]
  const candidates = candidatesFromTouches({ touches, known: new Set(['6031']) })
  assert.equal(candidates.length, 1, '台账已有的不再当候选')
  assert.equal(candidates[0].no, '5829')
  assert.equal(candidates[0].codeCommits, 97)
  assert.equal(candidates[0].modules[0].module, 'isomorph/views/Reservation')
  assert.match(candidates[0].title, /log lock/i, '用分支名猜一个能看的标题')
})

test('mergeCandidates：同模块 / 近期改动排前面，分数只用于排队', () => {
  const fromPages = candidatesFromPages(parseSearchResults(SEARCH_PAYLOAD, { base: 'https://wiki.example.com' }).rows)
  const fromTouches = candidatesFromTouches({
    touches: [{ requirement_id: '5829', project_id: 'spms', module: 'isomorph/views/Reservation', commits: 5, first_seen: '2026-09-01', last_seen: '2026-09-29', sample: 'x' }],
    known: [],
  })
  const merged = mergeCandidates({
    fromPages,
    fromTouches,
    myModules: new Set(['isomorph/views/Reservation']),
    recentDays: 90,
    today: '2026-09-29',
  })
  const byNo = new Map(merged.map((c) => [c.no, c]))
  assert.equal(byNo.get('5829').score > byNo.get('5922').score, true, '既有文档又有代码+同模块的应排前')
  assert.deepEqual(byNo.get('5829').sameModuleAs, ['isomorph/views/Reservation'])
  assert.ok(byNo.get('5829').signals.some((s) => s.includes('同模块')))
  // 文档 + 代码都有 → 合并成一条
  assert.equal(merged.filter((c) => c.no === '5829').length, 1)
  assert.equal(byNo.get('5829').docUrl.includes('pageId=999'), true)
})

test('store：扫描只写候选箱（不动台账）+ 采纳才进台账 + 忽略后不再出现', async () => {
  // 台账里已有 6031（git 候选里也有 → 不该再出现）
  await store.saveRequirement({ id: 'SPMS-6031', no: '6031', project: 'spms', title: '已有需求', readTitle: false })
  // 造代码索引行
  const touch = store.db.prepare('INSERT OR REPLACE INTO code_touches (requirement_id, project_id, path, module, commits, first_seen, last_seen, sample, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
  touch.run('5829', 'spms', 'isomorph/views/Reservation/a.tsx', 'isomorph/views/Reservation', 12, '2026-09-01', '2026-09-29', "Merge branch 'feature/20260922-log-lock-5829'", Date.now())
  touch.run('6031', 'spms', 'isomorph/views/Profile/a.tsx', 'isomorph/views/Profile', 3, '2026-09-10', '2026-09-20', 'x', Date.now())

  const fetchText = async (url) => {
    if (url.includes('/rest/api/search')) return { ok: true, text: JSON.stringify(SEARCH_PAYLOAD) }
    if (url.includes('/rest/api/content/')) {
      return { ok: true, text: JSON.stringify({ title: '【5922】L&F Q3 Enhancements', version: { number: 8, when: '2026-08-17T16:45:35.000+08:00' }, history: { createdBy: { displayName: 'Someone' } } }) }
    }
    if (url.includes('pageId=161331405')) {
      return { ok: true, text: '<html><body><h1 id="title-text">【5922】L&F Q3 Enhancements</h1><p>相关人员：产品：张三</p></body></html>' }
    }
    return { ok: false, error: `unexpected url ${url}` }
  }

  const before = store.listRequirements({ archived: 'include', limit: 100 }).items.length
  const scan = await store.discoverCandidates({ rootPageId: '29203066', fetchText, today: '2026-09-29' })
  assert.equal(scan.ok, true)
  assert.equal(store.listRequirements({ archived: 'include', limit: 100 }).items.length, before, '扫描不许往台账写')

  const candidates = store.listDiscoverCandidates()
  const nos = candidates.map((c) => c.no).sort()
  assert.deepEqual(nos, ['5829', '5922'], '6031 已在台账 → 不进候选；Housekeeping 模块页不算')
  const top = candidates[0]
  assert.equal(top.no, '5829', '有代码+同模块（沿用旧索引）的排前面')
  assert.ok(Number(top.score) > 0)

  // 采纳 → 进台账 + 带标签 + 状态
  const adopted = await store.adoptCandidate('5922', { project: 'spms', platform: 'PC', fetchText })
  assert.equal(adopted.ok, true, JSON.stringify(adopted))
  assert.ok(adopted.requirement, `adopt 应返回落库后的需求：${JSON.stringify(adopted)}`)
  const req = store.attachLinksOne(store.requirementDetail(adopted.requirement.id))
  assert.ok(req, '采纳后应能在台账里查到')
  assert.equal(req.id, 'SPMS-5922')
  assert.equal(req.no, '5922')
  assert.match(req.title, /L&F Q3/, '标题来自文档（读回来比 git 猜的准）')
  assert.equal(req.status, 'planning')
  assert.ok((req.tags ?? []).includes('历史导入'))
  const docLink = (req.links ?? []).find((l) => l.kind === 'doc')
  assert.ok(docLink && docLink.url.includes('pageId=161331405'))
  assert.match(docLink.url, /^https?:\/\//, '文档链接必须是绝对地址（相对地址在面板上点不开）')
  assert.equal(store.listDiscoverCandidates().some((c) => c.no === '5922'), false, '采纳后不再当候选')

  // 忽略 → 后续扫描也不再出现
  store.ignoreCandidate('5829')
  await store.discoverCandidates({ rootPageId: '29203066', fetchText, today: '2026-09-29' })
  assert.equal(store.listDiscoverCandidates().some((c) => c.no === '5829'), false, '忽略的不再打扰')
})

test('API + 工具面：scan / list / adopt / ignore 都能用', async () => {
  const touch = store.db.prepare('INSERT OR REPLACE INTO code_touches (requirement_id, project_id, path, module, commits, first_seen, last_seen, sample, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
  touch.run('5829', 'spms', 'src/a.ts', 'src', 3, '2026-09-01', '2026-09-29', 'x', Date.now())
  const scan = await callApi(api.handler, { method: 'POST', url: '/project-hub/api/discover/scan', body: { git: true } })
  assert.equal(scan.statusCode, 200)
  assert.equal(scan.json.candidates.some((c) => c.no === '5829'), true)

  const list = await callApi(api.handler, { method: 'GET', url: '/project-hub/api/discover' })
  assert.equal(list.statusCode, 200)
  assert.ok(list.json.items.length >= 1)

  const tool = byName.get('ph_discover')
  const listed = await tool.execute({ action: 'list' })
  assert.match(listed.text, /候选箱/)
  const ignore = await tool.execute({ action: 'ignore', no: '5829' })
  assert.match(ignore.text, /已忽略/)
  const adoptMissing = await tool.execute({ action: 'adopt', no: 'NOPE' })
  assert.match(adoptMissing.text, /采纳失败/)
})

test('发布/打标签的痕迹不算需求（UAT tag 的时间戳曾被当成需求号）', () => {
  // 实测：Merge tag 'tags/uf-20260922-173930-zhangju' → 173930 被当成了需求号
  assert.equal(looksLikeTagOrRelease("Merge tag 'tags/uf-20260922-173930-zhangju'"), true)
  assert.equal(looksLikeTagOrRelease("Merge branch 'release-wl' into uatfix/x"), true)
  assert.equal(looksLikeTagOrRelease("Merge branch 'feature/20260922-log-lock-5829'"), false)
  const candidates = candidatesFromTouches({
    touches: [
      { requirement_id: '173930', project_id: 'spms', module: 'x', commits: 1, first_seen: '2026-09-22', last_seen: '2026-09-22', sample: "Merge tag 'tags/uf-20260922-173930-zhangju'" },
      { requirement_id: '5829', project_id: 'spms', module: 'y', commits: 5, first_seen: '2026-09-01', last_seen: '2026-09-29', sample: "Merge branch 'feature/20260922-log-lock-5829'" },
    ],
    known: [],
  })
  assert.equal(candidates.length, 1, '标签行要被过滤')
  assert.equal(candidates[0].no, '5829')
})

test('分支尾号：HHMMSS 与首位非 5–9 的都不认', () => {
  assert.equal(branchRequirementNo("Merge tag 'tags/uf-20260922-173930-zhangju'"), null)
  assert.equal(branchRequirementNo('feature/20260922-log-lock-5829'), '5829')
  assert.equal(branchRequirementNo('uatfix/20260922-payment-method-55716'), '55716')
  assert.equal(branchRequirementNo('hotfix/20251209-reservation'), null)
})

test('候选箱以最近一次扫描为准：这轮没扫到的候选要清掉（人工结论保留）', async () => {
  const touch = store.db.prepare('INSERT OR REPLACE INTO code_touches (requirement_id, project_id, path, module, commits, first_seen, last_seen, sample, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
  touch.run('5829', 'spms', 'src/a.ts', 'src', 3, '2026-09-01', '2026-09-29', "Merge branch 'feature/20260922-log-lock-5829'", Date.now())
  await store.discoverCandidates({ git: true })
  assert.equal(store.listDiscoverCandidates().length, 1)

  // 人工忽略 → 即使它还在源里也不再出现
  store.ignoreCandidate('5829')
  await store.discoverCandidates({ git: true })
  assert.equal(store.listDiscoverCandidates().length, 0)

  // 新来一个候选，然后把这个源"删掉"（模拟这轮扫不到）→ 旧的开放候选应被清掉
  touch.run('5862', 'spms', 'src/b.ts', 'src', 2, '2026-09-10', '2026-09-20', "Merge branch 'feature/20260910-refund-5862'", Date.now())
  await store.discoverCandidates({ git: true })
  assert.equal(store.listDiscoverCandidates().length, 1)
  store.db.prepare('DELETE FROM code_touches WHERE requirement_id = ?').run('5862')
  const rescanned = await store.discoverCandidates({ git: true })
  assert.equal(rescanned.dropped, 1, '这轮没扫到的候选要被清掉')
  assert.equal(store.listDiscoverCandidates().length, 0)
})

test('某一来源这轮没扫到东西（会话失效）→ 不许清掉它上一轮发现的候选', async () => {
  const touch = store.db.prepare('INSERT OR REPLACE INTO code_touches (requirement_id, project_id, path, module, commits, first_seen, last_seen, sample, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
  touch.run('5829', 'spms', 'src/a.ts', 'src', 1, '2026-09-01', '2026-09-01', 'x', Date.now())
  await store.saveRequirement({ id: 'HS-1', project: 'hs_config', title: '既定', readTitle: false, docUrl: 'https://wiki.example.com/pages/viewpage.action?pageId=1' })
  const okFetch = async () => ({
    ok: true,
    text: JSON.stringify({ totalSize: 1, _links: { base: 'https://wiki.example.com' }, results: [{ title: '【5862】退款弹窗', content: { id: '777' }, lastModified: '2026-09-20T10:00:00.000+08:00' }] }),
  })
  await store.discoverCandidates({ rootPageId: '1', git: true, fetchText: okFetch, today: '2026-09-29' })
  const withDoc = store.listDiscoverCandidates()
  assert.equal(withDoc.length, 2, '文档候选 + git 候选各一条')

  // 文档侧会话失效（0 页）→ 文档候选必须留着，git 侧照旧
  const deadFetch = async () => ({ ok: false, error: '取到的是登录页（策略 bridge）' })
  const rescan = await store.discoverCandidates({ rootPageId: '1', git: true, fetchText: deadFetch, today: '2026-09-29' })
  assert.equal(rescan.dropped, 0, '会话失效的一轮不许清任何东西')
  const after = store.listDiscoverCandidates()
  assert.equal(after.filter((c) => c.doc_url).length, 1, '文档候选要留着')
  assert.match(rescan.report.confluence.hint, /浏览器登录态/)
})

test('部分成功也要用：中途遇到登录页时保留已抓到的页', async () => {
  const touch = store.db.prepare('INSERT OR REPLACE INTO code_touches (requirement_id, project_id, path, module, commits, first_seen, last_seen, sample, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
  touch.run('5829', 'spms', 'src/a.ts', 'src', 1, '2026-09-01', '2026-09-01', 'x', Date.now())
  let call = 0
  const fetchText = async (url) => {
    if (!url.includes('/rest/api/search')) return { ok: false, error: 'unexpected' }
    call += 1
    // 第 2 次起返回登录页（重试也失败）→ 只留下第 1 批
    if (call >= 2) return { ok: false, error: '取到的是登录页（策略 bridge）' }
    return {
      ok: true,
      text: JSON.stringify({
        totalSize: 400,
        _links: { base: 'https://wiki.example.com' },
        results: [{ title: '【5862】退款弹窗', content: { id: '777' }, lastModified: '2026-09-20T10:00:00.000+08:00' }],
      }),
    }
  }
  const scan = await store.discoverCandidates({ rootPageId: '29203066', git: false, fetchText, today: '2026-09-29', maxPages: 400 })
  assert.equal(scan.report.confluence.partial, true, '要如实标注是部分结果')
  assert.equal(scan.report.confluence.pages, 1, '已抓到的页要保留（不许因为中断全丢）')
  assert.ok(scan.candidates.some((c) => c.no === '5862'), '部分结果里的候选照样进候选箱')
})

test('续扫：上次扫到一半被打断，下次从游标接着扫（1239 页要能分几次扫完）', async () => {
  const page = (no) => ({ title: `【${no}】需求 ${no}`, content: { id: String(no) }, lastModified: '2026-09-20T10:00:00.000+08:00' })
  // 台账里已有文档链接 → 站点 origin 从它推出来（这就是生产里的 base 来源之一）
  await store.saveRequirement({ id: 'HS-1', project: 'hs_config', title: '既定需求', readTitle: false, docUrl: 'https://wiki.example.com/pages/viewpage.action?pageId=1' })
  let calls = 0
  const fetchText = async (url) => {
    calls += 1
    const start = Number((String(url).match(/start=(\d+)/) ?? [])[1] ?? 0)
    // 第一次扫：第 1 批成功，第 2 批失效 → 停在 offset 200
    if (calls >= 2 && calls <= 3) return { ok: false, error: '取到的是登录页（策略 bridge）' }
    const results = start === 0 ? [page(5001), page(5002)] : [page(5003)]
    return { ok: true, text: JSON.stringify({ totalSize: 300, _links: { base: 'https://wiki.example.com' }, results }) }
  }
  const first = await store.discoverCandidates({ rootPageId: '1', git: false, fetchText, today: '2026-09-29' })
  assert.equal(first.report.base, 'https://wiki.example.com', 'CQL 要用绝对地址（origin 取自台账里的文档链接）')
  assert.equal(first.report.confluence.partial, true)
  assert.equal(first.report.confluence.nextStart, 200, '游标停在被打断的位置')
  assert.ok(first.candidates.some((c) => c.no === '5001'))

  // 第二次扫：从 200 接着扫（不再重复抓第 1 批），这回扫到底
  calls = 0
  const second = await store.discoverCandidates({ rootPageId: '1', git: false, fetchText, today: '2026-09-29' })
  assert.equal(second.report.confluence.from, 200, '第二次要从游标处开始')
  assert.equal(second.report.confluence.finished, true)
  assert.equal(second.report.confluence.nextStart, 0, '扫到底后游标归零')
  const state = store.discoverState().find((s) => s.source === 'confluence')
  assert.equal(state.cursor, 'offset:0')
})

test('候选之间互相比：同模块算强信号；通用词（优化/逻辑）不许凑噪声', () => {
  // 实测：不排停用词时 200 条里 191 条互相"重叠"，全是「优化」「逻辑」这种
  const noisy = candidateOverlaps([
    { no: 'A', title: '任务生成逻辑优化', modules: [] },
    { no: 'B', title: '报表逻辑优化', modules: [] },
    { no: 'C', title: '优化一下', modules: [] },
  ])
  assert.equal(noisy.size, 0, '只靠通用词重合 → 不许报“跟谁重”')
  // 有区分度的词（英文/长词）才认
  const real = candidateOverlaps([
    { no: 'D', title: 'lostfound 查询迁移', modules: [] },
    { no: 'E', title: 'lostfound 列表迁移', modules: [] },
  ])
  assert.equal(real.get('D')[0].no, 'E', 'lostfound + 迁移 两个有区分度的词 → 算信号')
})

test('候选之间互相比：同模块（强）/ 同关键词（弱），双向都给', () => {
  const rows = [
    { no: '5901', title: 'lostfound 查询迁移', modules: ['isomorph/views/Housekeeping', 'isomorph/models/LostAndFound'], code_commits: 5 },
    { no: '5902', title: 'lostfound 查询优化', modules: ['isomorph/views/Housekeeping'], code_commits: 2 },
    { no: '5903', title: '完全无关的东西', modules: ['isomorph/views/Finance'], code_commits: 1 },
    { no: '5904', title: 'lostfound 查询迁移二期', modules: ['isomorph/models/LostAndFound'], code_commits: 1 },
  ]
  const map = candidateOverlaps(rows)
  const a = map.get('5901')
  // 排序按总重叠分：5904 与 5901 同模块 + 两个有区分度的词 → 排在 5902 前面
  assert.equal(a[0].no, '5904')
  assert.ok(a.some((x) => x.no === '5902'))
  assert.ok(a[0].score >= a.find((x) => x.no === '5902').score)
  assert.ok(!a.some((x) => x.no === '5903'), '没有交集的不要凑数')
  const withView = a.find((x) => x.no === '5902')
  assert.ok(withView.sharedModules.includes('isomorph/views/Housekeeping'))
  assert.ok(withView.reasons.join('|').includes('同一代码模块'))
  // 双向
  assert.ok(map.get('5902').some((x) => x.no === '5901'))
  // 字符串形态的 modules（从 DB 读出来的 JSON）也要认
  const fromDb = candidateOverlaps([{ no: 'A', title: 'x', modules: '["m/1"]' }, { no: 'B', title: 'y', modules: '["m/1"]' }])
  assert.equal(fromDb.get('A')[0].no, 'B')
})

test('store：候选箱带出 overlaps（全量算完再截断）', async () => {
  const touch = store.db.prepare('INSERT OR REPLACE INTO code_touches (requirement_id, project_id, path, module, commits, first_seen, last_seen, sample, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
  touch.run('5901', 'spms', 'isomorph/views/Housekeeping/a.tsx', 'isomorph/views/Housekeeping', 5, '2026-09-01', '2026-09-20', "Merge branch 'feature/20260901-lf-5901'", Date.now())
  touch.run('5902', 'spms', 'isomorph/views/Housekeeping/b.tsx', 'isomorph/views/Housekeeping', 3, '2026-09-02', '2026-09-21', "Merge branch 'feature/20260902-lf-5902'", Date.now())
  await store.discoverCandidates({ git: true, today: '2026-09-29' })
  const items = store.listDiscoverCandidates()
  assert.equal(items.length, 2)
  const first = items.find((x) => x.no === '5901')
  assert.ok(first.overlaps.length >= 1, '要给候选带上"跟谁重"')
  assert.equal(first.overlaps[0].no, '5902')
})

test('定时增量发现的开关存 meta（0=关闭；开启后即时可读，不用改配置/重启）', async () => {
  const settings = store.discoverSettings()
  assert.equal(settings.intervalMinutes, 0, '默认关闭')
  const saved = store.saveDiscoverSettings({ intervalMinutes: 1440 })
  assert.equal(saved.intervalMinutes, 1440)
  assert.equal(store.discoverSettings().intervalMinutes, 1440, '心跳每轮读它 → 一开即生效')
  store.saveDiscoverSettings({ intervalMinutes: 0 })
  assert.equal(store.discoverSettings().intervalMinutes, 0)
})

test('增量扫描不许清候选（它只看最近几天 —— 实测把上一轮的 151 条历史候选全清了）', async () => {
  await store.saveRequirement({ id: 'HS-1', project: 'hs_config', title: '既定', readTitle: false, docUrl: 'https://wiki.example.com/pages/viewpage.action?pageId=1' })
  const page = (no) => ({ title: `【${no}】需求 ${no}`, content: { id: String(no) }, lastModified: '2026-09-20T10:00:00.000+08:00' })
  const fetchBoth = async () => ({ ok: true, text: JSON.stringify({ totalSize: 2, _links: { base: 'https://wiki.example.com' }, results: [page(5901), page(5902)] }) })
  await store.discoverCandidates({ rootPageId: '1', git: false, fetchText: fetchBoth, today: '2026-09-29' })
  assert.equal(store.listDiscoverCandidates().length, 2)

  // 增量（sinceDay）：文档树只回了 5902（5901 不在窗口内）→ 5901 绝不能被清掉
  const fetchOnlyRecent = async () => ({ ok: true, text: JSON.stringify({ totalSize: 1, _links: { base: 'https://wiki.example.com' }, results: [page(5902)] }) })
  const inc = await store.discoverCandidates({ rootPageId: '1', git: false, sinceDay: '2026-09-26', fetchText: fetchOnlyRecent, today: '2026-09-29' })
  assert.equal(inc.dropped, 0, '增量不清理')
  assert.equal(store.listDiscoverCandidates().length, 2, '上一轮的候选要留着')

  // 全量重扫（无 sinceDay 且扫到底）→ 这时才可以按"没扫到"清理
  const full = await store.discoverCandidates({ rootPageId: '1', git: false, fetchText: fetchOnlyRecent, today: '2026-09-29' })
  assert.equal(full.dropped, 1, '全量扫描才清理')
})
