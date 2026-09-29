/**
 * 一条需求在**多个项目**里开发，每个项目自带「端」（PC / APP…）。
 *
 * 用户诉求（原话要点）：
 *   · 对应项目文件要能多设置 —— 有些需求要在多个项目里开发；
 *   · 卡片里可以点不同项目选中，开新会话按不同项目进；
 *   · 不同项目加不同的端，新会话提示词要**明确做 PC 还是 APP 端**；
 *   · **不要把需求里无效的部分**（属于另一端的资料）塞进提示词。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { afterEach, beforeEach, test } from 'node:test'
import { buildRequirementBrief, briefPlatformSlice, normPlatform } from '../lib/brief.js'
import { buildTools } from '../lib/tools.js'
import { captureApi, callApi, openStore, useTempHome } from './helpers.js'

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

async function seedMultiProject() {
  return store.saveRequirement({
    id: 'SPMS-5922',
    title: 'Queue 数据记录',
    status: 'planning',
    product: '张三',
    creator: 'Li Si',
    readTitle: false,
    projects: [
      { project: 'spms-pc', platform: 'PC', root: '/tmp/work/spms-pc' },
      { project: 'spms-app', platform: 'APP', root: '/tmp/work/spms-app' },
    ],
    links: [
      { kind: 'doc', url: 'https://doc.example/5922', title: '需求文档' },
      { kind: 'design', url: 'https://design.example/api', title: '后端设计' },
      { kind: 'ui', url: 'https://figma.example/pc', title: 'PC端' },
      { kind: 'ui', url: 'https://figma.example/app', title: 'APP端' },
    ],
  })
}

test('多项目：第一条是主项目，镜像回 project_id；按任一项目都能筛到', async () => {
  await seedMultiProject()
  const projects = store.listRequirementProjects('SPMS-5922')
  assert.equal(projects.length, 2)
  assert.equal(projects[0].projectId, 'spms-pc')
  assert.equal(projects[0].primary, true)
  assert.equal(projects[0].platform, 'PC')
  assert.equal(projects[1].projectId, 'spms-app')
  assert.equal(projects[1].platform, 'APP')
  assert.equal(store.getRequirement('SPMS-5922').project_id, 'spms-pc', '主项目镜像')

  assert.equal(store.listRequirements({ project: 'spms-pc' }).total, 1)
  assert.equal(store.listRequirements({ project: 'spms-app' }).total, 1, '挂在副项目上也要筛得到')
  assert.equal(store.search({ project: 'spms-app' }).requirementTotal, 1)
})

test('多项目：整体替换；换成单项目后主项目镜像跟着走', async () => {
  await seedMultiProject()
  const res = store.setRequirementProjects('SPMS-5922', [{ project: 'spms-app', platform: 'APP' }])
  assert.equal(res.ok, true)
  assert.equal(res.projects.length, 1)
  assert.equal(store.getRequirement('SPMS-5922').project_id, 'spms-app')
  // 空数组 = 清掉挂载，但**不动**主项目镜像（避免把需求变成孤儿）
  store.setRequirementProjects('SPMS-5922', [])
  assert.equal(store.listRequirementProjects('SPMS-5922').length, 0)
  assert.equal(store.getRequirement('SPMS-5922').project_id, 'spms-app')
  assert.equal(store.setRequirementProjects('SPMS-9999', []).ok, false, '不存在的需求要拒绝')
})

test('端归一化：PC/PC端/web 同类，APP/App端/移动端/安卓 同类', () => {
  assert.equal(normPlatform('PC端'), 'PC')
  assert.equal(normPlatform('pc'), 'PC')
  assert.equal(normPlatform('web'), 'PC')
  assert.equal(normPlatform('APP'), 'APP')
  assert.equal(normPlatform('App端'), 'APP')
  assert.equal(normPlatform('移动端'), 'APP')
  assert.equal(normPlatform('安卓'), 'APP')
  assert.equal(normPlatform('服务端'), '服务端')
  assert.equal(normPlatform(''), null)
})

test('按端裁剪：本端的与没标端的都留，另一端的剔除并报出来', async () => {
  await seedMultiProject()
  // ⚠️ getRequirement 返回原始行，links 要用 listLinks（或 attachLinksOne）取
  const links = store.listLinks('SPMS-5922')
  const app = briefPlatformSlice(links, 'APP')
  assert.equal(app.included.map((l) => l.title).join('|'), '后端设计|需求文档|APP端', '顺序跟随 listLinks（kind 字母序）')
  assert.equal(app.excluded.map((l) => l.title).join('|'), 'PC端')
  assert.equal(app.labels.join('|'), 'PC端')

  const pc = briefPlatformSlice(links, 'PC')
  assert.equal(pc.included.map((l) => l.title).join('|'), '后端设计|需求文档|PC端')
  assert.equal(pc.excluded.map((l) => l.title).join('|'), 'APP端')

  // 没指定端时不做裁剪（老行为）
  assert.equal(briefPlatformSlice(links, null).included.length, 4)

  // 回归：标题里「含」端名但本身是通用资料（如《后端设计》）不能被误剔
  const generic = [
    { title: '后端设计', kind: 'design', url: 'https://design.example/api' },
    { title: 'PC端', url: 'https://figma.example/pc' },
    { title: '移动端', url: 'https://figma.example/m' },
  ]
  const app2 = briefPlatformSlice(generic, 'APP')
  assert.equal(app2.included.map((l) => l.title).join('|'), '后端设计|移动端')
  assert.equal(app2.excluded.map((l) => l.title).join('|'), 'PC端')
})

test('简报：按项目进 → 写死「本次只做 X 端」，另一端资料不进提示词', async () => {
  await seedMultiProject()
  const app = buildRequirementBrief(store, 'SPMS-5922', { project: 'spms-app' })
  assert.equal(app.platform, 'APP')
  assert.match(app.brief, /本次开发项目：spms-app（工作目录 \/tmp\/work\/spms-app）/)
  assert.match(app.brief, /本次只做：APP 端/)
  assert.match(app.brief, /https:\/\/figma\.example\/app/)
  assert.ok(!app.brief.includes('https://figma.example/pc'), 'PC 端的设计稿不能进 APP 端提示词')
  assert.match(app.brief, /另有 1 条属于 PC端 的资料\*\*本次不用看\*\*/)
  assert.match(app.brief, /本次只做 \*\*APP 端\*\* 的开发/)
  assert.match(app.brief, /不要实现、不要照抄/)
  assert.match(app.brief, /这条需求还挂在其它项目\/端上/)

  const pc = buildRequirementBrief(store, 'SPMS-5922', { project: 'spms-pc' })
  assert.equal(pc.platform, 'PC')
  assert.match(pc.brief, /本次只做：PC 端/)
  assert.ok(!pc.brief.includes('https://figma.example/app'))
  assert.ok(pc.brief.includes('https://figma.example/pc'))
})

