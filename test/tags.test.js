/**
 * 标签：聚合（下拉选项 / 输入补全的数据源）、整词筛选、以及「点标签即筛」背后的纯函数。
 *
 * 为什么要有这层：标签以前只能被搜索框顺带命中，不能筛。现在
 *   ① `listTags()` 给出「用过的标签 + 条数」（按条数降序）；
 *   ② `listRequirements({tag})` 做**整词**匹配 —— `评审` 不会命中 `待评审`；
 *   ③ 面板下拉、卡片标签、表单补全都用同一份数据，口径一致。
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

test('listTags：聚合去重、按条数降序、可带项目/归档口径', async () => {
  await store.saveRequirement({ id: 'SPMS-1', project: 'spms', title: 'A', readTitle: false, tags: '待评审, 前端' })
  await store.saveRequirement({ id: 'SPMS-2', project: 'spms', title: 'B', readTitle: false, tags: ['待评审', '接口'] })
  await store.saveRequirement({ id: 'HS-CONFIG-3', project: 'hs_config', title: 'C', readTitle: false, tags: ['评审'] })

  const all = store.listTags({})
  assert.deepEqual(all.map((t) => `${t.tag}×${t.count}`), ['待评审×2', '前端×1', '接口×1', '评审×1'])

  assert.equal(store.listTags({ project: 'hs_config' }).length, 1, '按项目收窄')
  assert.equal(store.listTags({ project: 'hs_config' })[0].tag, '评审')

  store.archiveRequirement('HS-CONFIG-3', true)
  assert.equal(store.listTags({}).some((t) => t.tag === '评审'), false, '默认不含归档项')
  assert.equal(store.listTags({ archived: 'only' })[0].tag, '评审', '归档视图下只看归档项的标签')
  assert.equal(store.listTags({ archived: 'include' }).some((t) => t.tag === '评审'), true)

  // 没有标签的需求不产生空标签
  await store.saveRequirement({ id: 'SPMS-4', project: 'spms', title: 'D', readTitle: false })
  assert.equal(store.listTags({ archived: 'include' }).some((t) => t.tag === ''), false)
})

test('listRequirements({tag})：整词匹配，不是子串', async () => {
  await store.saveRequirement({ id: 'SPMS-1', project: 'spms', title: 'A', readTitle: false, tags: '待评审,前端' })
  await store.saveRequirement({ id: 'SPMS-2', project: 'spms', title: 'B', readTitle: false, tags: ['评审'] })
  await store.saveRequirement({ id: 'SPMS-3', project: 'spms', title: 'C', readTitle: false, tags: ['前端框架'] })

  assert.equal(store.listRequirements({ tag: '待评审' }).total, 1)
  assert.equal(store.listRequirements({ tag: '评审' }).total, 1, '「评审」不能命中「待评审」')
  assert.equal(store.listRequirements({ tag: '前端' }).total, 1, '「前端」不能命中「前端框架」')
  assert.equal(store.listRequirements({ tag: '前端框架' }).total, 1)
  assert.equal(store.listRequirements({ tag: '不存在的标签' }).total, 0)
  assert.equal(store.listRequirements({}).total, 3, '不传 tag 时不受影响')
  assert.equal(store.search({ tag: '评审' }).requirementTotal, 1, 'search 也认 tag')
})

test('API：GET /requirements/tags 与 ?tag= （含 400 前的空态）', async () => {
  const empty = await callApi(api.handler, { method: 'GET', url: `${BASE}/requirements/tags` })
  assert.equal(empty.statusCode, 200)
  assert.deepEqual(empty.json.tags, [], '没有任何需求时返回空数组，不是 500')

  await callApi(api.handler, {
    method: 'POST',
    url: `${BASE}/requirements/save`,
    body: { id: 'SPMS-1', project: 'spms', title: 'A', readTitle: false, tags: ['待评审', '前端'] },
  })
  await callApi(api.handler, {
    method: 'POST',
    url: `${BASE}/requirements/save`,
    body: { id: 'SPMS-2', project: 'spms', title: 'B', readTitle: false, tags: ['待评审'] },
  })

  const tags = await callApi(api.handler, { method: 'GET', url: `${BASE}/requirements/tags` })
  assert.equal(tags.statusCode, 200)
  assert.equal(tags.json.tags[0].tag, '待评审')
  assert.equal(tags.json.tags[0].count, 2)

  const filtered = await callApi(api.handler, { method: 'GET', url: `${BASE}/requirements?tag=${encodeURIComponent('待评审')}` })
  assert.equal(filtered.json.total, 2)
  const miss = await callApi(api.handler, { method: 'GET', url: `${BASE}/requirements?tag=${encodeURIComponent('前端')}` })
  assert.equal(miss.json.total, 1)

  // 标签里塞了长 URL（实测有人这么干）时，聚合照样不崩，前端负责把它挡在建议之外
  await callApi(api.handler, {
    method: 'POST',
    url: `${BASE}/requirements/save`,
    body: { id: 'SPMS-3', project: 'spms', title: 'C', readTitle: false, tags: ['https://figma.example/design/abc?node-id=0-1'] },
  })
  const withUrl = await callApi(api.handler, { method: 'GET', url: `${BASE}/requirements/tags` })
  assert.equal(withUrl.statusCode, 200)
  assert.equal(withUrl.json.tags.length, 3)
})

// ── 客户端纯函数 ────────────────────────────────────────────────────────

function loadClientTags() {
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
  return captured.factory(() => React).__test
}

test('客户端：parseTagInput / addTagToText 认中英文逗号且不重复', () => {
  const { parseTagInput, addTagToText } = loadClientTags()
  // 跨 vm realm 的数组不能直接 deepEqual，按值比
  assert.equal(parseTagInput('待评审, 前端，接口').join('|'), '待评审|前端|接口')
  assert.equal(parseTagInput('  ').length, 0)
  assert.equal(parseTagInput(null).length, 0)
  assert.equal(parseTagInput('a,,a').join('|'), 'a', '去重')
  assert.equal(addTagToText('待评审', '前端'), '待评审, 前端')
  assert.equal(addTagToText('待评审, 前端', '待评审'), '待评审, 前端', '已存在就原样返回')
  assert.equal(addTagToText('', '前端'), '前端')
  assert.equal(addTagToText('待评审', ''), '待评审')
})

test('客户端：tagSuggestions 按用得多排序、排除已选与像 URL 的条目', () => {
  const { tagSuggestions } = loadClientTags()
  const options = [
    { tag: 'https://figma.example/design/5e4oj8CPE9KEVBXLaKH52a?node-id=0-1', count: 1 },
    { tag: '待评审', count: 5 },
    { tag: '前端', count: 3 },
    { tag: '接口', count: 3 },
    { tag: '被选中的', count: 9 },
  ]
  const picks = tagSuggestions(options, '被选中的')
  assert.equal(
    picks.map((p) => p.tag).join('|'),
    '待评审|前端|接口',
    'URL 被挡掉、已选的不再出现、按次数降序（同数按码位排序）',
  )
  assert.equal(tagSuggestions(options, '', { limit: 2 }).length, 2)
  assert.equal(tagSuggestions(null, '').length, 0)
  assert.equal(tagSuggestions([{ tag: 'x'.repeat(40), count: 1 }], '').length, 0, '超长条目也不建议')
})
