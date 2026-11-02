/**
 * 行为级回归：卡片上的工作区**点一下就多选**，点「开新会话」时**给每个选中的工作区各开一个会话**。
 *
 * 用 `test/mini-react.js` 的验证台（真 hooks + 假 fetch）驱动真实点击，断言的是用户看到的症状本身：
 *   · 默认只有主项目是选中的（和以前单选的默认行为一致）；
 *   · 点第二个项目胶囊 → 两个都选中（不是「切过去」，是「加进来」）；
 *   · 再点一下 → 移出；
 *   · 点「开新会话」→ 发出**两条** /open-session，project 分别是选中的那两个（仍然是点击才开启）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountPanel } from './mini-react.js'

const REQ = {
  id: 'DEMO-1',
  no: '6100',
  title: '多工作区需求',
  projectId: 'demo-pc',
  projectName: 'demo-pc',
  status: 'planning',
  links: [],
  tags: [],
  projects: [
    { projectId: 'demo-pc', projectName: 'demo-pc', platform: 'PC', primary: true },
    { projectId: 'demo-app', projectName: 'demo-app', platform: 'APP', primary: false },
    { projectId: 'demo-api', projectName: 'demo-api', platform: '服务端', primary: false },
  ],
}

/** 假 fetch：记录 URL + body，按路由回最少的必要数据。 */
function makeFetch() {
  const calls = []
  const reply = (payload) => Promise.resolve({ json: async () => payload })
  const fetchStub = (url, init) => {
    calls.push({ url, init })
    const path = url.replace('/project-hub/api', '').split('?')[0]
    if (path === '/status') return reply({ ok: true, counts: {}, lastScanAt: null })
    if (path === '/projects') return reply({ ok: true, candidates: [] })
    if (path === '/requirements/tags') return reply({ ok: true, tags: [] })
    if (path === '/requirements') return reply({ ok: true, total: 1, items: [REQ] })
    if (path === '/open-session') {
      return reply({ ok: true, prompt: '（简报正文）', project: { id: 'p' }, platform: null, workspace: null, workspaceError: null })
    }
    return reply({ ok: true, items: [] })
  }
  fetchStub.calls = calls
  fetchStub.openSessionCalls = () => calls.filter((c) => c.url.replace('/project-hub/api', '').split('?')[0] === '/open-session')
  return fetchStub
}

const bodiesOf = (fetchStub) => fetchStub.openSessionCalls().map((c) => JSON.parse(c.init?.body ?? '{}'))

/** 卡片上的项目胶囊：带 platform 的那个按钮（文字形如「✓ demo-pc · PC」）。 */
const pillOf = (mini, projectId) => mini.buttons().find((el) => String(el.props.children ?? '').includes(projectId) && String(el.props.className ?? '').includes('dsh-ph-pill'))

const exactButton = (mini, label) => mini.buttons().find((el) => String(el.props.children ?? '') === label)
/** 「开新会话」按钮：多选时标签会带上个数（开新会话（2 个）），按前缀找。 */
/** 「开新会话」按钮：靠稳定的 className 定位（标签会随「几个 / 哪个基线」变，不能靠文字）。 */
const openButton = (mini) => mini.buttons().find((el) => String(el.props.className ?? '').includes('dsh-ph-open-session'))

test('行为：默认只有主项目选中（与以前单选默认一致）', async () => {
  const fetchStub = makeFetch()
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-multi' })
  await mini.act(root)

  assert.match(String(pillOf(mini, 'demo-pc').props.children), /^✓ /, '主项目默认选中')
  assert.doesNotMatch(String(pillOf(mini, 'demo-app').props.children), /✓/, '别的项目默认不选')
  assert.doesNotMatch(String(pillOf(mini, 'demo-api').props.children), /✓/)
})

test('行为：再点一个项目胶囊是「加进来」（多选），不是「切过去」', async () => {
  const fetchStub = makeFetch()
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-multi' })
  await mini.act(root)

  await mini.act(root, () => pillOf(mini, 'demo-app').props.onClick())
  assert.match(String(pillOf(mini, 'demo-pc').props.children), /^✓ /, '原来选中的还在')
  assert.match(String(pillOf(mini, 'demo-app').props.children), /^✓ /, '新点的也选中')

  // 再点一下 → 移出
  await mini.act(root, () => pillOf(mini, 'demo-app').props.onClick())
  assert.doesNotMatch(String(pillOf(mini, 'demo-app').props.children), /✓/, '再点一下移出')
  assert.match(String(pillOf(mini, 'demo-pc').props.children), /^✓ /)
})

test('行为：点「开新会话」→ 每个选中的工作区各一条 /open-session（点击才开启）', async () => {
  const fetchStub = makeFetch()
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-multi' })
  await mini.act(root)

  // 选第二个工作区
  await mini.act(root, () => pillOf(mini, 'demo-app').props.onClick())
  assert.equal(fetchStub.openSessionCalls().length, 0, '只多选不发请求（还是点击才开启）')
  // 按钮上要能看出「会开几个」（否则一次点出 N 个会话毫无预告）
  assert.equal(String(openButton(mini).props.children), '开新会话（2 个）')

  await mini.act(root, () => openButton(mini).props.onClick())

  const bodies = bodiesOf(fetchStub)
  assert.equal(bodies.length, 2, '两个选中工作区 → 两个开会话请求')
  assert.equal(bodies.map((b) => b.project).join(','), 'demo-pc,demo-app', '每个请求带自己的项目')
  assert.equal(bodies.every((b) => b.id === 'DEMO-1'), true)
})