test('简报：不传项目时用主项目（及其端）；显式 platform 可覆盖', async () => {
  await seedMultiProject()
  const primary = buildRequirementBrief(store, 'SPMS-5922')
  assert.equal(primary.platform, 'PC', '主项目 spms-pc 的端是 PC')
  const forced = buildRequirementBrief(store, 'SPMS-5922', { platform: 'APP' })
  assert.equal(forced.platform, 'APP')
  assert.match(forced.brief, /本次只做：APP 端/)
})

test('工具：ph_brief 支持 project / platform', async () => {
  await seedMultiProject()
  const app = await byName.get('ph_brief').execute({ id: 'SPMS-5922', project: 'spms-app' })
  assert.equal(app.platform, 'APP')
  assert.match(app.text, /本次只做：APP 端/)
  const pc = await byName.get('ph_brief').execute({ id: 'SPMS-5922', platform: 'PC' })
  assert.equal(pc.platform, 'PC')

  const saved = await byName.get('ph_save_requirement').execute({
    id: 'SPMS-6001',
    title: '多项目保存',
    readTitle: false,
    projects: [
      { project: 'spms-pc', platform: 'PC' },
      { project: 'spms-app', platform: 'APP' },
    ],
  })
  assert.equal(saved.created, true)
  assert.match(saved.text, /项目（多项目，第一条是主项目）：spms-pc·PC、spms-app·APP/)
  const got = await byName.get('ph_get_requirement').execute({ id: 'SPMS-6001' })
  assert.match(got.text, /spms-pc·PC（主）/)
})

