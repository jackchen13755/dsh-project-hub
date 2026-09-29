/**
 * P4：变更待办（DESIGN.md §9.5）——把「文档可能没跟上」变成一条可执行的待办。
 *
 * 两条硬要求：
 *   ① **默认关闭**（不配置就不产生任何待办，避免变成噪声源）；
 *   ② **幂等 + 闭环**：同一批变更只有一条待办；文档补上（不再判定为漂移）后**自动关闭**。
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
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

/** 造一个「文档停在 8-17 + 9 月有变更语义记录」的需求（= doc-stale），再给一条正常的。 */
async function seedDrift() {
  await store.saveRequirement({ id: 'SPMS-5922', project: 'spms', title: 'Queue 数据记录', readTitle: false })
  await store.saveRequirement({ id: 'SPMS-6001', project: 'spms', title: '正常推进的需求', readTitle: false })
  // 手工塞文档快照（避免联网）
  const snap = store.db.prepare(
    'INSERT OR REPLACE INTO doc_snapshots (requirement_id, url, title, version, hash, excerpt, checks, changed_at, fetched_at, error) VALUES (?,?,?,?,?,?,?,?,?,NULL)',
  )
  snap.run('SPMS-5922', 'https://wiki.example.com/x', 'Queue', '8', 'abc', '摘要', '[]', '2026-08-17T10:00:00.000+08:00', Date.now())
  snap.run('SPMS-6001', 'https://wiki.example.com/y', '正常', '3', 'def', '摘要', '[]', '2026-09-01T10:00:00.000+08:00', Date.now())
  // 5922：文档之后的变更语义 → doc-stale
  store.addLog({ date: '2026-09-21', project: 'spms', requirement: 'SPMS-5922', title: '逻辑改成先扣库存', detail: '产品确认' })
  // 6001：文档之后只有普通开发记录 → work-since-doc（不该产生待办）
  store.addLog({ date: '2026-09-05', project: 'spms', requirement: 'SPMS-6001', title: '写列表页' })
}

test('默认关闭：不产生任何待办，同步也只是短路返回', async () => {
  await seedDrift()
  assert.equal(store.driftTodoEnabled(), false, '默认必须是关的')
  const sync = store.syncDriftTodos()
  assert.equal(sync.enabled, false)
  assert.equal(sync.created, 0)
  assert.equal(store.listDriftTodos().length, 0)

  // 对账重算也不会顺手造待办
  store.computeDrift({ today: '2026-09-29' })
  assert.equal(store.listDriftTodos().length, 0)
})

test('启用后：只给 doc-stale 的需求造待办，并带上变更原话', async () => {
  await seedDrift()
  store.setDriftTodoEnabled(true)
  store.computeDrift({ today: '2026-09-29' })
  const todos = store.listDriftTodos()
  assert.equal(todos.length, 1, '只有 5922 是 doc-stale')
  assert.equal(todos[0].requirement_id, 'SPMS-5922')
  assert.match(todos[0].title, /把 SPMS-5922 的这次变更补进需求文档/)
  assert.match(todos[0].detail, /文档停在 2026-08-17（v8）/)
  assert.match(todos[0].detail, /2026-09-21「逻辑改成先扣库存/, '带上变更原话（记录详情也会一并带上）')
  assert.equal(todos[0].signal_date, '2026-09-21')
  assert.equal(todos[0].status, 'open')
  // 6001（work-since-doc）不许有待办
  assert.ok(!todos.some((t) => t.requirement_id === 'SPMS-6001'))
})

test('没有文档快照的需求：即使记录里有变更语义，也不许造待办', async () => {
  await store.saveRequirement({ id: 'ZZ-1', project: 'spms', title: '没抓过快照', readTitle: false })
  store.addLog({ date: '2026-09-28', project: 'spms', requirement: 'ZZ-1', title: '逻辑改成先扣库存' })
  store.setDriftTodoEnabled(true)
  const computed = store.computeDrift({ today: '2026-09-29' })
  const row = computed.rows.find((r) => r.requirementId === 'ZZ-1')
  assert.equal(row.verdict, 'unknown', '没有文档基准推不出"文档落后"')
  assert.equal(store.listDriftTodos().length, 0, '更不该造出待办')
})

