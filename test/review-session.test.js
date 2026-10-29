/**
 * 「交给子 agent 评审」链路：
 *   宿主侧 —— `buildReviewSessionPrompt`（纯函数：元信息 + 报告证据 + 只读评审口径）
 *             与 `POST /review-session`（渲染提示词 + 登记 workspace，会话由客户端建）；
 *   客户端 —— `sendPromptToNewSession`（新会话投喂的共用段）与「不回落默认工作区」这条硬约束。
 *
 * 为什么要有这个测试：
 *   ① 用户 2026-10-29 的原话是「评审报告生成时有没有调用子 agent」—— 答案是**没有**
 *      （`buildReviewReport` 纯本地拼证据），所以「点按钮真的把材料发进会话」必须被钉住，
 *      否则功能退化成「报告末尾一句『请叫专家』」也没人会察觉；
 *   ② 评审最容易出的事故是**把材料发进不相干的项目**（`resolveWorkspaceId(null)` 会挑快照第一个
 *      workspace），所以「拿不到工作目录就不建会话」也要有断言。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import vm from 'node:vm'
import { buildReviewSessionPrompt, REVIEW_INSTRUCTION } from '../lib/review-prompt.js'
import { captureApi, callApi, openStore, useTempHome } from './helpers.js'

const BASE = '/project-hub/api'
const here = dirname(fileURLToPath(import.meta.url))
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

async function seedRequirement() {
  return store.saveRequirement({
    no: '6031',
    project: tmp.projectCwd('spms'),
    title: '订单列表改版',
    status: 'planning',
    readTitle: false,
    links: [
      { kind: 'doc', url: 'https://doc.example/6031', title: '需求说明书 v3' },
      { kind: 'ui', url: 'https://figma.example/6031', title: '列表 UI 稿' },
    ],
  })
}

function seedCandidate({ no = '5901', projectId = 'spms' } = {}) {
  store.db
    .prepare(
      `INSERT OR REPLACE INTO discover_candidates (no, title, doc_url, project_id, modules, code_commits, status)
       VALUES (?, ?, ?, ?, ?, ?, 'candidate')`,
    )
    .run(no, '历史需求一条', `https://doc.example/${no}`, projectId, JSON.stringify(['src/order/list']), 3)
  return no
}

// ── 纯函数：提示词结构 ───────────────────────────────────────────────────

test('评审提示词：元信息 + 报告证据 + 只读评审口径，且任务段排在**最后**', async () => {
  await seedRequirement()
  const result = buildReviewSessionPrompt(store, 'SPMS-6031')
  assert.equal(result.ok, true, '台账里的需求应该能生成提示词')
  const prompt = result.prompt

  // ① 元信息（复用 buildRequirementBrief，但关掉开发口径）
  assert.match(prompt, /# 需求 SPMS-6031/)
  assert.match(prompt, /需求说明书 v3/, '资料链接要在提示词里')
  // ② 报告原样内联
  const raw = store.buildReviewReport('SPMS-6031', {})
  assert.ok(prompt.includes(raw.markdown), '报告 markdown 必须原样内联（不做二次摘要）')
  assert.match(prompt, /## 1\. 相关历史需求/)
  // ③ 只读评审口径
  assert.ok(prompt.includes(REVIEW_INSTRUCTION), '要给子 agent 的评审口径')
  assert.match(prompt, /只读/, '必须写明只读约束')
  assert.match(prompt, /证据不足/, '必须要求如实说证据不足')
  // ④ 顺序：先资料 → 再证据 → 最后才是任务（先读完材料再下结论）
  const atEvidence = prompt.indexOf('## 评审影响报告（台账自动生成，只给证据）')
  const atTask = prompt.indexOf('## 请做的第一件事')
  assert.ok(atEvidence > 0 && atTask > atEvidence, `任务段要在证据之后（evidence=${atEvidence}, task=${atTask}）`)
  assert.equal(prompt.lastIndexOf('## 请做的第一件事'), atTask, '任务段只能出现一次，且在末尾')
  assert.equal(typeof result.chars, 'number')
  assert.equal(result.chars, prompt.length)
  assert.equal(result.project.id, 'spms')
})

test('评审提示词：不带开发口径（不拉分支、不再转交、不重复叫专家）', async () => {
  await seedRequirement()
  const prompt = buildReviewSessionPrompt(store, 'SPMS-6031').prompt
  assert.doesNotMatch(prompt, /开工前.*拉新分支|git checkout -b/, '评审不该让子 agent 拉分支')
  assert.doesNotMatch(prompt, /## 开工先叫人/, '评审不再走开发简报的「开工先叫人」段（第 9 节已自带叫法）')
  assert.doesNotMatch(prompt, /## 转交出去时/, '评审不再转交，不该出现转交段')
  assert.doesNotMatch(prompt, /先复述一遍你的理解/, '不该留开发简报的默认任务清单')
})

test('评审提示词：体积有上限（防未来报告膨胀把单条消息撑爆）', async () => {
  await seedRequirement()
  const result = buildReviewSessionPrompt(store, 'SPMS-6031')
  assert.ok(result.chars < 20000, `提示词 ${result.chars} 字，超过 20K 需要重新设计投递方式`)
})

test('评审提示词：找不到需求时明确失败，**不**降级成「只有简报」', async () => {
  await seedRequirement()
  const missing = buildReviewSessionPrompt(store, 'SPMS-9999')
  assert.equal(missing.ok, false)
  assert.match(missing.error, /没有找到需求 SPMS-9999/)
  assert.equal(missing.prompt, '', '失败时不能给出「看起来能发」的提示词')
  const blank = buildReviewSessionPrompt(store, '   ')
  assert.equal(blank.ok, false)
})

// ── 候选：不在台账里也要能评审 ───────────────────────────────────────────

test('评审提示词：候选（还没采纳）也能生成，并说明「台账里没有它的 WBS / 后端设计」', async () => {
  await seedRequirement()
  const no = seedCandidate()
  const result = buildReviewSessionPrompt(store, no, { candidate: true })
  assert.equal(result.ok, true, '候选不该因为「不在台账」就评审不了')
  assert.equal(result.candidate, true)
  assert.match(result.prompt, /候选需求 5901/)
  assert.match(result.prompt, /还没采纳进台账/)
  assert.match(result.prompt, /https:\/\/doc\.example\/5901/, '候选的资料链接要原样带上')
  assert.match(result.prompt, /src\/order\/list/, '候选的代码落点线索要带上')
  // 证据段照样在
  assert.match(result.prompt, /## 评审影响报告（台账自动生成，只给证据）/)
  // 候选不走 buildRequirementBrief，所以不会出现台账口径的需求头
  assert.doesNotMatch(result.prompt, /# 需求 SPMS-5901/)
})

test('评审提示词：候选号不存在时如实报错', async () => {
  const result = buildReviewSessionPrompt(store, '5902', { candidate: true })
  assert.equal(result.ok, false)
  assert.match(result.error, /没有找到候选 5902/)
})

// ── 宿主路由 ─────────────────────────────────────────────────────────────

test('API：POST /review-session —— 缺 id 是 400，找不到是 404', async () => {
  await seedRequirement()
  const api = captureApi(store, { version: 't' })
  const noId = await callApi(api.handler, { method: 'POST', url: `${BASE}/review-session`, body: {} })
  assert.equal(noId.statusCode, 400)
  const missing = await callApi(api.handler, { method: 'POST', url: `${BASE}/review-session`, body: { id: 'SPMS-9999' } })
  assert.equal(missing.statusCode, 404)
  assert.match(missing.json.error, /没有找到需求/)
})

test('API：POST /review-session —— 没有 workspaceRegistry 时仍给提示词，但 canCreate=false', async () => {
  await seedRequirement()
  const api = captureApi(store, { version: 't' })
  const res = await callApi(api.handler, { method: 'POST', url: `${BASE}/review-session`, body: { id: 'SPMS-6031' } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.canCreate, false, '拿不到 workspace 时不能声称能建会话')
  assert.match(res.json.workspaceError, /工作目录|workspaceRegistry/)
  assert.match(res.json.prompt, /# 需求 SPMS-6031/)
  assert.ok(res.json.chars > 0)
  assert.match(res.json.prompt, /## 评审影响报告/, '拿不到 workspace 也必须把材料给出（让客户端复制提示词兜底）')
})

test('API：POST /review-session —— 有 ensureWorkspace 时把项目 root 登记成 workspace', async () => {
  await seedRequirement()
  const calls = []
  const api = captureApi(store, {
    version: 't',
    ensureWorkspace: async (path, title) => {
      calls.push([path, title])
      return { id: 'ws-6031', path, title, created: true }
    },
  })
  const res = await callApi(api.handler, { method: 'POST', url: `${BASE}/review-session`, body: { id: 'SPMS-6031' } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.canCreate, true)
  assert.equal(res.json.workspace.id, 'ws-6031')
  assert.equal(calls.length, 1)
  assert.ok(String(calls[0][0]).endsWith('spms'), '登记的应该是项目工作目录')
  assert.equal(calls[0][1], 'spms', 'title 用项目名')
})

test('API：POST /review-session —— 候选也能走路由（candidate:true）', async () => {
  await seedRequirement()
  const no = seedCandidate({ no: '5901', projectId: 'spms' })
  const api = captureApi(store, { version: 't' })
  const res = await callApi(api.handler, { method: 'POST', url: `${BASE}/review-session`, body: { id: no, candidate: true } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.candidate, true)
  assert.match(res.json.prompt, /候选需求 5901/)
})

test('API：POST /review-session —— 报告渲染抛错是 500（不许降级成「只有简报」的提示词）', async () => {
  await seedRequirement()
  const api = captureApi(store, { version: 't' })
  const original = store.buildReviewReport
  store.buildReviewReport = () => {
    throw new Error('报告渲染炸了')
  }
  try {
    const res = await callApi(api.handler, { method: 'POST', url: `${BASE}/review-session`, body: { id: 'SPMS-6031' } })
    assert.equal(res.statusCode, 500)
    assert.equal(res.json.ok, false)
    assert.match(res.json.error, /评审提示词生成失败/)
  } finally {
    store.buildReviewReport = original
  }
})

// ── 客户端纯函数 ─────────────────────────────────────────────────────────

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

test('客户端：sendPromptToNewSession 有 workspace 时建会话并投喂提示词', async () => {
  const { sendPromptToNewSession } = loadClientSession()
  const sent = []
  const sessions = {
    create: async () => 'sess-9',
    open: () => {},
    scope: () => ({ get: (name) => (name === 'conversation' ? { send: async (text) => sent.push(text) } : undefined) }),
  }
  const workspaces = { list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-1', sessionIds: [] }] }) } }
  const text = await sendPromptToNewSession('评审材料', {
    workspaceIdHint: 'ws-1',
    projectName: 'spms',
    label: '评审提示词',
    fallbackWorkspace: false,
    sessions,
    workspaces,
  })
  assert.match(text, /已在新会话里打开【spms】并发出评审提示词/)
  assert.deepEqual(sent, ['评审材料'])
})

test('客户端：sendPromptToNewSession —— 评审场景拿不到 workspace 时**不建会话**，只给提示词', async () => {
  const { sendPromptToNewSession } = loadClientSession()
  let created = 0
  const sessions = { create: async () => { created += 1; return 'should-not-happen' } }
  const workspaces = { list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-other', sessionIds: [] }] }) } }
  const text = await sendPromptToNewSession('评审材料', {
    workspaceIdHint: null,
    label: '评审提示词',
    fallbackWorkspace: false,
    failureHint: '没能定位工作区（项目还没有工作目录）',
    sessions,
    workspaces,
  })
  assert.equal(created, 0, '绝不能回落到默认 workspace：宁可不建会话')
  assert.match(text, /没能定位工作区（项目还没有工作目录）/)
  assert.match(text, /评审材料/, '提示词要回显出来（剪贴板不可用时让人自己拷）')
})

test('客户端：回调默认 workspace 的旧行为仍保留（开新会话是尽力而为）', async () => {
  const { sendPromptToNewSession } = loadClientSession()
  const created = []
  const sessions = {
    create: async (payload) => { created.push(payload.workspaceId); return 'sess-2' },
    scope: () => ({ get: (name) => (name === 'conversation' ? { send: async () => {} } : undefined) }),
  }
  const workspaces = { list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-first', sessionIds: [] }] }) } }
  const text = await sendPromptToNewSession('简报', {
    workspaceIdHint: null,
    fallbackWorkspace: true,
    label: '需求简报',
    sessions,
    workspaces,
  })
  assert.deepEqual(created, ['ws-first'], '开新会话仍可回落默认工作区')
  assert.match(text, /已在新会话里打开【ws-first】/)
})

test('客户端：openReviewSession 已导出（面板按钮走它）', () => {
  const { openReviewSession } = loadClientSession()
  assert.equal(typeof openReviewSession, 'function')
})

// ── 回归：护栏不许被服务端自己架空 ─────────────────────────────────────

test('API：POST /review-session —— 项目没有 root 时，即使带了 sessionId 也**不许** canCreate', async () => {
  // 这条钉住的是「绝不把评审材料发进不相干项目」这个承诺。
  // 曾经的实现是 `body.root ?? result.project?.root ?? cwd`：只要请求带上 `?sessionId=`，
  // cwd 就会顶替项目 root，把**当前会话所在的不相干目录**登记成 workspace 并返回 canCreate:true，
  // 客户端 `fallbackWorkspace:false` 于是放行 —— 全程没有任何报错。
  const opened = await store.saveRequirement({ no: '5941', project: 'ghost-proj', title: '没有工作目录的需求', readTitle: false })
  const id = opened.requirement.id
  const calls = []
  const api = captureApi(store, {
    version: 't',
    // 模拟「当前会话所在的目录」——绝不能被当成评审项目的目录
    getSessionCwd: () => '/tmp/UNRELATED_PROJECT',
    ensureWorkspace: async (path) => {
      calls.push(path)
      return { id: 'ws-should-not-be-created', path, created: true }
    },
  })
  const res = await callApi(api.handler, {
    method: 'POST',
    url: `${BASE}/review-session?sessionId=abc`,
    body: { id, root: '/tmp/ALSO-UNRELATED' },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.canCreate, false, '没有项目 root 时不能建会话（cwd / body.root 都不许顶替）')
  assert.equal(res.json.workspace, null)
  assert.equal(calls.length, 0, 'ensureWorkspace 不该被调用（没有被拿来登记的目录）')
  assert.match(res.json.workspaceError, /工作目录/)
  assert.ok(res.json.prompt.length > 0, '仍然要把提示词给出去，让用户复制兜底')
})

test('评审提示词：资料里出现同名标题时不许把资料腰斩（lastIndexOf）', async () => {
  // 中段内联的资料含自动抓来的 Confluence 文档标题（外部可控）。若用 indexOf 找任务段，
  // 一个恰好叫「## 请做的第一件事」的标题会把资料从此处截断，后半段被塞进任务段。
  const opened = await store.saveRequirement({
    no: '5942',
    project: tmp.projectCwd('spms'),
    title: '标题撞车测试',
    readTitle: false,
    links: [
      { kind: 'doc', url: 'https://doc.example/trap', title: '## 请做的第一件事' },
      { kind: 'design', url: 'https://design.example/tail', title: '这一条必须仍然出现在提示词里' },
    ],
  })
  const result = buildReviewSessionPrompt(store, opened.requirement.id)
  assert.equal(result.ok, true)
  assert.match(result.prompt, /这一条必须仍然出现在提示词里/, '资料不能被截断丢掉后半段')
  const heading = '## 请做的第一件事'
  assert.equal(result.prompt.split(heading).length - 1, 2, '资料里那次 + 任务段那次，共两次（多说明被复制了）')
  assert.equal(result.prompt.lastIndexOf(heading), result.prompt.indexOf(heading, result.prompt.indexOf(heading) + 1), '任务段只能是最后一个同名标题')
  assert.ok(result.prompt.lastIndexOf('### 只做「评审判定」') > result.prompt.indexOf('## 评审影响报告'), '评审口径仍在证据之后')
})

// ── 客户端：openReviewSession 的请求与降级（用 fetch 桩）─────────────────

function loadClientWithFetch(payload, requests) {
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
    clearTimeout,
    // `api()` 用 fetch + res.json()；把请求体记下来供断言
    fetch: async (url, init) => {
      requests.push({ url, body: init && init.body ? JSON.parse(init.body) : null, method: init && init.method })
      return { status: 200, ok: true, json: async () => payload }
    },
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

test('客户端：openReviewSession 把 id/project/platform/candidate 发给 /review-session', async () => {
  const requests = []
  const { openReviewSession } = loadClientWithFetch(
    { ok: true, prompt: '评审材料', chars: 4, candidate: false, workspace: null, workspaceError: '没有工作目录', project: null },
    requests,
  )
  const text = await openReviewSession({ id: 'SPMS-6031', project: 'spms', platform: 'PC', candidate: false })
  assert.equal(requests.length, 1)
  assert.match(requests[0].url, /\/review-session$/)
  assert.equal(requests[0].method, 'POST')
  assert.deepEqual(requests[0].body, { id: 'SPMS-6031', project: 'spms', platform: 'PC' })
  // 测试沙箱里看不到宿主 sessions 服务 ⇒ 走「会话服务不可见 + 把提示词给出来」的降级。
  // （`workspace` 缺失时不建会话那条护栏由 sendPromptToNewSession 的专门用例钉住。）
  assert.match(text, /评审材料/, '任何降级路径都必须把提示词交出来，不能只丢一句报错')
  assert.match(text, /会话服务不可见/, 'sandbox 无 sessions 服务时应如实说明')
})

test('客户端：openReviewSession 候选场景把 candidate 一起发出去', async () => {
  const requests = []
  const { openReviewSession } = loadClientWithFetch(
    { ok: true, prompt: '候选材料', chars: 4, candidate: true, workspace: null, workspaceError: '候选没有工作目录' },
    requests,
  )
  const text = await openReviewSession({ id: '5901', candidate: true })
  assert.equal(requests[0].body.candidate, true)
  assert.match(text, /评审提示词（候选）/)
})

test('客户端：建会话本身抛错时也要把提示词复制出来（不许只丢个报错）', async () => {
  const { sendPromptToNewSession } = loadClientSession()
  const sessions = {
    create: async () => {
      throw new Error('sessions.create 挂了')
    },
  }
  const workspaces = { list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-1', sessionIds: [] }] }) } }
  const text = await sendPromptToNewSession('评审材料', {
    workspaceIdHint: 'ws-1',
    label: '评审提示词',
    fallbackWorkspace: false,
    sessions,
    workspaces,
  })
  assert.match(text, /没能新建会话：sessions\.create 挂了/)
  assert.match(text, /评审材料/, '提示词必须回显（能复制就不算白点）')
})
