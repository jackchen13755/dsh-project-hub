/**
 * lib/api.js —— 宿主 HTTP 契约（DESIGN §6）。
 *
 * 不起 HTTP 服务：用假 ctx 从 `installApi` 里抓出 handler，直接喂 stub req/res
 * （`readBody` 用 `for await`，所以 req 是 async iterable）。
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { asBool, asNum, installApi } from '../lib/api.js'
import { captureApi, callApi, openStore, useTempHome, writeFixture, writeSessionFrames, mangleCwd, evHeader, evUser, at } from './helpers.js'

const BASE = '/project-hub/api'
const u = (path, params = null) => {
  const search = params ? `?${new URLSearchParams(params)}` : ''
  return `${BASE}${path}${search}`
}

let tmp = null
let store = null
let api = null

beforeEach(() => {
  tmp = useTempHome()
  store = openStore()
  api = captureApi(store, { version: '0.1.0-test', scanIntervalMinutes: 45 })
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

test('api: installApi 注册到 webServer（拿不到服务也只返回 installed:false 不抛）', () => {
  assert.equal(api.installed.installed, true)
  assert.equal(api.installed.error, undefined)
  assert.equal(typeof api.installed.disposer, 'function')
  assert.equal(api.spec.kind, 'prefix')
  assert.equal(api.spec.path, BASE)
  assert.equal(typeof api.spec.handler, 'function')

  const out = installApi(
    {
      inject() {
        throw new Error('no webServer')
      },
    },
    { store },
  )
  assert.equal(out.installed, false)
  assert.match(out.error, /no webServer/)

  // 自定义 apiBase
  const custom = captureApi(store, { config: { apiBase: '/ph/api' } })
  assert.equal(custom.spec.path, '/ph/api')
})

test('api: GET /status 与 / 别名', async () => {
  const res = await callApi(api.handler, { url: u('/status') })
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /application\/json/)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.json.ok, true)
  assert.equal(res.json.version, '0.1.0-test')
  assert.equal(res.json.scanIntervalMinutes, 45)
  assert.equal(res.json.dbPath, join(tmp.home, 'project-hub', 'hub.db'))
  assert.equal(res.json.counts.projects, 0)
  assert.equal(res.json.lastScanAt, null)

  const root = await callApi(api.handler, { url: BASE })
  assert.equal(root.statusCode, 200)
  assert.equal(root.json.ok, true)
  const slash = await callApi(api.handler, { url: `${BASE}/` })
  assert.equal(slash.statusCode, 200)

  // 不带前缀也能命中（防御性：路由表本身在 base 之下）
  const bare = await callApi(api.handler, { url: '/status' })
  assert.equal(bare.statusCode, 200)
})

test('api: POST /requirements/save 保存需求 + 回读文档标题', async () => {
  const doc = writeFixture(tmp.dir, 'req.md', '---\ntitle: 需求甲：分页越界修复\n---\n')
  const res = await callApi(api.handler, {
    method: 'POST',
    url: u('/requirements/save'),
    body: { project: 'spms', no: '5921', docUrl: doc, priority: 'P0', tags: ['分页'] },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.created, true)
  assert.equal(res.json.requirement.id, 'SPMS-5921')
  assert.equal(res.json.requirement.docTitle, '需求甲：分页越界修复')
  assert.equal(res.json.requirement.priority, 'P0')
  assert.deepEqual(res.json.requirement.tags, ['分页'])
  assert.equal(res.json.titleRead.ok, true)
  assert.equal(res.json.titleRead.source, 'markdown-frontmatter')

  // 缺 id/no → 400（store 抛的错被翻成 400）
  const bad = await callApi(api.handler, { method: 'POST', url: u('/requirements/save'), body: { project: 'spms' } })
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json.ok, false)
  assert.match(bad.json.error, /缺少需求 ID/)
})

test('api: GET /requirements 的 archived 三态过滤 + 分页参数', async () => {
  await callApi(api.handler, { method: 'POST', url: u('/requirements/save'), body: { project: 'spms', no: '5921', title: '甲' } })
  await callApi(api.handler, { method: 'POST', url: u('/requirements/save'), body: { project: 'spms', no: '5922', title: '乙' } })
  const archived = await callApi(api.handler, { method: 'POST', url: u('/requirements/archive'), body: { id: 'SPMS-5921' } })
  assert.equal(archived.statusCode, 200)
  assert.equal(archived.json.changed, 1)

  const excluded = await callApi(api.handler, { url: u('/requirements') })
  assert.equal(excluded.statusCode, 200)
  assert.equal(excluded.json.ok, true)
  assert.equal(excluded.json.total, 1)
  assert.deepEqual(excluded.json.items.map((r) => r.id), ['SPMS-5922'])
  assert.equal(excluded.json.items[0].projectName, 'spms')
  assert.equal(excluded.json.items[0].workCount, 0)

  const only = await callApi(api.handler, { url: u('/requirements', { archived: 'only' }) })
  assert.equal(only.json.total, 1)
  assert.equal(only.json.items[0].id, 'SPMS-5921')
  assert.ok(only.json.items[0].archivedAt > 0)

  const include = await callApi(api.handler, { url: u('/requirements', { archived: 'include' }) })
  assert.equal(include.json.total, 2)

  const limited = await callApi(api.handler, { url: u('/requirements', { archived: 'include', limit: '1', offset: '1' }) })
  assert.equal(limited.json.total, 2)
  assert.equal(limited.json.items.length, 1)

  const filtered = await callApi(api.handler, { url: u('/requirements', { project: 'spms', q: '甲', archived: 'include' }) })
  assert.equal(filtered.json.total, 1)
  assert.equal(filtered.json.items[0].id, 'SPMS-5921')

  // 归档一个不存在的 → 404
  const missing = await callApi(api.handler, { method: 'POST', url: u('/requirements/archive'), body: { id: 'SPMS-0000' } })
  assert.equal(missing.statusCode, 404)
  assert.equal(missing.json.ok, false)

  // 删除
  const deleted = await callApi(api.handler, { method: 'POST', url: u('/requirements/delete'), body: { id: 'SPMS-5922' } })
  assert.equal(deleted.statusCode, 200)
  assert.equal(deleted.json.deleted, 1)
  const again = await callApi(api.handler, { method: 'POST', url: u('/requirements/delete'), body: { id: 'SPMS-5922' } })
  assert.equal(again.statusCode, 404)
})

test('api: GET /requirements/get 200 / 400 / 404', async () => {
  await callApi(api.handler, { method: 'POST', url: u('/requirements/save'), body: { project: 'spms', no: '5921', title: '分页越界修复' } })
  await callApi(api.handler, { method: 'POST', url: u('/logs/add'), body: { project: 'spms', requirement: 'SPMS-5921', kind: 'bug', title: '修了一版', date: '2026-03-05' } })

  const ok = await callApi(api.handler, { url: u('/requirements/get', { id: 'SPMS-5921' }) })
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.json.requirement.id, 'SPMS-5921')
  assert.equal(ok.json.requirement.title, '分页越界修复')
  assert.equal(ok.json.logs.length, 1)
  assert.equal(ok.json.logs[0].kind, 'bug')
  assert.deepEqual(ok.json.days, [], '没有扫描活动时按天视图为空')

  const noId = await callApi(api.handler, { url: u('/requirements/get') })
  assert.equal(noId.statusCode, 400)
  assert.match(noId.json.error, /缺少 id/)
  const emptyId = await callApi(api.handler, { url: u('/requirements/get', { id: '' }) })
  assert.equal(emptyId.statusCode, 400)

  const notFound = await callApi(api.handler, { url: u('/requirements/get', { id: 'SPMS-0000' }) })
  assert.equal(notFound.statusCode, 404)
  assert.match(notFound.json.error, /没有找到需求/)
})

test('api: POST /logs/add（缺 title 400、project 缺省走 sessionId→cwd）', async () => {
  const cwd = tmp.projectCwd('spms')
  const sessionApi = captureApi(store, {
    getSessionCwd: (sessionId) => (sessionId === 'sess-1' ? cwd : null),
  })

  const res = await callApi(sessionApi.handler, {
    method: 'POST',
    url: u('/logs/add', { sessionId: 'sess-1' }),
    body: { title: '修复分页越界', kind: 'bug', date: '2026-03-05', minutes: 30 },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.log.title, '修复分页越界')
  assert.equal(res.json.log.kind, 'bug')
  assert.equal(res.json.log.source, 'manual')
  assert.equal(res.json.log.minutes, 30)
  assert.equal(res.json.log.projectId, 'spms', 'project 缺省时用 sessionId 换来的 cwd')
  assert.equal(res.json.log.projectName, 'spms')

  const noTitle = await callApi(sessionApi.handler, { method: 'POST', url: u('/logs/add'), body: { project: 'spms' } })
  assert.equal(noTitle.statusCode, 400)
  assert.match(noTitle.json.error, /缺少 title/)

  // 列表 + 归档 + 删除
  const listed = await callApi(sessionApi.handler, { url: u('/logs', { project: 'spms', kind: 'bug' }) })
  assert.equal(listed.json.total, 1)
  assert.equal(listed.json.items[0].sessionId, null)

  const logId = res.json.log.id
  const archived = await callApi(sessionApi.handler, { method: 'POST', url: u('/logs/archive'), body: { id: logId } })
  assert.equal(archived.statusCode, 200)
  assert.equal(archived.json.changed, 1)
  const excluded = await callApi(sessionApi.handler, { url: u('/logs') })
  assert.equal(excluded.json.total, 0)
  const only = await callApi(sessionApi.handler, { url: u('/logs', { archived: 'only' }) })
  assert.equal(only.json.total, 1)
  const restored = await callApi(sessionApi.handler, { method: 'POST', url: u('/logs/archive'), body: { id: logId, archived: false } })
  assert.equal(restored.json.log.archivedAt, null)
  const deleted = await callApi(sessionApi.handler, { method: 'POST', url: u('/logs/delete'), body: { id: logId } })
  assert.equal(deleted.statusCode, 200)
  const gone = await callApi(sessionApi.handler, { method: 'POST', url: u('/logs/delete'), body: { id: logId } })
  assert.equal(gone.statusCode, 404)
})

test('api: GET /search 与 /report', async () => {
  await callApi(api.handler, { method: 'POST', url: u('/requirements/save'), body: { project: 'spms', no: '5921', title: '分页越界修复' } })
  await callApi(api.handler, { method: 'POST', url: u('/logs/add'), body: { project: 'spms', requirement: 'SPMS-5921', kind: 'bug', title: '手工：修复分页越界', date: '2026-03-05' } })

  const search = await callApi(api.handler, { url: u('/search', { q: '分页' }) })
  assert.equal(search.statusCode, 200)
  assert.equal(search.json.ok, true)
  assert.equal(search.json.requirementTotal, 1)
  assert.equal(search.json.logTotal, 1)
  assert.deepEqual(search.json.requirements.map((r) => r.id), ['SPMS-5921'])
  assert.equal(search.json.logs[0].title, '手工：修复分页越界')
  assert.ok(Array.isArray(search.json.days))

  const empty = await callApi(api.handler, { url: u('/search', { q: '不存在的词' }) })
  assert.equal(empty.json.requirementTotal, 0)
  assert.equal(empty.json.logTotal, 0)

  const report = await callApi(api.handler, { url: u('/report') })
  assert.equal(report.statusCode, 200)
  assert.deepEqual(report.json.days.map((d) => d.date), ['2026-03-05'])
  assert.equal(report.json.totals.logCount, 1)
  assert.equal(report.json.totals.requirementCount, 0)

  const ranged = await callApi(api.handler, { url: u('/report', { from: '2026-04-01' }) })
  assert.deepEqual(ranged.json.days, [])
})

test('api: POST /scan 参数透传 + 响应裁剪（注入 scan runner）', async () => {
  const calls = []
  const injected = captureApi(store, {
    scan: async (opts) => {
      calls.push(opts)
      return {
        files: 3,
        changed: 2,
        skipped: 1,
        activities: 4,
        logs: 2,
        days: ['2026-03-01'],
        errors: [{ file: 'a', error: '坏帧' }],
        sessions: Array.from({ length: 60 }, (_, i) => ({ sessionId: `s${i}` })),
      }
    },
  })

  const res = await callApi(injected.handler, {
    method: 'POST',
    url: u('/scan'),
    body: { dryRun: 'true', since: '2026-03-01', limit: '7' },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(calls, [{ dryRun: true, since: '2026-03-01', limit: 7 }])
  assert.equal(res.json.ok, true)
  assert.equal(res.json.files, 3)
  assert.equal(res.json.changed, 2)
  assert.equal(res.json.skipped, 1)
  assert.equal(res.json.activities, 4)
  assert.equal(res.json.logs, 2)
  assert.deepEqual(res.json.days, ['2026-03-01'])
  assert.equal(res.json.errors, 1, 'errors 折成条数')
  assert.equal(res.json.errorDetails.length, 1)
  assert.equal(res.json.sessions.length, 50, 'sessions 最多回 50 条')

  // 空 body → 全默认
  const defaults = await callApi(injected.handler, { method: 'POST', url: u('/scan') })
  assert.deepEqual(calls[1], { dryRun: false, since: null, limit: 300 })
  assert.equal(defaults.json.ok, true)

  // 缺字段的 runner 结果不该炸
  const bare = captureApi(store, { scan: async () => ({ files: 0, changed: 0, skipped: 0, activities: 0, logs: 0, days: [] }) })
  const bareRes = await callApi(bare.handler, { method: 'POST', url: u('/scan') })
  assert.equal(bareRes.statusCode, 200)
  assert.equal(bareRes.json.errors, 0)
  assert.deepEqual(bareRes.json.sessions, [])
})

test('api: POST /scan 走真实 store.scanSessions（合成会话 → 4 条记录）', async () => {
  const cwd = tmp.projectCwd('spms')
  writeSessionFrames(tmp.sessionsRoot, {
    sessionId: 'sess-api-1',
    mangled: mangleCwd(cwd),
    frames: [
      [evHeader({ id: 'sess-api-1', cwd, createdAt: at('2026-03-01T02:00:00Z') }), evUser('【5921】和 bug55036 一起修', at('2026-03-01T02:00:00Z'))],
      [evUser('需求 22 继续', at('2026-03-02T02:00:00Z')), evUser('整理文档', at('2026-03-03T02:00:00Z'))],
    ],
  })

  const res = await callApi(api.handler, { method: 'POST', url: u('/scan'), body: { limit: 10 } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.files, 1)
  assert.equal(res.json.changed, 1)
  assert.equal(res.json.logs, 4)
  assert.equal(res.json.activities, 6)
  assert.deepEqual(res.json.days, ['2026-03-01', '2026-03-02', '2026-03-03'])
  assert.equal(res.json.sessions.length, 1)
  assert.equal(res.json.sessions[0].sessionId, 'sess-api-1')
  assert.equal(res.json.sessions[0].projectId, 'spms')

  // 第二次全是跳过
  const second = await callApi(api.handler, { method: 'POST', url: u('/scan') })
  assert.equal(second.json.changed, 0)
  assert.equal(second.json.skipped, 1)

  // dryRun 不写库
  store.purgeScanData()
  const dry = await callApi(api.handler, { method: 'POST', url: u('/scan'), body: { dryRun: true } })
  assert.equal(dry.json.changed, 1)
  assert.equal(store.counts().workLogs, 0)
})

test('api: 未知路由 404 / 方法不匹配 404 / 坏 JSON 500', async () => {
  const unknown = await callApi(api.handler, { url: u('/nope') })
  assert.equal(unknown.statusCode, 404)
  assert.equal(unknown.json.ok, false)
  assert.match(unknown.json.error, /未知路由 GET \/nope/)

  const wrongMethod = await callApi(api.handler, { method: 'POST', url: u('/status'), body: {} })
  assert.equal(wrongMethod.statusCode, 404)
  assert.match(wrongMethod.json.error, /未知路由 POST \/status/)

  const badJson = await callApi(api.handler, { method: 'POST', url: u('/logs/add'), rawBody: '{不是 JSON' })
  assert.equal(badJson.statusCode, 400, '客户端传坏 body 是 4xx，不该报 500')
  assert.equal(badJson.json.ok, false)
  assert.match(badJson.json.error, /请求体不是合法 JSON/)
})

test('api: /projects、/projects/add、/doc-title、/export', async () => {
  const empty = await callApi(api.handler, { url: u('/projects') })
  assert.equal(empty.statusCode, 200)
  assert.deepEqual(empty.json.projects, [])
  assert.ok(Array.isArray(empty.json.candidates))
  const alias = await callApi(api.handler, { url: u('/candidates') })
  assert.equal(alias.statusCode, 200)

  const added = await callApi(api.handler, { method: 'POST', url: u('/projects/add'), body: { name: 'SPMS', root: '/x/spms', aliases: ['spms-web'] } })
  assert.equal(added.statusCode, 200)
  assert.equal(added.json.project.id, 'spms')
  assert.equal(added.json.project.name, 'SPMS')
  assert.deepEqual(added.json.project.aliases, ['spms-web'])

  const noName = await callApi(api.handler, { method: 'POST', url: u('/projects/add'), body: {} })
  assert.equal(noName.statusCode, 400)
  assert.match(noName.json.error, /缺少项目 name/)

  const archived = await callApi(api.handler, { method: 'POST', url: u('/projects/archive'), body: { id: 'spms' } })
  assert.equal(archived.statusCode, 200)
  assert.equal(archived.json.changed, 1)
  const missing = await callApi(api.handler, { method: 'POST', url: u('/projects/archive'), body: { id: 'nope' } })
  assert.equal(missing.statusCode, 404)

  const doc = writeFixture(tmp.dir, 'doc.md', '# 后端设计：分页\n')
  const title = await callApi(api.handler, { method: 'POST', url: u('/doc-title'), body: { path: doc } })
  assert.equal(title.statusCode, 200)
  assert.equal(title.json.ok, true)
  assert.equal(title.json.title, '后端设计：分页')
  assert.equal(title.json.source, 'markdown-h1')
  const noRef = await callApi(api.handler, { method: 'POST', url: u('/doc-title'), body: {} })
  assert.equal(noRef.statusCode, 400)
  assert.match(noRef.json.error, /缺少 url \/ path/)

  await callApi(api.handler, { method: 'POST', url: u('/requirements/save'), body: { project: 'spms', no: '5921', title: '甲' } })
  const exported = await callApi(api.handler, { url: u('/export') })
  assert.equal(exported.statusCode, 200)
  assert.equal(exported.json.ok, true)
  assert.equal(typeof exported.json.exportedAt, 'string')
  assert.equal(exported.json.counts.requirements, 1)
  assert.equal(exported.json.requirements.length, 1)
  assert.deepEqual(exported.json.logs, [])
})

test('api: asBool / asNum 的宽松解析', () => {
  assert.equal(asBool(true), true)
  assert.equal(asBool('true'), true)
  assert.equal(asBool('1'), true)
  assert.equal(asBool('false'), false)
  assert.equal(asBool(undefined), false)
  assert.equal(asNum('7', 300), 7)
  assert.equal(asNum('', 300), 300)
  assert.equal(asNum(null, 300), 300)
  assert.equal(asNum(undefined, 50), 50)
  assert.equal(asNum('0', 50), 0)
})
