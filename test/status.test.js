/**
 * 需求状态：卡片上直接改（`POST /requirements/status`）+ 开新会话自动置「开发中」。
 *
 * 这条路径要与整条保存区分开：改状态**不能**碰标题、链接、项目 ——
 * 否则「点一下下拉」就等于把整条需求重写一遍，风险完全不同。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import vm from 'node:vm'
import { captureApi, callApi, openStore, useTempHome } from './helpers.js'

const BASE = '/project-hub/api'
const here = dirname(fileURLToPath(import.meta.url))
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

test('setRequirementStatus：改状态但不动标题/链接/项目/标签', async () => {
  await store.saveRequirement({
    id: 'SPMS-1',
    project: 'spms',
    no: '5921',
    title: '房态看板',
    status: 'planning',
    priority: 'P1',
    readTitle: false,
    tags: ['待评审'],
    links: [{ kind: 'ui', url: 'https://figma.example/x', title: 'UI 稿' }],
  })
  // ⚠️ getRequirement 返回的是**原始行**（snake_case），requirementDetail 才是驼峰视图
  const before = store.getRequirement('SPMS-1')
  const res = store.setRequirementStatus('SPMS-1', 'developing')
  assert.equal(res.ok, true)
  assert.equal(res.changed, 1)
  assert.equal(res.requirement.status, 'developing')
  assert.equal(res.requirement.title, '房态看板')
  assert.equal(res.requirement.projectId, 'spms')
  assert.equal(res.requirement.priority, 'P1')
  assert.equal(res.requirement.tags.join('|'), '待评审')
  assert.equal(store.listLinks('SPMS-1').length, 1, '链接不受影响')
  assert.ok(res.requirement.updatedAt >= before.updated_at, 'updated_at 要往前走')
})

test('setRequirementStatus：中文别名可用，未知值/空值/不存在的需求都拒绝', async () => {
  await store.saveRequirement({ id: 'SPMS-1', project: 'spms', title: 'A', readTitle: false })
  assert.equal(store.setRequirementStatus('SPMS-1', '开发中').requirement.status, 'developing')
  assert.equal(store.setRequirementStatus('SPMS-1', '已上线').requirement.status, 'released')
  assert.equal(store.setRequirementStatus('SPMS-1', '测试中').requirement.status, 'testing')

  for (const bad of ['瞎写', '', null, 'doing']) {
    const res = store.setRequirementStatus('SPMS-1', bad)
    assert.equal(res.ok, false, `${JSON.stringify(bad)} 应被拒绝`)
    assert.match(res.error, /未知状态/)
  }
  const missing = store.setRequirementStatus('SPMS-404', 'testing')
  assert.equal(missing.ok, false)
  assert.match(missing.error, /没找到需求/)
  assert.equal(store.getRequirement('SPMS-1').status, 'testing', '被拒绝的调用不该改坏状态')
})

test('API：POST /requirements/status（200 / 400 / 404）', async () => {
  await callApi(api.handler, {
    method: 'POST',
    url: `${BASE}/requirements/save`,
    body: { id: 'SPMS-1', project: 'spms', title: 'A', readTitle: false },
  })
  const okRes = await callApi(api.handler, { method: 'POST', url: `${BASE}/requirements/status`, body: { id: 'SPMS-1', status: 'developing' } })
  assert.equal(okRes.statusCode, 200)
  assert.equal(okRes.json.ok, true)
  assert.equal(okRes.json.requirement.status, 'developing')

  const badStatus = await callApi(api.handler, { method: 'POST', url: `${BASE}/requirements/status`, body: { id: 'SPMS-1', status: '瞎写' } })
  assert.equal(badStatus.statusCode, 400)
  const noStatus = await callApi(api.handler, { method: 'POST', url: `${BASE}/requirements/status`, body: { id: 'SPMS-1' } })
  assert.equal(noStatus.statusCode, 400)
  const notFound = await callApi(api.handler, { method: 'POST', url: `${BASE}/requirements/status`, body: { id: 'SPMS-404', status: 'testing' } })
  assert.equal(notFound.statusCode, 404)

  // 列表里能看到新状态
  const list = await callApi(api.handler, { method: 'GET', url: `${BASE}/requirements` })
  assert.equal(list.json.items[0].status, 'developing')
})

test('客户端：shouldMarkDeveloping —— 已在开发中就不重复写；状态下拉的取值与宿主对齐', () => {
  const code = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { captured = def } }, setInterval: () => 0, clearInterval: () => {} },
    document: { getElementById: () => null, createElement: () => ({ id: '', textContent: '' }), head: { appendChild: () => {} } },
    console,
    URL,
    URLSearchParams,
    Date,
    JSON,
    Math,
    Number,
    String,
    Object,
    Array,
    Error,
    Boolean,
    Promise,
    setTimeout,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'lib/client.js' })
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children } }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
  }
  const { shouldMarkDeveloping, REQ_STATUS_KEYS, STATUS_LABEL } = captured.factory(() => React).__test

  assert.equal(shouldMarkDeveloping('developing'), false, '已在开发中 → 不写')
  assert.equal(shouldMarkDeveloping('planning'), true)
  assert.equal(shouldMarkDeveloping('testing'), true)
  assert.equal(shouldMarkDeveloping(null), true, '没有状态也置一次')
  assert.equal(REQ_STATUS_KEYS.join('|'), 'draft|planning|developing|testing|released|paused|dropped')
  assert.equal(REQ_STATUS_KEYS.includes('developing'), true)
  assert.equal(STATUS_LABEL.developing, '开发中', '「自动改为开发中」就是置这个值')
})