test('幂等：重复同步不会长第二条；新变更会更新同一条', async () => {
  await seedDrift()
  store.setDriftTodoEnabled(true)
  store.computeDrift({ today: '2026-09-29' })
  const first = store.listDriftTodos()[0]
  store.syncDriftTodos()
  store.syncDriftTodos()
  assert.equal(store.listDriftTodos().length, 1, '同一批变更只有一条')
  assert.equal(store.listDriftTodos()[0].id, first.id)

  // 又来一条**新的**变更语义（同一漂移期内）→ 更新它而不是新建
  store.addLog({ date: '2026-09-28', project: 'spms', requirement: 'SPMS-5922', title: '去掉多余校验', detail: '评审结论' })
  const synced = store.syncDriftTodos()
  assert.equal(synced.created, 0, '同一漂移期不该新建第二条')
  assert.equal(synced.updated, 1)
  const open = store.listDriftTodos({ status: 'open' })
  assert.equal(open.length, 1, '一条需求同时只跟进一条')
  assert.equal(open[0].id, first.id)
  assert.match(open[0].detail, /去掉多余校验/, '详情跟着更新到最新变更')
})

test('闭环：文档补上、不再判定为漂移 → 之前的待办自动关闭', async () => {
  await seedDrift()
  store.setDriftTodoEnabled(true)
  store.computeDrift({ today: '2026-09-29' })
  assert.equal(store.listDriftTodos().length, 1)

  // 文档更新到 9-30（晚于最后一条变更记录）→ 不再 doc-stale
  store.db
    .prepare('UPDATE doc_snapshots SET changed_at = ?, version = ? WHERE requirement_id = ?')
    .run('2026-09-30T10:00:00.000+08:00', '9', 'SPMS-5922')
  const synced = store.syncDriftTodos()
  assert.equal(synced.closed, 1, '自动关闭')
  assert.equal(store.listDriftTodos({ status: 'open' }).length, 0)
  const done = store.listDriftTodos({ status: 'done' })[0]
  assert.match(done.close_reason, /文档已更新/)
})

test('硬删需求：不留幽灵数据（待办 / 对账 / 快照 / 代码落点一起清）', async () => {
  await seedDrift()
  store.setDriftTodoEnabled(true)
  store.computeDrift({ today: '2026-09-29' })
  assert.equal(store.listDriftTodos().length, 1)
  store.db.prepare('INSERT OR REPLACE INTO code_touches (requirement_id, project_id, path, module, commits, first_seen, last_seen, sample, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('SPMS-5922', 'spms', 'src/a.ts', 'src', 1, '2026-09-01', '2026-09-01', 'x', Date.now())

  assert.equal(store.deleteRequirement('SPMS-5922'), 1)
  assert.equal(store.listDriftTodos({ status: 'all' }).length, 0, '待办不该留')
  assert.equal(store.listDrift({ limit: 100 }).some((r) => r.requirement_id === 'SPMS-5922'), false, '对账行不该留')
  assert.equal(store.listDocSnapshots({ limit: 100 }).some((r) => r.requirement_id === 'SPMS-5922'), false, '文档快照不该留')
  assert.equal(store.listCodeFiles('SPMS-5922').length, 0, '代码落点不该留')
})

test('手工关闭 + API 开关 + 工具面', async () => {
  await seedDrift()
  store.setDriftTodoEnabled(true)
  store.computeDrift({ today: '2026-09-29' })
  const todo = store.listDriftTodos()[0]

  // API：开关 / 列表 / 关闭
  const listOff = await callApi(api.handler, { method: 'GET', url: '/project-hub/api/drift/todos' })
  assert.equal(listOff.statusCode, 200)
  assert.equal(listOff.json.enabled, true, 'meta 里已开')
  const close = await callApi(api.handler, { method: 'POST', url: '/project-hub/api/drift/todos', body: { done: todo.id } })
  assert.equal(close.statusCode, 200)
  assert.equal(close.json.changed, 1)
  const again = await callApi(api.handler, { method: 'POST', url: '/project-hub/api/drift/todos', body: { done: todo.id } })
  assert.equal(again.statusCode, 404, '重复关闭应为 404')
  const toggle = await callApi(api.handler, { method: 'POST', url: '/project-hub/api/drift/todos', body: { enabled: false } })
  assert.equal(toggle.json.enabled, false)

  // 工具面：默认关闭 → 提示怎么开
  const tool = await byName.get('ph_drift')
  const listed = await tool.execute({ action: 'todos' })
  assert.match(listed.text, /变更待办/)
  assert.match(listed.text, /enable-todos/)
  const enabled = await tool.execute({ action: 'enable-todos' })
  assert.match(enabled.text, /已启用变更待办/)
  const synced = await tool.execute({ action: 'sync-todos' })
  assert.match(synced.text, /同步完成/)
  const disabled = await tool.execute({ action: 'disable-todos' })
  assert.match(disabled.text, /已关闭变更待办/)
})