test('API：/requirements/projects 读写 + /open-session 按项目与端出提示词', async () => {
  await seedMultiProject()

  const list = await callApi(api.handler, { method: 'GET', url: `${BASE}/requirements/projects?id=SPMS-5922` })
  assert.equal(list.statusCode, 200)
  assert.equal(list.json.projects.length, 2)
  assert.equal(list.json.projects[1].platform, 'APP')

  const set = await callApi(api.handler, {
    method: 'POST',
    url: `${BASE}/requirements/projects`,
    body: { id: 'SPMS-5922', projects: [{ project: 'spms-app', platform: 'APP' }, { project: 'spms-pc', platform: 'PC' }] },
  })
  assert.equal(set.statusCode, 200)
  assert.equal(set.json.projects[0].projectId, 'spms-app', '顺序即主项目')

  const noId = await callApi(api.handler, { method: 'POST', url: `${BASE}/requirements/projects`, body: {} })
  assert.equal(noId.statusCode, 400)

  // open-session：按 APP 项目 → 提示词只讲 APP 端
  const app = await callApi(api.handler, { method: 'POST', url: `${BASE}/open-session`, body: { id: 'SPMS-5922', project: 'spms-app' } })
  assert.equal(app.statusCode, 200)
  assert.equal(app.json.platform, 'APP')
  assert.equal(app.json.project.id, 'spms-app')
  assert.match(app.json.prompt, /本次只做 \*\*APP 端\*\* 的开发/)
  assert.ok(!app.json.prompt.includes('https://figma.example/pc'))

  const pc = await callApi(api.handler, { method: 'POST', url: `${BASE}/open-session`, body: { id: 'SPMS-5922', project: 'spms-pc' } })
  assert.equal(pc.json.platform, 'PC')
  assert.match(pc.json.prompt, /本次只做 \*\*PC 端\*\* 的开发/)
  assert.ok(!pc.json.prompt.includes('https://figma.example/app'))

  // /brief 也认 project / platform
  const viaBrief = await callApi(api.handler, { method: 'GET', url: `${BASE}/brief?id=SPMS-5922&project=spms-app` })
  assert.equal(viaBrief.json.platform, 'APP')
})

test('API：open-session 的项目目录来自该项目自己的 root', async () => {
  await seedMultiProject()
  const calls = []
  api = captureApi(store, {
    version: 'x',
    ensureWorkspace: async (path, title) => {
      calls.push([path, title])
      return { id: `ws-${title}`, path, title }
    },
  })
  const app = await callApi(api.handler, { method: 'POST', url: `${BASE}/open-session`, body: { id: 'SPMS-5922', project: 'spms-app' } })
  assert.equal(app.json.canCreate, true)
  assert.equal(calls[0][0], '/tmp/work/spms-app', '要用 APP 项目自己的目录，不是主项目的')
  const pc = await callApi(api.handler, { method: 'POST', url: `${BASE}/open-session`, body: { id: 'SPMS-5922', project: 'spms-pc' } })
  assert.equal(calls[1][0], '/tmp/work/spms-pc')
  assert.equal(pc.json.workspace.id, 'ws-spms-pc')
})

test('客户端：chooseProject —— 点过的优先，其次主项目，最后第一个', () => {
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
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
  const { chooseProject, PLATFORM_CHOICES } = captured.factory(() => React).__test
  const list = [
    { projectId: 'spms-pc', platform: 'PC', primary: true },
    { projectId: 'spms-app', platform: 'APP', primary: false },
  ]
  assert.equal(chooseProject(list, 'spms-app').projectId, 'spms-app', '点过的优先')
  assert.equal(chooseProject(list, null).projectId, 'spms-pc', '没点过 → 主项目')
  assert.equal(chooseProject(list, '不存在').projectId, 'spms-pc', '点了不存在的 → 回落主项目')
  assert.equal(chooseProject([{ projectId: 'only' }], null).projectId, 'only')
  assert.equal(chooseProject([], 'x'), null)
  assert.deepEqual([...PLATFORM_CHOICES].slice(0, 2), ['PC', 'APP'])
})

test('复制按钮用 GET /brief：只渲染提示词，不登记 workspace、不开会话', async () => {
  await seedMultiProject()
  const calls = []
  api = captureApi(store, {
    version: 'x',
    ensureWorkspace: async (path, title) => {
      calls.push(path)
      return { id: 'ws', path, title }
    },
  })
  const res = await callApi(api.handler, { method: 'GET', url: `${BASE}/brief?id=SPMS-5922&project=spms-app` })
  assert.equal(res.statusCode, 200)
  assert.match(res.json.brief, /本次只做 \*\*APP 端\*\* 的开发/)
  assert.equal(res.json.platform, 'APP')
  assert.equal(calls.length, 0, '复制路径不得建 workspace / 开会话（与 /open-session 的区别就在这）')

  // 对照：/open-session 会去登记 workspace（真开会的路径）
  await callApi(api.handler, { method: 'POST', url: `${BASE}/open-session`, body: { id: 'SPMS-5922', project: 'spms-app' } })
  assert.equal(calls.length, 1, '开会话才登记 workspace')
})
