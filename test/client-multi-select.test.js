/**
 * 卡片上的工作区**多选**，以及「读文档 → 回填工作区/端」的客户端纯函数。
 *
 * 用户诉求（原话要点）：
 *   · 「卡片上的工作区可以多选，多选时开启对应多个会话」—— 仍然是**点击才开启**，
 *     只是点一次「开新会话」会给每个选中的工作区各开一个会话。
 *
 * 这里只验纯函数（选哪些、认哪些）；真开会话的链路在 session-open.test.js 里验。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const CODE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** 把 client.js 装进 vm（只为一件事：拿它导出的 `__test` 纯函数）。 */
function loadClient() {
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
  vm.runInContext(CODE, sandbox, { filename: 'lib/client.js' })
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children } }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
  }
  return captured.factory(() => React).__test
}

/** 跨 vm 上下文的数组原型不同：断言一律退化成字符串/标量，避免假阴性。 */
const ids = (rows) => rows.map((row) => row.projectId ?? row.project).join(',')

const LIST = [
  { projectId: 'demo-pc', projectName: 'demo-pc', platform: 'PC', primary: true },
  { projectId: 'demo-app', projectName: 'demo-app', platform: 'APP', primary: false },
  { projectId: 'demo-api', projectName: 'demo-api', platform: '服务端', primary: false },
]

test('chooseProjects：没点过 → 只主项目（与以前单选的默认行为一致）', () => {
  const { chooseProjects } = loadClient()
  assert.equal(ids(chooseProjects(LIST, undefined)), 'demo-pc')
  assert.equal(ids(chooseProjects(LIST, [])), 'demo-pc')
  assert.equal(ids(chooseProjects([], undefined)), '')
})

test('chooseProjects：多选按**卡片顺序**返回，不是点选顺序', () => {
  const { chooseProjects } = loadClient()
  // 先点 API 再点 PC：返回顺序仍然是卡片上的顺序（PC 在 API 前面）
  assert.equal(ids(chooseProjects(LIST, ['demo-api', 'demo-pc'])), 'demo-pc,demo-api')
  assert.equal(ids(chooseProjects(LIST, ['demo-app'])), 'demo-app')
  assert.equal(ids(chooseProjects(LIST, ['demo-pc', 'demo-app', 'demo-api'])), 'demo-pc,demo-app,demo-api')
})

test('chooseProjects：点了不存在的项目 → 回落主项目（不会开 0 个会话）', () => {
  const { chooseProjects } = loadClient()
  assert.equal(ids(chooseProjects(LIST, ['不存在'])), 'demo-pc')
  assert.equal(ids(chooseProjects(LIST, ['不存在', 'demo-api'])), 'demo-api')
})

test('chooseProjects：还认老形态（单个 projectId 字符串）', () => {
  const { chooseProjects } = loadClient()
  assert.equal(ids(chooseProjects(LIST, 'demo-app')), 'demo-app')
})

test('matchDocTargets：只按归一化后完全相同匹配项目名，不做包含匹配', () => {
  const { matchDocTargets } = loadClient()
  const projects = [
    { id: 'demo-pc', name: 'demo-pc', root: '/work/demo-pc' },
    { id: 'demo-app', name: 'Demo-App', root: '/work/demo-app' },
  ]
  // 文档里写 `项目：demo_app`（下划线/大小写不同）也要认出来
  const hit = matchDocTargets(projects, { strongPlatforms: ['APP'], strongProjectTokens: ['demo_app'] })
  assert.equal(ids(hit.projects), 'demo-app', 'Demo-App 归一化后等于 demo_app')
  assert.equal(hit.projects[0].platform, 'APP', '只指向一个端时才带端')

  // 包含匹配不算：「demo」不是任何项目的全名
  assert.equal(ids(matchDocTargets(projects, { strongProjectTokens: ['demo'] }).projects), '')
  // 目录名也认（root 的 basename）
  assert.equal(ids(matchDocTargets(projects, { strongProjectTokens: ['demo-pc'] }).projects), 'demo-pc')
  // 别名（aliases）也认
  assert.equal(ids(matchDocTargets([{ id: 'x1', name: 'X', aliases: ['x-alias'] }], { strongProjectTokens: ['x_alias'] }).projects), 'x1')
})

