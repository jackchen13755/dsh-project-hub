/**
 * 多链接模型（v4）：UI / 需求 / WBS / 设计 都可以多条。
 *
 * 覆盖：链接 CRUD、主链接镜像、单值字段的替换语义、replaceLinks 整类替换、
 * 逐条读标题、删除级联，以及 API 与 ph_link 工具面。
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { buildTools } from '../lib/tools.js'
import { LINK_KINDS, normLinkKind } from '../lib/store.js'
import { captureApi, callApi, openStore, useTempHome, writeFixture } from './helpers.js'

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

const SEVEN = [
  { kind: 'doc', url: 'https://doc.example/5921', title: '需求说明书 v2' },
  { kind: 'doc', url: 'https://doc.example/5921-b', title: '需求补充说明' },
  { kind: 'wbs', url: 'https://wbs.example/5921', note: '两周排期' },
  { kind: 'design', url: 'https://design.example/5921', title: '后端设计 v1' },
  { kind: 'design', url: 'https://design.example/5921-api', title: '接口清单' },
  { kind: 'ui', url: 'https://figma.example/board', title: '看板 UI 稿' },
  { kind: 'ui', url: 'https://mastergo.example/mobile', title: '移动端 UI 稿' },
]

test('链接：kind 归一化（英文 key 与中文标签都认）', () => {
  assert.equal(normLinkKind('doc'), 'doc')
  assert.equal(normLinkKind('需求'), 'doc')
  assert.equal(normLinkKind('需求文档'), 'doc')
  assert.equal(normLinkKind('WBS'), 'wbs')
  assert.equal(normLinkKind('后端设计'), 'design')
  assert.equal(normLinkKind('UI设计'), 'ui')
  assert.equal(normLinkKind('设计稿'), 'ui')
  assert.equal(normLinkKind('figma'), 'ui')
  assert.equal(normLinkKind('莫名'), 'other')
  assert.deepEqual(LINK_KINDS, ['doc', 'wbs', 'design', 'ui', 'other'])
})

test('链接：一次保存 4 类共 7 条，主链接镜像与分类查询都对', async () => {
  const res = await store.saveRequirement({ no: '5921', project: 'spms', title: '房态看板', readTitle: false, links: SEVEN })
  const req = res.requirement
  assert.equal(req.links.length, 7)
  assert.deepEqual(res.linkKinds.sort(), ['design', 'doc', 'ui', 'wbs'])
  assert.equal(store.listLinks('SPMS-5921', { kind: 'doc' }).length, 2)
  assert.equal(store.listLinks('SPMS-5921', { kind: 'ui' }).length, 2)

  // 旧列 = 各类第一条的镜像
  assert.equal(req.docUrl, 'https://doc.example/5921')
  assert.equal(req.docTitle, '需求说明书 v2')
  assert.equal(req.wbsUrl, 'https://wbs.example/5921')
  assert.equal(req.wbsNote, '两周排期')
  assert.equal(req.designUrl, 'https://design.example/5921')
  assert.equal(req.uiUrl, 'https://figma.example/board')
  assert.equal(req.uiNote, null)

  // 列表页也带链接（批量查询）
  const list = store.listRequirements({})
  assert.equal(list.items[0].links.length, 7)
})

test('链接：(kind,url) 唯一 —— 重复添加只更新标题/备注，不新增', async () => {
  await store.saveRequirement({ no: '5921', project: 'spms', readTitle: false, links: [{ kind: 'ui', url: 'https://figma.example/a', title: '旧标题' }] })
  await store.saveRequirement({ no: '5921', project: 'spms', readTitle: false, links: [{ kind: 'ui', url: 'https://figma.example/a', note: '补个备注' }] })
  const links = store.listLinks('SPMS-5921')
  assert.equal(links.length, 1)
  assert.equal(links[0].title, '旧标题', 'COALESCE 语义：没给新标题就保留')
  assert.equal(links[0].note, '补个备注')
})

test('链接：单值字段是「替换主链接」而不是新增', async () => {
  await store.saveRequirement({ no: '5921', project: 'spms', readTitle: false, links: SEVEN })
  const res = await store.saveRequirement({ no: '5921', project: 'spms', docUrl: 'https://doc.example/5921-v3', readTitle: false })
  const docs = res.requirement.links.filter((l) => l.kind === 'doc')
  assert.equal(docs.length, 2, '主链接被替换，第二条文档链接保留')
  assert.equal(res.requirement.docUrl, 'https://doc.example/5921-v3')
  assert.equal(docs.find((l) => l.url === 'https://doc.example/5921-v3').title, null, '换 URL 后标题清空，避免张冠李戴')
})

test('链接：replaceLinks 只替换列出的类别，其它类别原样保留', async () => {
  await store.saveRequirement({ no: '5921', project: 'spms', readTitle: false, links: SEVEN })
  const res = await store.saveRequirement({
    no: '5921',
    project: 'spms',
    readTitle: false,
    replaceLinks: true,
    links: [{ kind: 'wbs', url: 'https://wbs.example/5921-new' }],
  })
  const kinds = (kind) => res.requirement.links.filter((l) => l.kind === kind)
  assert.equal(kinds('wbs').length, 1)
  assert.equal(res.requirement.wbsUrl, 'https://wbs.example/5921-new')
  assert.equal(kinds('doc').length, 2, '没列出的类别不动')
  assert.equal(kinds('ui').length, 2)
})

test('链接：删除单条 / 按类清空 / 需求删除时级联', async () => {
  await store.saveRequirement({ no: '5921', project: 'spms', readTitle: false, links: SEVEN })
  const first = store.listLinks('SPMS-5921', { kind: 'ui' })[0]
  assert.equal(store.removeLink({ id: first.id }), 1)
  assert.equal(store.listLinks('SPMS-5921', { kind: 'ui' }).length, 1)
  assert.equal(store.removeLink({ requirementId: 'SPMS-5921', kind: 'ui', url: 'https://mastergo.example/mobile' }), 1)
  assert.equal(store.listLinks('SPMS-5921', { kind: 'ui' }).length, 0)
  assert.equal(store.requirements?.length ?? 1, 1)

  store.deleteRequirement('SPMS-5921')
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM requirement_links').get().n, 0, '链接跟着需求删掉')
})

test('链接：文档类链接缺标题时会读回（本地 front-matter）', async () => {
  const doc = writeFixture(tmp.dir, 'req-5921.md', '---\ntitle: 房态看板改造需求说明书\n---\n\n# 房态看板改造\n')
  const res = await store.saveRequirement({ no: '5921', project: 'spms', links: [{ kind: 'doc', url: doc }] })
  assert.equal(res.requirement.links[0].title, '房态看板改造需求说明书')
  assert.equal(res.requirement.title, '房态看板改造需求说明书', '标题仍按主文档兜底')
  assert.equal(res.requirement.docTitle, '房态看板改造需求说明书')
})

test('API：/requirements/link/add 与 /remove 走通，/requirements/get 带 links', async () => {
  await callApi(api.handler, {
    method: 'POST',
    url: `${BASE}/requirements/save`,
    body: { no: '5921', project: 'spms', title: '房态看板', readTitle: false, links: [{ kind: 'doc', url: 'https://doc.example/a' }] },
  })
  const added = await callApi(api.handler, {
    method: 'POST',
    url: `${BASE}/requirements/link/add`,
    body: { id: 'SPMS-5921', kind: 'ui', url: 'https://figma.example/board', title: '看板稿' },
  })
  assert.equal(added.statusCode, 200)
  assert.equal(added.json.link.kind, 'ui')
  assert.equal(added.json.link.kindLabel, 'UI 设计')
  assert.equal(added.json.links.length, 2)

  const missing = await callApi(api.handler, { method: 'POST', url: `${BASE}/requirements/link/add`, body: { id: 'SPMS-5921' } })
  assert.equal(missing.statusCode, 400)

  const got = await callApi(api.handler, { method: 'GET', url: `${BASE}/requirements/get?id=SPMS-5921` })
  assert.equal(got.statusCode, 200)
  assert.equal(got.json.requirement.links.length, 2)
  assert.equal(got.json.requirement.uiUrl, 'https://figma.example/board', '主链接镜像同步')

  const linkId = got.json.requirement.links.find((l) => l.kind === 'ui').id
  const removed = await callApi(api.handler, { method: 'POST', url: `${BASE}/requirements/link/remove`, body: { id: 'SPMS-5921', linkId } })
  assert.equal(removed.statusCode, 200)
  assert.equal(removed.json.links.length, 1)
  assert.equal(removed.json.links[0].kind, 'doc')

  const again = await callApi(api.handler, { method: 'POST', url: `${BASE}/requirements/link/remove`, body: { id: 'SPMS-5921', linkId } })
  assert.equal(again.statusCode, 404, '再删一次没了 → 404')
})

test('API：保存时接受 uiUrl（UI 设计主链接）', async () => {
  const saved = await callApi(api.handler, {
    method: 'POST',
    url: `${BASE}/requirements/save`,
    body: { no: '5922', project: 'spms', title: 'UI 链接验证', readTitle: false, uiUrl: 'https://figma.example/x', uiNote: '设计稿' },
  })
  assert.equal(saved.statusCode, 200)
  assert.equal(saved.json.requirement.uiUrl, 'https://figma.example/x')
  assert.equal(saved.json.requirement.links.filter((l) => l.kind === 'ui').length, 1)
})

test('工具：ph_link add / list / remove，且 ph_save_requirement 支持 links 多条', async () => {
  const saved = await byName.get('ph_save_requirement').execute({
    no: '5921',
    project: 'spms',
    title: '房态看板',
    readTitle: false,
    links: [{ kind: 'doc', url: 'https://doc.example/a', title: '需求甲' }],
    uiUrl: 'https://figma.example/a',
  })
  assert.match(saved.text, /需求文档（1 条）/)
  assert.match(saved.text, /UI 设计（1 条）/)
  assert.equal(saved.linkCount, 2)

  const added = await byName.get('ph_link').execute({ action: 'add', id: 'SPMS-5921', kind: 'ui', url: 'https://mastergo.example/b', title: '移动端稿' })
  assert.equal(added.ok, true)
  assert.equal(added.count, 3)
  assert.match(added.text, /UI 设计（2 条）/)

  const listed = await byName.get('ph_link').execute({ action: 'list', id: 'SPMS-5921' })
  assert.equal(listed.count, 3)

  const linkId = store.listLinks('SPMS-5921').find((l) => l.url === 'https://mastergo.example/b').id
  const removed = await byName.get('ph_link').execute({ action: 'remove', id: 'SPMS-5921', linkId })
  assert.equal(removed.ok, true)
  assert.equal(removed.count, 2)

  const missing = await byName.get('ph_link').execute({ action: 'add', id: 'SPMS-9999', url: 'https://x.example/y' })
  assert.equal(missing.ok, false)
})

test('工具：ph_link 的 output 契约（schema required 齐全）', async () => {
  const tool = byName.get('ph_link')
  assert.ok(tool)
  for (const key of tool.output.schema.required) assert.ok(key in (await tool.execute({ action: 'list', id: 'SPMS-404' })) || key === 'text')
  const rendered = tool.output.render({}, { ok: true, count: 2, text: 'x' })
  assert.deepEqual(rendered, [{ type: 'text', text: 'x' }])
})
