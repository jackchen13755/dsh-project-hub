/**
 * 编辑能力：需求可编辑（含链接整体替换）、开发记录可编辑（含扫描派生的记录）。
 *
 * 覆盖 store / API / 工具面三条路径，并钉住两条容易退化的语义：
 *   ① 编辑需求不会新建第二条（id 主键 + `replaceLinks` 整份替换）；
 *   ② 编辑过的扫描记录**不会被下次增量扫描覆盖**（部分唯一索引 + INSERT OR IGNORE）。
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { buildTools } from '../lib/tools.js'
import { captureApi, callApi, evHeader, evUser, openStore, useTempHome, writeSessionFrames, mangleCwd } from './helpers.js'

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

test('编辑需求：改标题/状态/链接，仍是一条记录（不新增）', async () => {
  const created = await store.saveRequirement({
    no: '5921',
    project: 'spms',
    title: '旧标题',
    readTitle: false,
    links: [
      { kind: 'doc', url: 'https://doc.example/a', title: '需求甲' },
      { kind: 'ui', url: 'https://figma.example/a', title: '旧 UI 稿' },
    ],
  })
  assert.equal(created.requirement.links.length, 2)

  const edited = await store.saveRequirement({
    id: 'SPMS-5921',
    project: 'spms',
    title: '新标题',
    status: 'testing',
    readTitle: false,
    replaceLinks: true,
    links: [
      { kind: 'doc', url: 'https://doc.example/a', title: '需求甲 v2' },
      { kind: 'ui', url: 'https://figma.example/b', title: '新 UI 稿' },
      { kind: 'design', url: 'https://design.example/a', title: '后端设计' },
    ],
  })
  assert.equal(edited.created, false, '必须是更新而不是新建')
  assert.equal(store.listRequirements({ archived: 'include' }).total, 1)
  assert.equal(edited.requirement.title, '新标题')
  assert.equal(edited.requirement.status, 'testing')
  assert.equal(edited.requirement.links.length, 3)
  assert.equal(edited.requirement.uiUrl, 'https://figma.example/b', '主链接镜像跟着换')
  assert.equal(edited.requirement.links.find((l) => l.kind === 'doc').title, '需求甲 v2')
})

test('编辑记录：store.updateLog 只改传了的字段', () => {
  const log = store.addLog({ date: '2026-03-01', project: 'spms', requirement: '5921', kind: 'bug', title: '旧标题', detail: '旧详情', minutes: 30 })
  const edited = store.updateLog(log.id, { title: '新标题', kind: 'review' })
  assert.equal(edited.id, log.id)
  assert.equal(edited.title, '新标题')
  assert.equal(edited.kind, 'review')
  assert.equal(edited.detail, '旧详情', '没传的字段保持原样')
  assert.equal(edited.minutes, 30)
  assert.equal(edited.date, '2026-03-01')

  const cleared = store.updateLog(log.id, { detail: '', minutes: null })
  assert.equal(cleared.detail, null, '空字符串 = 清空详情')
  assert.equal(cleared.minutes, null, 'null = 清空耗时')

  assert.equal(store.updateLog(99999, { title: 'x' }), null, '不存在的 id 返回 null')
})

test('编辑记录：改日期/项目/需求号会同步到对应需求', () => {
  const log = store.addLog({ date: '2026-03-01', project: 'spms', kind: 'dev', title: 't' })
  const moved = store.updateLog(log.id, { date: '2026-03-08', project: 'hs_config', requirement: '8779' })
  assert.equal(moved.date, '2026-03-08')
  assert.equal(moved.projectId, 'hs-config')
  assert.equal(moved.requirementId, 'HS-CONFIG-8779', '需求号跟着项目前缀拼')
  assert.equal(store.listLogs({ project: 'hs_config' }).total, 1)
  assert.equal(store.listLogs({ project: 'spms' }).total, 0)
})

test('编辑记录：扫描派生的记录也能改，且重扫不会把它改回去', async () => {
  const cwd = tmp.projectCwd('spms')
  writeSessionFrames(tmp.sessionsRoot, {
    sessionId: 'sess-edit',
    mangled: mangleCwd(cwd),
    frames: [[evHeader({ id: 'sess-edit', cwd, createdAt: Date.parse('2026-03-02T10:00:00+08:00') }), evUser('开搞【5921】', Date.parse('2026-03-02T10:01:00+08:00'))]],
  })
  const first = await store.scanSessions()
  assert.equal(first.logs, 1)
  const scanned = store.listLogs({ source: 'session-scan' }).items[0]
  assert.equal(scanned.source, 'session-scan')

  const edited = store.updateLog(scanned.id, { title: '我手动改过的标题', kind: 'review' })
  assert.equal(edited.title, '我手动改过的标题')
  assert.equal(edited.source, 'session-scan', '来源不变（仍标记为扫描派生）')

  // 清水位（模拟迁移重放）再扫一次：INSERT OR IGNORE 撞部分唯一索引 → 不会新增、也不会覆盖
  store.db.prepare('DELETE FROM scanned_sessions').run()
  const again = await store.scanSessions()
  assert.equal(again.changed, 1)
  assert.equal(again.logs, 0, '不新增记录')
  const after = store.getLog(scanned.id)
  assert.equal(after.title, '我手动改过的标题', '手动编辑的内容不被重扫覆盖')
  assert.equal(after.kind, 'review')
})

test('API：/logs/update 走通（含 400 / 404）', async () => {
  const added = await callApi(api.handler, { method: 'POST', url: `${BASE}/logs/add`, body: { date: '2026-03-03', project: 'spms', kind: 'bug', title: '旧' } })
  assert.equal(added.statusCode, 200)

  const edited = await callApi(api.handler, { method: 'POST', url: `${BASE}/logs/update`, body: { id: added.json.log.id, title: '新', minutes: 45 } })
  assert.equal(edited.statusCode, 200)
  assert.equal(edited.json.log.title, '新')
  assert.equal(edited.json.log.minutes, 45)
  assert.equal(edited.json.log.kind, 'bug', '没传的字段不动')

  const missing = await callApi(api.handler, { method: 'POST', url: `${BASE}/logs/update`, body: { title: 'x' } })
  assert.equal(missing.statusCode, 400)
  const gone = await callApi(api.handler, { method: 'POST', url: `${BASE}/logs/update`, body: { id: 999999, title: 'x' } })
  assert.equal(gone.statusCode, 404)
})

test('工具：ph_log_work 传 id 即编辑，不传即新增', async () => {
  const created = await byName.get('ph_log_work').execute({ title: '写个记录', project: 'spms', kind: 'dev' })
  assert.equal(created.created, true)

  const edited = await byName.get('ph_log_work').execute({ id: created.id, title: '改过的记录', kind: 'doc' })
  assert.equal(edited.created, false)
  assert.match(edited.text, /已更新 #/)
  assert.equal(store.getLog(created.id).title, '改过的记录')
  assert.equal(store.getLog(created.id).kind, 'doc')

  const missing = await byName.get('ph_log_work').execute({ id: 999999, title: 'x' })
  assert.match(missing.text, /没找到记录/)
  const noTitle = await byName.get('ph_log_work').execute({ project: 'spms' })
  assert.match(noTitle.text, /需要 title/)
})

test('工具：编辑需求 —— ph_save_requirement 传已有 id + replaceLinks', async () => {
  await byName.get('ph_save_requirement').execute({ no: '6001', project: 'spms', title: '初版', readTitle: false, uiUrl: 'https://figma.example/old' })
  const edited = await byName.get('ph_save_requirement').execute({
    id: 'SPMS-6001',
    project: 'spms',
    title: '改版',
    status: 'testing',
    readTitle: false,
    replaceLinks: true,
    links: [{ kind: 'ui', url: 'https://figma.example/new', title: '新版 UI 稿' }],
  })
  assert.equal(edited.created, false)
  assert.match(edited.text, /已更新需求 SPMS-6001 · 改版/)
  assert.equal(edited.linkCount, 1, 'replaceLinks 把旧 UI 链接换掉了')
  assert.equal(store.getRequirement('SPMS-6001').ui_url, 'https://figma.example/new')
})
