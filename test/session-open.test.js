/**
 * 「开新会话」链路：
 *   宿主侧 —— `/brief`（需求简报）与 `/open-session`（简报 + 登记 workspace，会话由客户端建）；
 *   客户端 —— 能力探测式建会话/投喂消息的纯函数（createSessionIn / sendIntoSession / scopeFor…）。
 *
 * 之所以把这条链路钉死：本机实测（dsh-zentao-workbench 同款）新建会话只能走
 * `sessions.create({ workspaceId })`，而「在任意项目目录里开会话」必须先由宿主把目录
 * 登记成 workspace —— 任何一环缺失都会表现成「按钮点了没反应」，所以每一环都要有断言。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import vm from 'node:vm'
import { buildTools } from '../lib/tools.js'
import { buildRequirementBrief } from '../lib/brief.js'
import { captureApi, callApi, openStore, useTempHome } from './helpers.js'

const BASE = '/project-hub/api'
const here = dirname(fileURLToPath(import.meta.url))
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

async function seedRequirement() {
  return store.saveRequirement({
    no: '5921',
    project: tmp.projectCwd('spms'),
    title: '房态看板改造',
    status: 'developing',
    readTitle: false,
    links: [
      { kind: 'doc', url: 'https://doc.example/5921', title: '需求说明书 v2' },
      { kind: 'wbs', url: 'https://wbs.example/5921', note: '两周排期' },
      { kind: 'design', url: 'https://design.example/5921', title: '后端设计 v1' },
      { kind: 'ui', url: 'https://figma.example/board', title: '看板 UI 稿' },
      { kind: 'ui', url: 'https://mastergo.example/mobile', title: '移动端 UI 稿' },
    ],
  })
}

test('简报：按类列全部链接 + 最近记录 + 任务提示', async () => {
  await seedRequirement()
  store.addLog({ date: '2026-09-29', project: 'spms', requirement: '5921', kind: 'dev', title: '列表页骨架' })
  const result = buildRequirementBrief(store, 'SPMS-5921')
  assert.equal(result.ok, true)
  assert.match(result.brief, /^# 需求 SPMS-5921：房态看板改造/m)
  assert.match(result.brief, /## 资料链接/)
  assert.match(result.brief, /### 需求文档（1 条）/)
  assert.match(result.brief, /### UI 设计（2 条）/)
  assert.match(result.brief, /https:\/\/figma\.example\/board　《看板 UI 稿》/)
  assert.match(result.brief, /## 最近的开发记录/)
  assert.match(result.brief, /列表页骨架/)
  assert.match(result.brief, /## 请做的第一件事/)
  assert.equal(result.links.length, 5)
  assert.ok(result.project.root.endsWith('spms'), '简报要带上项目工作目录')

  const missing = buildRequirementBrief(store, 'SPMS-9999')
  assert.equal(missing.ok, false)
  assert.equal(missing.brief, '')
})

test('工具：ph_brief 返回简报，找不到需求时 ok=false', async () => {
  await seedRequirement()
  const ok = await byName.get('ph_brief').execute({ id: 'SPMS-5921' })
  assert.equal(ok.ok, true)
  assert.match(ok.text, /资料链接/)
  const custom = await byName.get('ph_brief').execute({ id: 'SPMS-5921', task: '只做 UI 走查' })
  assert.match(custom.text, /只做 UI 走查/)
  const nope = await byName.get('ph_brief').execute({ id: 'SPMS-0000' })
  assert.equal(nope.ok, false)
  assert.match(nope.text, /没有找到需求/)
})

test('API：GET /brief 走通（200 / 400 / 404）', async () => {
  await seedRequirement()
  const got = await callApi(api.handler, { method: 'GET', url: `${BASE}/brief?id=SPMS-5921` })
  assert.equal(got.statusCode, 200)
  assert.match(got.json.brief, /需求 SPMS-5921/)
  assert.equal(got.json.requirement.links, 5)
  const noId = await callApi(api.handler, { method: 'GET', url: `${BASE}/brief` })
  assert.equal(noId.statusCode, 400)
  const missing = await callApi(api.handler, { method: 'GET', url: `${BASE}/brief?id=SPMS-404` })
  assert.equal(missing.statusCode, 404)
})

test('API：POST /open-session —— 没有 workspaceRegistry 时如实报错并仍给简报', async () => {
  await seedRequirement()
  const res = await callApi(api.handler, { method: 'POST', url: `${BASE}/open-session`, body: { id: 'SPMS-5921' } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.match(res.json.prompt, /需求 SPMS-5921/)
  assert.equal(res.json.canCreate, false, '没有 workspace 服务时不能建会话')
  assert.match(res.json.workspaceError, /workspaceRegistry|工作目录/)
  assert.equal(res.json.project.id, 'spms')
})

test('API：POST /open-session —— 有 ensureWorkspace 时登记目录并回传 workspace.id', async () => {
  await seedRequirement()
  const calls = []
  api = captureApi(store, {
    version: 'x',
    ensureWorkspace: async (path, title) => {
      calls.push([path, title])
      return { id: 'ws-spms-1', path, title, created: true }
    },
  })
  const res = await callApi(api.handler, { method: 'POST', url: `${BASE}/open-session`, body: { id: 'SPMS-5921' } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.canCreate, true)
  assert.equal(res.json.workspace.id, 'ws-spms-1')
  assert.equal(calls.length, 1)
  assert.ok(calls[0][0].endsWith('spms'), '要把项目目录（root）登记成 workspace')
  assert.equal(calls[0][1], 'spms', 'title 用项目名')
  const missing = await callApi(api.handler, { method: 'POST', url: `${BASE}/open-session`, body: {} })
  assert.equal(missing.statusCode, 400)
})

// ── 客户端纯函数（能力探测）──────────────────────────────────────────────

function loadClientSession() {
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
  return captured.factory(() => React).__test.session
}

test('客户端：createSessionIn 走 sessions.create，兼容三种返回形态', async () => {
  const { createSessionIn } = loadClientSession()
  const calls = []
  const sessions = { create: async (payload) => { calls.push(payload); return 'sess-1' } }
  assert.equal(await createSessionIn(sessions, {}, 'ws-1'), 'sess-1')
  assert.equal(calls[0].workspaceId, 'ws-1')
  const objForm = { create: async () => ({ sessionId: 'sess-2' }) }
  assert.equal(await createSessionIn(objForm, {}, 'ws-1'), 'sess-2')
  const idForm = { create: async () => ({ id: 'sess-3' }) }
  assert.equal(await createSessionIn(idForm, {}, 'ws-1'), 'sess-3')
  // 没有 create 时退到 connectWorkspace
  const legacy = { connectWorkspace: async () => 'sess-legacy' }
  assert.equal(await createSessionIn({}, legacy, 'ws-1'), 'sess-legacy')
  // 两条路都没有 → 报错里带真实方法清单（便于下一次定位形态差异）
  await assert.rejects(() => createSessionIn({ foo() {} }, { bar() {} }, 'ws-1'), /sessions 暴露的方法：foo/)
})

test('客户端：sendIntoSession 优先 scope.conversation.send，缺失时退到 sessions.using', async () => {
  const { sendIntoSession } = loadClientSession()
  const sent = []
  const sessionsDirect = {
    scope: () => ({ get: (name) => (name === 'conversation' ? { send: async (text) => sent.push(['scope', text]) } : undefined) }),
  }
  assert.equal(await sendIntoSession(sessionsDirect, 'sess-1', '简报A'), 'scope.conversation')
  assert.equal(sent[0][0], 'scope')

  const sessionsUsing = {
    scope: () => undefined,
    using: async (id, opts, run) => {
      await run({ get: (name) => (name === 'conversation' ? { send: async (text) => sent.push(['using', text]) } : undefined) })
    },
  }
  assert.equal(await sendIntoSession(sessionsUsing, 'sess-2', '简报B'), 'using')
  assert.equal(sent[1][1], '简报B')

  await assert.rejects(() => sendIntoSession({ scope: () => undefined }, 'sess-3', 'x'), /拿不到会话作用域/)
})

test('客户端：resolveWorkspaceId 优先用宿主给的 id，过期则回落快照/默认项目', async () => {
  const { resolveWorkspaceId } = loadClientSession()
  const workspaces = {
    list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-a', sessionIds: ['s1'] }, { workspaceId: 'ws-b', sessionIds: [] }] }) },
    initializeDefault: async () => 'ws-default',
  }
  assert.equal(await resolveWorkspaceId(workspaces, 'ws-b'), 'ws-b', '命中快照就直接用')
  assert.equal(await resolveWorkspaceId(workspaces, null), 'ws-a', '没有目标时用快照第一个')
  const empty = { list: { getSnapshot: () => ({ items: [] }) }, initializeDefault: async () => ({ workspaceId: 'ws-default' }) }
  assert.equal(await resolveWorkspaceId(empty, null), 'ws-default', '空快照退到默认项目')
  const failing = { list: { getSnapshot: () => ({ items: [] }) }, initializeDefault: async () => { throw new Error('nope') } }
  assert.equal(await resolveWorkspaceId(failing, null), undefined)
})