test('行为：选中三个工作区 → 三条 /open-session，顺序按卡片', async () => {
  const fetchStub = makeFetch()
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-multi' })
  await mini.act(root)

  await mini.act(root, () => pillOf(mini, 'demo-app').props.onClick())
  await mini.act(root, () => pillOf(mini, 'demo-api').props.onClick())
  await mini.act(root, () => openButton(mini).props.onClick())

  const bodies = bodiesOf(fetchStub)
  assert.equal(bodies.length, 3)
  assert.equal(bodies.map((b) => b.project).join(','), 'demo-pc,demo-app,demo-api')
})

test('行为：把主项目也移出、只剩一个 → 只开那一个', async () => {
  const fetchStub = makeFetch()
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-multi' })
  await mini.act(root)

  await mini.act(root, () => pillOf(mini, 'demo-app').props.onClick()) // 选中 pc+app
  await mini.act(root, () => pillOf(mini, 'demo-pc').props.onClick()) // 移出 pc
  await mini.act(root, () => openButton(mini).props.onClick())

  const bodies = bodiesOf(fetchStub)
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].project, 'demo-app')
})

test('行为：最后一个工作区移不掉（避免「看着没选、实际照样开」）', async () => {
  const fetchStub = makeFetch()
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-multi' })
  await mini.act(root)

  // 唯一选中的是主项目：再点它应当是 no-op + 一句提示，而不是变成「什么都没选」
  await mini.act(root, () => pillOf(mini, 'demo-pc').props.onClick())
  assert.match(String(pillOf(mini, 'demo-pc').props.children), /^✓ /, '最后一个仍然选中')
  assert.match(mini.texts(), /至少要留一个工作区/)

  await mini.act(root, () => openButton(mini).props.onClick())
  const bodies = bodiesOf(fetchStub)
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].project, 'demo-pc', '提示与实际行为一致：给选中的那个开')
})

/** 基线下拉（BranchPicker）：按 option 文本找，不靠顺序。 */
const branchPicker = (mini) =>
  mini.nodes()
    .filter((el) => el.type === 'select')
    .find((el) => (Array.isArray(el.props.children) ? el.props.children : []).some((opt) => String(opt?.props?.children ?? '') === '不拉分支'))

test('行为：默认「不拉分支」—— 请求里不带 branch（老行为不变）', async () => {
  const fetchStub = makeFetch()
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-multi' })
  await mini.act(root)

  const picker = branchPicker(mini)
  assert.ok(picker, '卡片上要有基线下拉')
  assert.equal(picker.props.value, '', '默认不拉分支')

  await mini.act(root, () => openButton(mini).props.onClick())
  const bodies = bodiesOf(fetchStub)
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].branch, undefined, '不拉分支时请求里不带 branch')
})

test('行为：下拉切到 master → 多选照样逐个开，且每个都带 master', async () => {
  const fetchStub = makeFetch()
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-multi' })
  await mini.act(root)

  await mini.act(root, () => pillOf(mini, 'demo-app').props.onClick())
  await mini.act(root, () => branchPicker(mini).props.onChange({ target: { value: 'master' } }))
  // 按钮文案要把「开几个 + 从哪拉」都写出来
  assert.equal(String(openButton(mini).props.children), '开新会话（2 个·master）')

  await mini.act(root, () => openButton(mini).props.onClick())
  const bodies = bodiesOf(fetchStub)
  assert.equal(bodies.length, 2)
  assert.equal(bodies.map((b) => `${b.project}:${b.branch}`).join(','), 'demo-pc:master,demo-app:master')
})

test('行为：下拉切到「当前分支」→ 单选时按钮写「开新会话·当前分支」，请求带 current', async () => {
  const fetchStub = makeFetch()
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-multi' })
  await mini.act(root)

  await mini.act(root, () => branchPicker(mini).props.onChange({ target: { value: 'current' } }))
  assert.equal(String(openButton(mini).props.children), '开新会话·当前分支')

  await mini.act(root, () => openButton(mini).props.onClick())
  const bodies = bodiesOf(fetchStub)
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].branch, 'current')
})

test('行为：基线是按需求记的（换一层展开不会把上一条的选择带跑）', async () => {
  const fetchStub = makeFetch()
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-multi' })
  await mini.act(root)

  await mini.act(root, () => branchPicker(mini).props.onChange({ target: { value: 'master' } }))
  assert.equal(branchPicker(mini).props.value, 'master')
  // 再切回不拉分支：值要真的回到 ''（不是留着 master）
  await mini.act(root, () => branchPicker(mini).props.onChange({ target: { value: '' } }))
  assert.equal(branchPicker(mini).props.value, '')
  await mini.act(root, () => openButton(mini).props.onClick())
  assert.equal(bodiesOf(fetchStub)[0].branch, undefined)
})