test('matchDocTargets：**弱证据不填**（正文顺口提到一个英文词不替用户做决定）', () => {
  const { matchDocTargets } = loadClient()
  const projects = [{ id: 'report', name: 'report' }]
  // 只有弱证据：正文写了「影响 report 模块」
  const weak = matchDocTargets(projects, { projectTokens: ['report'], weakProjectTokens: ['report'], strongProjectTokens: [] })
  assert.equal(ids(weak.projects), '', '弱证据一律不填')
  // 同一份项目，明写「项目：report」就算强证据
  assert.equal(ids(matchDocTargets(projects, { strongProjectTokens: ['report'] }).projects), 'report')
})

test('matchDocTargets：多端时不给 platform（无从判断哪个项目做哪端）', () => {
  const { matchDocTargets } = loadClient()
  const hit = matchDocTargets([{ id: 'demo-app', name: 'demo-app' }], { strongPlatforms: ['PC', 'APP'], strongProjectTokens: ['demo-app'] })
  assert.equal(hit.projects[0].platform, null)
  assert.equal(hit.platforms.join(','), 'PC,APP')
})

test('matchDocTargets：没有线索/没有项目时返回空，不抛', () => {
  const { matchDocTargets } = loadClient()
  assert.equal(ids(matchDocTargets([], { strongPlatforms: ['APP'], strongProjectTokens: ['demo-app'] }).projects), '')
  assert.equal(ids(matchDocTargets([{ id: 'demo-app', name: 'demo-app' }], null).projects), '')
  assert.equal(ids(matchDocTargets([{ id: 'demo-app', name: 'demo-app' }], { projectTokens: [] }).projects), '')
})

test('openRequirementSessions：选了几个工作区就开几个会话，各带自己的 projectId', async () => {
  const { session } = loadClient()
  const calls = []
  const open = async (requirementId, projectId, opts) => {
    calls.push([requirementId, projectId, opts?.branch])
    return `已在新会话里打开【${projectId}】`
  }
  const res = await session.openRequirementSessions(
    'DEMO-1',
    [
      { projectId: 'demo-pc', projectName: 'demo-pc', platform: 'PC' },
      { projectId: 'demo-app', projectName: 'demo-app', platform: 'APP' },
    ],
    { open },
  )
  assert.equal(calls.length, 2, '两个工作区 → 两个会话')
  assert.equal(calls.map((c) => c[1]).join(','), 'demo-pc,demo-app')
  assert.equal(calls.every((c) => c[0] === 'DEMO-1'), true)
  assert.equal(res.okList.length, 2)
  assert.equal(res.failed.length, 0)
  assert.equal(res.okList.map((item) => item.where).join(' | '), 'demo-pc · PC 端 | demo-app · APP 端')
})

test('openRequirementSessions：一个失败不影响后面继续开，失败如实报出来', async () => {
  const { session } = loadClient()
  const calls = []
  const open = async (_id, projectId) => {
    calls.push(projectId)
    if (projectId === 'demo-app') throw new Error('工作区登记失败')
    return 'ok'
  }
  const res = await session.openRequirementSessions(
    'DEMO-2',
    [{ projectId: 'demo-pc' }, { projectId: 'demo-app' }, { projectId: 'demo-api' }],
    { open },
  )
  assert.equal(calls.join(','), 'demo-pc,demo-app,demo-api', '中间失败也要把后面的开完')
  assert.equal(res.okList.length, 2)
  assert.equal(res.failed.length, 1)
  assert.equal(res.failed[0].where, 'demo-app')
  assert.match(res.failed[0].error, /工作区登记失败/)
})

test('openRequirementSessions：没选项目时仍按「默认工作区」开一个（老行为不退化）', async () => {
  const { session } = loadClient()
  const calls = []
  const open = async (_id, projectId) => {
    calls.push(projectId)
    return 'ok'
  }
  const res = await session.openRequirementSessions('DEMO-3', [], { open })
  assert.equal(calls.length, 1)
  assert.equal(calls[0], null, 'projectId 传 null = 宿主用主项目')
  assert.equal(res.okList[0].where, '默认工作区')
})

