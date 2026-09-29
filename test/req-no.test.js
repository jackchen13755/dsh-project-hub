/**
 * 需求号识别：读标题时自动填号（用户给的形态：`【5922】L&F Q3 Enhancements/Queue数据记录`）。
 *
 * 两个必须钉住的点：
 *   ① 只认「明显是号」的形态 —— 年份（`2026 Q3 规划`）不能被当成需求号；
 *   ② 客户端 `extractNoFromTitle` 是宿主 `lib/req-no.js` 的**镜像实现**（bundle 不能 import 宿主模块），
 *      两份必须同结果，否则面板填的号和宿主定的 ID 会对不上。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import vm from 'node:vm'
import { extractRequirementNo, stripRequirementNo } from '../lib/req-no.js'
import { openStore, useTempHome } from './helpers.js'

const here = dirname(fileURLToPath(import.meta.url))
let tmp = null

beforeEach(() => {
  tmp = useTempHome()
})

afterEach(() => {
  tmp?.restore()
  tmp = null
})

const CASES = [
  ['【5922】L&F Q3 Enhancements/Queue数据记录', '5922'],
  ['【5921】Profile Search/Create/Edit 需求变更', '5921'],
  ['[5921] 房态看板改造', '5921'],
  ['（6031）Profile Search', '6031'],
  ['(7001) 移动端改版', '7001'],
  ['SPMS-5921 房态看板改造', '5921'],
  ['spms-5921 房态看板改造', '5921'],
  ['#5921 看板', '5921'],
  ['5921 房态看板改造', '5921'],
  ['5921-房态看板改造', '5921'],
  ['5921', '5921'],
  ['L&F Q3 Enhancements', null],
  ['2026 Q3 规划', null],
  ['Q3 2026 目标', null],
  ['', null],
  [null, null],
]

test('extractRequirementNo：认 6 种带号形态，年份不误判', () => {
  for (const [title, expected] of CASES) {
    assert.equal(extractRequirementNo(title), expected, `标题 ${JSON.stringify(title)}`)
  }
})

test('stripRequirementNo：洗掉号剩下正文', () => {
  assert.equal(stripRequirementNo('【5922】L&F Q3 Enhancements/Queue数据记录'), 'L&F Q3 Enhancements/Queue数据记录')
  assert.equal(stripRequirementNo('SPMS-5921 房态看板'), '房态看板')
  assert.equal(stripRequirementNo('#5921 看板'), '看板')
  assert.equal(stripRequirementNo('L&F Q3 Enhancements'), 'L&F Q3 Enhancements')
})

test('saveRequirement：没给需求号时，用读到的标题定 ID', async () => {
  const store = openStore()
  try {
    // ① 调用方直接给标题（等价于「读标题已成功」）→ 自动定 ID 与 no
    const auto = await store.saveRequirement({
      project: 'spms',
      docUrl: 'https://doc.example/5922',
      docTitle: '【5922】L&F Q3 Enhancements/Queue数据记录',
      readTitle: false,
    })
    assert.equal(auto.requirement.id, 'SPMS-5922')
    assert.equal(auto.requirement.no, '5922')
    assert.equal(auto.noFromTitle, '5922')
    assert.equal(auto.requirement.title, '【5922】L&F Q3 Enhancements/Queue数据记录', '标题原样保留')

    // ② 显式给的 no 优先，不会被标题覆盖
    const explicit = await store.saveRequirement({
      project: 'spms',
      no: '8888',
      docUrl: 'https://doc.example/x',
      docTitle: '【5922】另一个标题',
      readTitle: false,
    })
    assert.equal(explicit.requirement.id, 'SPMS-8888')
    assert.equal(explicit.noFromTitle, null)

    // ③ 显式给的 id 优先
    const byId = await store.saveRequirement({
      id: 'SPMS-777',
      project: 'spms',
      docUrl: 'https://doc.example/y',
      docTitle: '【5922】标题',
      readTitle: false,
    })
    assert.equal(byId.requirement.id, 'SPMS-777')

    // ④ 标题里只有年份 → 不认号，退回「缺号」的报错，而不是造一个 SPMS-2026
    await assert.rejects(
      () => store.saveRequirement({ project: 'spms', docUrl: 'https://doc.example/z', docTitle: '2026 Q3 规划', readTitle: false }),
      /缺少需求 ID/,
    )
  } finally {
    store.close()
  }
})

test('客户端镜像实现 extractNoFromTitle 与宿主 lib/req-no.js 同结果', () => {
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
  const { extractNoFromTitle, fmtClock } = captured.factory(() => React).__test

  for (const [title, expected] of CASES) {
    assert.equal(extractNoFromTitle(title), expected, `镜像实现也要认：${JSON.stringify(title)}`)
    assert.equal(extractNoFromTitle(title), extractRequirementNo(title), '两份实现必须同结果')
  }
  assert.equal(fmtClock(Date.parse('2026-09-29T14:03:05')), '14:03:05')
  assert.equal(fmtClock(null), '')
})

test('章节页编号不许被当成需求号（文档树回归：01-Service360需求文档 / 11 Housekeeping / 32 CEPT）', () => {
  // 实测踩到：这些章节页标题里的"首位数字"曾被认成需求号 11 / 32，会把章节编号写进台账
  assert.equal(extractRequirementNo('01-Service360需求文档'), null)
  assert.equal(extractRequirementNo('11  Housekeeping'), null)
  assert.equal(extractRequirementNo('32 CEPT'), null)
  assert.equal(extractRequirementNo('11 Housekeeping 改造'), null)
  // 带标记的短号仍然认（明确写了标记就不猜）
  assert.equal(extractRequirementNo('#582 小改动'), '582')
  assert.equal(extractRequirementNo('【12】某某'), '12')
  // 4–6 位裸号照旧认
  assert.equal(extractRequirementNo('5921 房态看板改造'), '5921')
  assert.equal(extractRequirementNo('5921-房态看板改造'), '5921')
  assert.equal(extractRequirementNo('55716 支付方式'), '55716')
})
