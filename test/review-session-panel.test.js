/**
 * 面板**行为级**回归：「交给子agent评审」这条按钮真的接上了没有。
 *
 * 背景（2026-10-29 用户报障）：按钮加上了、也看得见，但**点了没反应、也没开会话**。
 * 读代码只能证明「如果 onClick 跑了就该发请求」，证明不了 onClick 有没有跑、
 * 请求有没有真的发出去、顶部有没有出现提示。所以这里用 `test/mini-react.js` 的极简
 * hooks 运行时把**真面板**挂起来，用假 fetch 驱动真实点击，断言的是用户看到的东西：
 *   ① 生成报告后，卡片上确实有「交给子agent评审」按钮（不是被挤出可视区/没渲染）；
 *   ② 点它确实发出 `POST /review-session`（且带着需求 id）；
 *   ③ 点下去**立刻**有可见反馈（不再出现「点了什么都没有」）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFetchStub, mountPanel } from './mini-react.js'

/** 在通用 stub 前面截获评审相关路由，其余照旧。 */
function makeStub(overrides = {}) {
  const base = createFetchStub()
  const posts = []
  const stub = (url, init) => {
    const route = url.replace('/project-hub/api', '').split('?')[0]
    if (init && init.method === 'POST') posts.push({ route, body: init.body ? JSON.parse(init.body) : null })
    if (route in overrides) return Promise.resolve({ json: async () => overrides[route] })
    return base(url, init)
  }
  stub.posts = posts
  stub.base = base
  return stub
}

const REPORT = {
  ok: true,
  markdown: '# 评审影响报告：5941\n\n## 1. 相关历史需求（按证据强度排序）\n- 无\n',
  related: [{ id: '5901', title: '旧需求' }],
  reuse: [],
  drift: null,
}

test('行为：点「评审报告」→ 卡片上出现「交给子agent评审」按钮（真的渲染出来了）', async () => {
  const stub = makeStub({ '/review-report': REPORT })
  const { mini, renderPanel } = mountPanel(stub)
  const root = () => renderPanel({ sessionId: 'session-review' })
  await mini.act(root)

  const buildBtn = mini.findButton('评审报告')
  assert.ok(buildBtn, '需求行上要有「评审报告」按钮')
  await mini.act(root, () => buildBtn.props.onClick())

  const reviewBtn = mini.findButton('交给子agent评审')
  assert.ok(reviewBtn, '报告卡片上必须有「交给子agent评审」按钮')
  assert.equal(reviewBtn.props.disabled, false, '按钮不该是 disabled（disabled 就是「点了没反应」）')
  assert.ok(mini.findButton('只复制提示词'), '同时要有不建会话的兜底按钮')
})

test('行为：点「交给子agent评审」真的发出 POST /review-session（带需求 id）', async () => {
  const stub = makeStub({ '/review-report': REPORT })
  const { mini, renderPanel } = mountPanel(stub)
  const root = () => renderPanel({ sessionId: 'session-review' })
  await mini.act(root)
  await mini.act(root, () => mini.findButton('评审报告').props.onClick())

  const reviewBtn = mini.findButton('交给子agent评审')
  await mini.act(root, () => reviewBtn.props.onClick())

  const sent = stub.posts.filter((x) => x.route === '/review-session')
  assert.equal(sent.length, 1, '点一次必须发一次 /review-session')
  assert.equal(sent[0].body.id, '5941', '请求里要带需求 id')
})

test('行为：拿不到项目工作目录时不建会话，但**必须有可见反馈**（不许静默）', async () => {
  const stub = makeStub({
    '/review-report': REPORT,
    // 没有 workspace ⇒ 按设计不建会话，改为交还提示词
    '/review-session': { ok: true, prompt: '评审材料正文', chars: 6, candidate: false, workspace: null, workspaceError: '这条需求的项目还没有工作目录' },
  })
  const { mini, renderPanel } = mountPanel(stub)
  const root = () => renderPanel({ sessionId: 'session-review' })
  await mini.act(root)
  await mini.act(root, () => mini.findButton('评审报告').props.onClick())
  await mini.act(root, () => mini.findButton('交给子agent评审').props.onClick())

  const shown = mini.texts()
  // 不变量：**必须有可见反馈**，且必须把提示词交出来（不含静默失败）。
  // 说明两种降级都会出现：测试环境没有 sessions 服务 → 「会话服务不可见」；
  // 有 sessions 但没有项目目录 → 「没能定位工作区」。两者都必须说清楚原因。
  assert.match(shown, /会话服务不可见|没能定位工作区/, '要说清楚为什么没开会话')
  assert.match(shown, /评审材料正文/, '提示词要交出来（剪贴板不可用时直接显示）')
})

test('行为：点「只复制提示词」不建会话也能拿到提示词（会话服务的兜底路径）', async () => {
  const stub = makeStub({
    '/review-report': REPORT,
    '/review-session': { ok: true, prompt: '只复制用的提示词', chars: 8, candidate: false, workspace: null },
  })
  const { mini, renderPanel } = mountPanel(stub)
  const root = () => renderPanel({ sessionId: 'session-review' })
  await mini.act(root)
  await mini.act(root, () => mini.findButton('评审报告').props.onClick())

  const copyBtn = mini.findButton('只复制提示词')
  assert.ok(copyBtn, '兜底按钮要在')
  await mini.act(root, () => copyBtn.props.onClick())

  assert.equal(stub.posts.filter((x) => x.route === '/review-session').length, 1, '也要发一次 /review-session 拿提示词')
  const shown = mini.texts()
  assert.match(shown, /只复制用的提示词|已复制评审提示词/, '要么复制成功、要么把正文显示出来')
})