test('openRequirementSessions：分支模式逐个传下去（多选 + 当前分支/master 也要对）', async () => {
  const { session } = loadClient()
  const branches = []
  const open = async (_id, _projectId, opts) => {
    branches.push(opts?.branch)
    return 'ok'
  }
  await session.openRequirementSessions('DEMO-4', [{ projectId: 'a' }, { projectId: 'b' }], { branch: 'master', open })
  assert.equal(branches.join(','), 'master,master')
})

test('openRequirementSessions：onStep 按进度回调（界面据此逐步反馈）', async () => {
  const { session } = loadClient()
  const steps = []
  const open = async () => 'ok'
  await session.openRequirementSessions('DEMO-5', [{ projectId: 'a', projectName: 'A' }, { projectId: 'b', projectName: 'B' }], {
    open,
    onStep: (index, count, where) => steps.push(`${index}/${count}:${where}`),
  })
  assert.equal(steps.join(' | '), '0/2:A | 1/2:B')
})

test('openRequirementSessions：`ok:false` 的返回算失败（不许把「没开成」报成 ✓）', async () => {
  const { session } = loadClient()
  // 真实链路里「会话服务不可见 / 没建出会话」是**正常返回一句文案**，不是 throw。
  // 老实现只把 throw 当失败 → 汇总里会把它算成成功（审查指出的 blocker）。
  const open = async (_id, projectId) =>
    projectId === 'demo-app'
      ? { ok: false, text: '没能新建会话：workspace 不可用' }
      : { ok: true, text: `已在新会话里打开【${projectId}】` }

  const res = await session.openRequirementSessions('DEMO-6', [{ projectId: 'demo-pc' }, { projectId: 'demo-app' }], { open })
  assert.equal(res.okList.length, 1, '只有真开成的算成功')
  assert.equal(res.failed.length, 1)
  assert.equal(res.failed[0].where, 'demo-app')
  assert.match(res.failed[0].error, /没能新建会话/)
})

test('sendPromptToNewSessionDetailed：没有会话服务时返回 ok:false（别再靠猜文案）', async () => {
  const { session } = loadClient()
  const res = await session.sendPromptToNewSessionDetailed('提示词', { sessions: null, workspaces: null })
  assert.equal(res.ok, false)
  assert.match(res.text, /会话服务不可见/)
})

// ── 基线（从哪个分支拉新分支）：一个下拉 + 一个按钮 ─────────────────────

test('BRANCH_MODES：三个选项与 normBranchMode 的写法一致（不拉 / 当前分支 / master）', () => {
  const { BRANCH_MODES } = loadClient()
  assert.equal(BRANCH_MODES.length, 3)
  assert.equal(BRANCH_MODES.map(([value]) => value).join('|'), '|current|master')
  assert.equal(BRANCH_MODES.map(([, label]) => label).join('|'), '不拉分支|从当前分支|从 master')
})

test('normBranchModeInput：只认三档，别的都归到「不拉分支」', () => {
  const { normBranchModeInput } = loadClient()
  assert.equal(normBranchModeInput(''), '')
  assert.equal(normBranchModeInput('current'), 'current')
  assert.equal(normBranchModeInput('HEAD'), 'current', '认 head 别名（大小写不敏感）')
  assert.equal(normBranchModeInput('master'), 'master')
  assert.equal(normBranchModeInput(true), 'master', 'true 等价 master（老语义）')
  assert.equal(normBranchModeInput('false'), '')
  assert.equal(normBranchModeInput(undefined), '')
  assert.equal(normBranchModeInput('develop'), '', '不认识的基线不许瞎猜')
})

test('branchModeLabel：按钮文案用的短标签', () => {
  const { branchModeLabel } = loadClient()
  assert.equal(branchModeLabel(''), '')
  assert.equal(branchModeLabel('current'), '当前分支')
  assert.equal(branchModeLabel('master'), 'master')
})

test('openRequirementSessions：基线逐个传下去（多选时每个会话用同一个基线）', async () => {
  const { session } = loadClient()
  const branches = []
  const open = async (_id, _projectId, opts) => {
    branches.push(opts?.branch ?? '')
    return { ok: true, text: 'ok' }
  }
  await session.openRequirementSessions('DEMO-7', [{ projectId: 'a' }, { projectId: 'b' }], { branch: 'current', open })
  assert.equal(branches.join(','), 'current,current')
})
