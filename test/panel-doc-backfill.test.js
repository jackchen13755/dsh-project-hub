/**
 * 行为级回归：表单里点「读信息」时，除了标题/需求号/创建人/产品，**还要把工作区与端回填到项目行**。
 *
 * 用户诉求（原话）：「读文档信息是希望能分辨出需要的工作区和端信息，回填」。
 * 回填规则（与宿主侧 saveRequirement 一致）：**只补空、不覆盖**。
 *
 * 用 `test/mini-react.js` 的验证台驱动真实点击。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountPanel } from './mini-react.js'

/** 已知项目（面板的 /projects 候选）：文档里写 demo-app，就要认出这一条。 */
const CANDIDATES = [
  { id: 'demo-app', name: 'demo-app', root: '/work/demo-app' },
  { id: 'demo-api', name: 'demo-api', root: '/work/demo-api' },
]

/** 假 fetch：/doc-title 回一个「单端 + 认得出项目」的解析结果。 */
function makeFetch(docTitlePayload = null) {
  const calls = []
  const reply = (payload) => Promise.resolve({ json: async () => payload })
  const titleAnswer = docTitlePayload ?? {
    ok: true,
    title: '【6102】只在 APP 端加一个入口',
    creator: '王五',
    product: '张三',
    roles: { 产品: '张三', 前端: '王五' },
    uiLinks: [],
    targets: { platforms: ['APP'], strongPlatforms: ['APP'], projectTokens: ['demo-app'], strongProjectTokens: ['demo-app'] },
    source: 'local',
  }
  const fetchStub = (url) => {
    calls.push(url)
    const path = url.replace('/project-hub/api', '').split('?')[0]
    if (path === '/status') return reply({ ok: true, counts: {}, lastScanAt: null })
    if (path === '/projects') return reply({ ok: true, candidates: CANDIDATES })
    if (path === '/requirements/tags') return reply({ ok: true, tags: [] })
    if (path === '/requirements') return reply({ ok: true, total: 0, items: [] })
    if (path === '/doc-title') return reply(titleAnswer)
    return reply({ ok: true, items: [] })
  }
  fetchStub.calls = calls
  return fetchStub
}

const exactButton = (mini, label) => mini.buttons().find((el) => String(el.props.children ?? '') === label)

/** 打开「新建需求」表单。 */
async function openCreateForm(mini, root) {
  await mini.act(root, () => exactButton(mini, '＋ 新建需求').props.onClick())
}

/** 表单里的项目行 select：按「有哪些 option」认，不靠顺序。 */
const optionsOf = (el) => (Array.isArray(el.props.children) ? el.props.children : [el.props.children]).map((opt) => String(opt?.props?.children ?? ''))
const projectSelects = (mini) => {
  const selects = mini.nodes().filter((el) => el.type === 'select')
  const project = selects.find((el) => optionsOf(el).some((text) => text.includes('当前工作区')))
  const platform = selects.find((el) => optionsOf(el).some((text) => text.includes('端…')))
  return { project, platform }
}

test('行为：点「读信息」把文档里认出的**项目**回填到项目行（且带出端）', async () => {
  const fetchStub = makeFetch()
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-doc' })
  await mini.act(root)
  await openCreateForm(mini, root)

  // 文档链接那行填上 URL，再点「读信息」
  const urlInput = mini.inputs().find((el) => String(el.props.value ?? '') === '' && /URL|链接|http/i.test(String(el.props.placeholder ?? '')))
  assert.ok(urlInput, '表单里要有文档链接输入框')
  await mini.act(root, () => urlInput.props.onChange({ target: { value: 'https://doc.example/6102' } }))
  const read = mini.findButtons('读信息')[0]
  assert.ok(read, '文档行要有「读信息」按钮')
  await mini.act(root, () => read.props.onClick())

  const { project, platform } = projectSelects(mini)
  assert.ok(project, '项目行要有「项目」下拉')
  assert.ok(platform, '项目行要有「端」下拉')
  assert.equal(project.props.value, 'demo-app', '项目回填成文档里认出的那个')
  assert.equal(platform.props.value, 'APP', '端回填（文档只指向 APP 端）')

  // 反馈文案要说清自动填了什么
  assert.match(mini.texts(), /读信息成功/)
  assert.match(mini.texts(), /已自动填入：项目 demo-app（端 APP）/)
})

test('行为：文档写了多端 → 项目照样回填，端**不猜**（提示自己选）', async () => {
  const fetchStub = makeFetch({
    ok: true,
    title: '【6103】PC 与 APP 都要改',
    roles: {},
    uiLinks: [],
    targets: { platforms: ['PC', 'APP'], strongPlatforms: ['PC', 'APP'], projectTokens: ['demo-app'], strongProjectTokens: ['demo-app'] },
    source: 'local',
  })
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-doc' })
  await mini.act(root)
  await openCreateForm(mini, root)
  const urlInput = mini.inputs().find((el) => String(el.props.value ?? '') === '' && /URL|链接|http/i.test(String(el.props.placeholder ?? '')))
  await mini.act(root, () => urlInput.props.onChange({ target: { value: 'https://doc.example/6103' } }))
  await mini.act(root, () => mini.findButtons('读信息')[0].props.onClick())

  const { project, platform } = projectSelects(mini)
  assert.equal(project.props.value, 'demo-app')
  assert.equal(platform.props.value, '', '多端时不猜端')
  assert.match(mini.texts(), /多端，端请自己选/)
})

test('行为：文档认不出任何已知项目 → 项目行保持原样，不报错', async () => {
  const fetchStub = makeFetch({
    ok: true,
    title: '【6104】某个需求',
    roles: {},
    uiLinks: [],
    targets: { platforms: ['PC'], strongPlatforms: ['PC'], projectTokens: ['unknown-repo'], strongProjectTokens: ['unknown-repo'] },
    source: 'local',
  })
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-doc' })
  await mini.act(root)
  await openCreateForm(mini, root)
  const urlInput = mini.inputs().find((el) => String(el.props.value ?? '') === '' && /URL|链接|http/i.test(String(el.props.placeholder ?? '')))
  await mini.act(root, () => urlInput.props.onChange({ target: { value: 'https://doc.example/6104' } }))
  await mini.act(root, () => mini.findButtons('读信息')[0].props.onClick())

  assert.match(mini.texts(), /读信息成功/, '标题照样读回来，不因为认不出项目就失败')
  const { project } = projectSelects(mini)
  assert.equal(project.props.value, '', '认不出就不动项目行')
})
