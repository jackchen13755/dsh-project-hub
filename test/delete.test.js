/**
 * 彻底删除（归档视图里的「删除」）：store → API → 工具面 三条路径。
 *
 * 设计约定：**归档是软删（可恢复），删除是硬删（不可恢复）**；需求删除要连带它的链接，
 * 项目不支持硬删（避免一条台账线被误删）。这些断言是「删除按钮」背后的真实行为。
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { buildTools } from '../lib/tools.js'
import { captureApi, callApi, openStore, useTempHome } from './helpers.js'

const BASE = '/project-hub/api'
let tmp = null
let store = null
let api = null
let byName = null

beforeEach(() => {
  tmp = useTempHome()
  store = openStore()
  api = captureApi(store, { version: '0.1.0-test', scanIntervalMinutes: 45 })
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

test('store：删需求会连带删掉它的全部链接', async () => {
  await store.saveRequirement({
    no: '5921',
    project: 'spms',
    title: '房态看板',
    readTitle: false,
    links: [
      { kind: 'doc', url: 'https://doc.example/a' },
      { kind: 'ui', url: 'https://figma.example/a' },
    ],
  })
  assert.equal(store.listLinks('SPMS-5921').length, 2)
  assert.equal(store.deleteRequirement('SPMS-5921'), 1)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM requirement_links').get().n, 0)
  assert.equal(store.deleteRequirement('SPMS-5921'), 0, '再删一次没有可删的行')
})

test('store：删记录只影响那一条', () => {
  const a = store.addLog({ date: '2026-03-01', project: 'spms', title: 'A' })
  const b = store.addLog({ date: '2026-03-01', project: 'spms', title: 'B' })
  assert.equal(store.deleteLog(a.id), 1)
  assert.equal(store.listLogs({}).total, 1)
  assert.equal(store.getLog(a.id), null)
  assert.equal(store.getLog(b.id).title, 'B')
  assert.equal(store.deleteLog(999999), 0)
})

test('API：/requirements/delete 与 /logs/delete（200 / 404）', async () => {
  await callApi(api.handler, {
    method: 'POST',
    url: `${BASE}/requirements/save`,
    body: { no: '7001', project: 'spms', title: '临时', readTitle: false },
  })
  const delReq = await callApi(api.handler, { method: 'POST', url: `${BASE}/requirements/delete`, body: { id: 'SPMS-7001' } })
  assert.equal(delReq.statusCode, 200)
  assert.equal(delReq.json.deleted, 1)
  const again = await callApi(api.handler, { method: 'POST', url: `${BASE}/requirements/delete`, body: { id: 'SPMS-7001' } })
  assert.equal(again.statusCode, 404)

  const added = await callApi(api.handler, { method: 'POST', url: `${BASE}/logs/add`, body: { date: '2026-03-02', project: 'spms', title: '临时记录' } })
  const delLog = await callApi(api.handler, { method: 'POST', url: `${BASE}/logs/delete`, body: { id: added.json.log.id } })
  assert.equal(delLog.statusCode, 200)
  assert.equal(delLog.json.deleted, 1)
  const gone = await callApi(api.handler, { method: 'POST', url: `${BASE}/logs/delete`, body: { id: added.json.log.id } })
  assert.equal(gone.statusCode, 404)
})

test('工具：ph_archive hard:true 彻底删除需求（连同链接）', async () => {
  await callApi(api.handler, {
    method: 'POST',
    url: `${BASE}/requirements/save`,
    body: { no: '7002', project: 'spms', title: '待删除', readTitle: false, links: [{ kind: 'ui', url: 'https://figma.example/x' }] },
  })
  const res = await byName.get('ph_archive').execute({ target: 'requirement', id: 'SPMS-7002', hard: true })
  assert.equal(res.deleted, true)
  assert.equal(res.changed, 1)
  assert.match(res.text, /已彻底删除需求 SPMS-7002/)
  assert.match(res.text, /不可恢复/)
  assert.equal(store.getRequirement('SPMS-7002'), null)
  assert.equal(store.listLinks('SPMS-7002').length, 0)

  const missing = await byName.get('ph_archive').execute({ target: 'requirement', id: 'SPMS-7002', hard: true })
  assert.equal(missing.deleted, false)
  assert.match(missing.text, /没找到需求/)
})

test('工具：ph_archive hard:true 删记录；项目拒绝硬删', async () => {
  const log = store.addLog({ date: '2026-03-03', project: 'spms', title: '临时' })
  const res = await byName.get('ph_archive').execute({ target: 'log', id: log.id, hard: true })
  assert.equal(res.deleted, true)
  assert.equal(store.getLog(log.id), null)

  const project = await byName.get('ph_archive').execute({ target: 'project', id: 'spms', hard: true })
  assert.equal(project.deleted, false)
  assert.match(project.text, /项目不支持彻底删除/)
  assert.equal(store.listProjects({ archived: 'include' }).length, 1, '项目还在')
})

test('工具：不传 hard 时仍是软删（归档 / 恢复）', async () => {
  await callApi(api.handler, { method: 'POST', url: `${BASE}/requirements/save`, body: { no: '7003', project: 'spms', title: '归档', readTitle: false } })
  const archived = await byName.get('ph_archive').execute({ target: 'requirement', id: 'SPMS-7003' })
  assert.equal(archived.deleted, false)
  assert.match(archived.text, /已归档需求 SPMS-7003/)
  assert.equal(store.listRequirements({}).total, 0)
  assert.equal(store.getRequirement('SPMS-7003') !== null, true, '归档只是软删，行还在')

  const restored = await byName.get('ph_archive').execute({ target: 'requirement', id: 'SPMS-7003', archived: false })
  assert.match(restored.text, /已恢复需求 SPMS-7003/)
  assert.equal(store.listRequirements({}).total, 1)
})
