/**
 * P2：文档漂移三方对账（DESIGN.md §9.3）。
 *
 * 判定只是**时序比较**，不做语义判断；这条测试把五种结论都钉住，
 * 并确认「只存指纹不存全文」这条隐私约定真的成立。
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { dayOf, excerptOf, hashText, verdictOf } from '../lib/drift.js'
import { snapshotDoc } from '../lib/doc-snapshot.js'
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

test('dayOf：三种日期写法归一，认不出返回 null', () => {
  assert.equal(dayOf('2026-09-29T15:03:57.000+08:00'), '2026-09-29')
  assert.equal(dayOf('2026-09-29'), '2026-09-29')
  assert.equal(dayOf('20260929'), '2026-09-29')
  assert.equal(dayOf(''), null)
  assert.equal(dayOf('不是日期'), null)
  assert.equal(dayOf(null), null)
})

test('verdictOf：五种结论 + 证据行', () => {
  // 代码比文档新 → 文档没跟上（核心场景）
  const stale = verdictOf({ docChangedAt: '2026-08-17', codeLastAt: '2026-09-20', sessionLastAt: '2026-09-21', today: '2026-09-29' })
  assert.equal(stale.verdict, 'doc-stale')
  assert.match(stale.reason, /变更很可能没回写文档/)
  assert.equal(stale.evidence.join('|'), '文档：2026-08-17|代码：2026-09-20|记录：2026-09-21')

  // 会话记录比文档新也算（代码还没提交但已经聊了/记了）
  assert.equal(verdictOf({ docChangedAt: '2026-08-17', sessionLastAt: '2026-09-01', today: '2026-09-29' }).verdict, 'doc-stale')
  // 文档更新但没开发
  assert.equal(verdictOf({ docChangedAt: '2026-09-20', today: '2026-09-29' }).verdict, 'code-pending')
  // 文档不早于代码 → 跟上了
  assert.equal(verdictOf({ docChangedAt: '2026-09-20', codeLastAt: '2026-09-18', today: '2026-09-29' }).verdict, 'aligned')
  // 都停很久了 → silent 压过 doc-stale（都没人动了，别再催文档）
  assert.equal(verdictOf({ docChangedAt: '2026-05-01', codeLastAt: '2026-05-02', today: '2026-09-29', silentDays: 30 }).verdict, 'silent')
  // 但代码是最近动的 → 仍然是文档没跟上
  assert.equal(verdictOf({ docChangedAt: '2026-05-01', codeLastAt: '2026-09-20', today: '2026-09-29', silentDays: 30 }).verdict, 'doc-stale')
  // 数据不足
  assert.equal(verdictOf({ today: '2026-09-29' }).verdict, 'unknown')
  assert.equal(verdictOf({ codeLastAt: '2026-09-20', today: '2026-09-29' }).verdict, 'unknown')
})

test('hashText / excerptOf：指纹稳定，摘要不留全文', () => {
  assert.equal(hashText('需求正文'), hashText('需求正文'))
  assert.notEqual(hashText('需求正文'), hashText('需求正文（改过）'))
  const long = 'x'.repeat(1000)
  const excerpt = excerptOf(long, { limit: 100 })
  assert.equal(excerpt.length, 101, '摘要 = limit + 省略号')
  assert.ok(excerpt.endsWith('…'))
  assert.equal(excerptOf('短'), '短')
})

test('snapshotDoc：Confluence 页面 → 版本号 + hash + 摘要（不返回全文）', async () => {
  const page = `<!doctype html><html><head><title>【5922】Queue - Demo - Example Wiki</title></head><body>
<h1 id="title-text">【5922】Queue 数据记录</h1><p>相关人员：产品：张三</p><p>背景：队列数据记录改造。</p></body></html>`
  const rest = JSON.stringify({ title: '【5922】Queue 数据记录', version: { number: 7, when: '2026-08-17T10:00:00.000+08:00' } })
  const snap = await snapshotDoc('https://wiki.example.com/pages/viewpage.action?pageId=1', {
    fetchText: async (url) => ({ ok: true, text: url.includes('/rest/api/') ? rest : page, strategy: 'bridge' }),
  })
  assert.equal(snap.ok, true)
  assert.equal(snap.title, '【5922】Queue 数据记录')
  assert.equal(snap.version, '7')
  assert.equal(snap.changedAt, '2026-08-17T10:00:00.000+08:00')
  assert.equal(typeof snap.hash, 'string')
  assert.ok(snap.excerpt.includes('队列数据记录改造'))
  assert.equal('text' in snap, false, '快照**不返回也不存**全文')
})

test('store：抓快照 → 落库（版本/hash/摘要，无全文列）→ computeDrift 出结论', async () => {
  await store.saveRequirement({
    id: 'SPMS-5922',
    no: '5922',
    project: 'spms',
    title: '【5922】Queue 数据记录',
    readTitle: false,
    links: [{ kind: 'doc', url: 'https://wiki.example.com/pages/viewpage.action?pageId=1' }],
  })
  const page = '<html><body><h1 id="title-text">【5922】Queue 数据记录</h1><p>正文</p></body></html>'
  const rest = JSON.stringify({ title: '【5922】Queue 数据记录', version: { number: 3, when: '2026-08-17T10:00:00.000+08:00' } })
  const refreshed = await store.refreshDocSnapshots({
    id: 'SPMS-5922',
    fetchText: async (url) => ({ ok: true, text: url.includes('/rest/api/') ? rest : page, strategy: 'bridge' }),
  })
  assert.equal(refreshed.snapshots[0].ok, true)
  assert.equal(refreshed.snapshots[0].version, '3')

  const snap = store.listDocSnapshots()[0]
  assert.equal(snap.requirement_id, 'SPMS-5922')
  assert.equal(snap.version, '3')
  assert.ok(snap.hash)
  assert.ok(snap.excerpt)
  const columns = store.db.prepare('PRAGMA table_info(doc_snapshots)').all().map((r) => r.name)
  assert.equal(columns.includes('text'), false, 'doc_snapshots 里不能有正文字段')
  assert.ok(columns.includes('checks'), '要有全文关键词命中标记（避免摘要截断造成文档缺口假警报）')

  // 造出「代码比文档新」：一条 9 月的代码落点 + 一条 9 月的记录
  store.db.prepare('INSERT OR REPLACE INTO code_touches (requirement_id, project_id, path, module, commits, first_seen, last_seen, sample, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('SPMS-5922', 'spms', 'src/queue/list.tsx', 'src/queue', 3, '2026-09-10', '2026-09-20', 'feat: 队列记录', Date.now())
  store.addLog({ date: '2026-09-21', project: 'spms', requirement: 'SPMS-5922', title: '改了队列逻辑' })

  const computed = store.computeDrift({ today: '2026-09-29' })
  const row = computed.rows.find((r) => r.requirementId === 'SPMS-5922')
  assert.equal(row.verdict, 'doc-stale')
  assert.equal(row.docChangedAt, '2026-08-17')
  assert.equal(row.codeLastAt, '2026-09-20')
  assert.equal(row.sessionLastAt, '2026-09-21')
  assert.equal(row.docVersion, '3')

  const listed = store.listDrift()
  assert.equal(listed[0].requirement_id, 'SPMS-5922')
  assert.equal(listed[0].verdict, 'doc-stale')
  assert.match(listed[0].evidence, /文档版本 v3/)
  // doc-stale 排在最前（面板/工具一眼看到要处理的）
  assert.equal(listed[0].verdict, 'doc-stale')
})

test('store：没有文档链接的需求如实标注，不瞎猜', async () => {
  await store.saveRequirement({ id: 'SPMS-1', project: 'spms', title: '没有文档', readTitle: false })
  const refreshed = await store.refreshDocSnapshots({ id: 'SPMS-1' })
  assert.match(refreshed.snapshots[0].skipped, /没有需求文档链接/)
  const computed = store.computeDrift({ today: '2026-09-29' })
  assert.equal(computed.rows.find((r) => r.requirementId === 'SPMS-1').verdict, 'unknown')
})
