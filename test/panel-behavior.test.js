/**
 * 面板**行为级**回归：用 `test/mini-react.js` 里的极简 hooks 运行时把真面板跑起来，
 * 再用假 fetch 驱动真实交互，断言的是**用户报的症状本身**：
 *   · 输入关键词后不点「查询」不发请求；点了「查询」就按新条件查（旧的"点了没反应"）；
 *   · 切 tab 条件互不串（扫描 / 日志 / 需求各存各的）；
 *   · 有翻页（offset 真的发给服务端；换条件 / 换每页条数回第 1 页）；
 *   · 请求进行中有 loading；
 *   · 慢的旧响应不许覆盖新结果。
 *
 * 基线证据：这 5 条在改动前的 `lib/client.js`（HEAD 版）上是 **0/5 通过**，改动后 5/5 —— 即这批用例
 * 真的钉住了这次修的 bug（不是「顺手补的测试」）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFetchStub, mountPanel, queryOf } from './mini-react.js'

test('行为：输入不点查询不发请求；点「查询」才按新条件查（旧的"点了没反应"）', async () => {
  const fetchStub = createFetchStub()
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-behavior' })

  await mini.act(root)
  const first = fetchStub.callsTo('/requirements')
  assert.equal(first.length, 1, '挂载后按默认条件查一次')
  assert.equal(queryOf(first[0]).get('limit'), '20', '默认每页 20 条')
  assert.equal(queryOf(first[0]).get('offset'), '0')

  // ① 在搜索框里打字 → **不该**发请求（旧实现每敲一个字就发一次，点按钮反而看不出变化）
  const search = mini.findInput('搜索需求')
  assert.ok(search, '需求 tab 要有搜索框')
  await mini.act(root, () => search.props.onChange({ target: { value: '看板' } }))
  assert.equal(fetchStub.callsTo('/requirements').length, 1, '只改输入框不发请求')

  // ② 点「查询」→ 用新关键词发请求，并给出「共 N 条」的反馈
  const queryBtn = mini.findButton('查询')
  assert.ok(queryBtn, '要有「查询」按钮')
  await mini.act(root, () => queryBtn.props.onClick())
  const afterQuery = fetchStub.callsTo('/requirements')
  assert.equal(afterQuery.length, 2, '点「查询」必须真的发请求')
  assert.equal(queryOf(afterQuery[1]).get('q'), '看板', '请求要带刚输入的关键词')
  assert.equal(queryOf(afterQuery[1]).get('offset'), '0', '换条件要回到第 1 页')
  assert.ok(mini.texts().includes('共 5 条'), `要有查询结果反馈（共 N 条），实际：${mini.texts().slice(0, 200)}`)

  // ③ 条件没变、又在第 1 页时再点「查询」→ 不重复发请求（按钮不再 disabled，靠这条节流）
  await mini.act(root, () => mini.findButton('查询').props.onClick())
  assert.equal(fetchStub.callsTo('/requirements').length, 2, '同条件重复点「查询」不重复请求')
})

test('行为：切 tab 条件互不串（扫描/日志的日期不会互相带过去）', async () => {
  const fetchStub = createFetchStub()
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-behavior' })

  await mini.act(root)

  // 需求 tab 输入关键词并查询
  await mini.act(root, () => mini.findInput('搜索需求').props.onChange({ target: { value: '5941' } }))
  await mini.act(root, () => mini.findButton('查询').props.onClick())
  assert.equal(queryOf(fetchStub.callsTo('/requirements').at(-1)).get('q'), '5941')

  // 切到开发日志：不许带需求 tab 的关键词
  await mini.act(root, () => mini.findButton('开发日志').props.onClick())
  const logs = fetchStub.callsTo('/logs')
  assert.equal(logs.length, 1, '切 tab 会按该 tab 自己的条件查一次')
  assert.equal(queryOf(logs[0]).get('q'), null, '日志 tab 不该带需求 tab 的关键词')
  assert.equal(queryOf(logs[0]).get('from'), null, '日志 tab 自己没设日期')

  // 日志 tab 设日期 → 输入框里变，但**要点「查询」才生效**（和需求 tab 一个模型）
  const dateInputs = mini.inputs().filter((el) => el.props.type === 'date')
  await mini.act(root, () => dateInputs[0].props.onChange({ target: { value: '2026-10-01' } }))
  assert.equal(fetchStub.callsTo('/logs').length, 1, '改日期框本身不发请求')
  await mini.act(root, () => mini.findButton('查询').props.onClick())
  assert.equal(queryOf(fetchStub.callsTo('/logs').at(-1)).get('from'), '2026-10-01', '点查询后带上日期')

  // 切回需求 tab：需求 tab 自己的关键词还在，且日志 tab 的日期**没**串过来
  await mini.act(root, () => mini.findButton('需求台账').props.onClick())
  const reqLast = fetchStub.callsTo('/requirements').at(-1)
  assert.equal(queryOf(reqLast).get('q'), '5941', '切回来条件还在（原来这里才是"生效"的假象）')
  assert.equal(queryOf(reqLast).get('from'), null, '日志 tab 的日期不许串进需求 tab')

  // 会话扫描 tab 的日期也不会串进日志 tab
  await mini.act(root, () => mini.findButton('会话扫描').props.onClick())
  assert.equal(fetchStub.callsTo('/report').length, 1)
  await mini.act(root, () => mini.findButton('开发日志').props.onClick())
  assert.equal(queryOf(fetchStub.callsTo('/logs').at(-1)).get('from'), '2026-10-01', '日志 tab 自己的日期保持不变')
})

test('行为：翻页把 offset 发给服务端；条件变化回到第 1 页', async () => {
  const fetchStub = createFetchStub({ total: 45 })
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-behavior' })

  await mini.act(root)
  assert.ok(mini.texts().includes('共 45 条'), '要显示服务端总数')
  assert.ok(mini.texts().includes('第 1/3 页'), `要显示页码，实际：${mini.texts().slice(0, 240)}`)

  await mini.act(root, () => mini.findButton('下一页').props.onClick())
  const page2 = fetchStub.callsTo('/requirements').at(-1)
  assert.equal(queryOf(page2).get('offset'), '20', '第 2 页 = offset 20')
  assert.ok(mini.texts().includes('第 2/3 页'))

  await mini.act(root, () => mini.findButton('上一页').props.onClick())
  assert.equal(queryOf(fetchStub.callsTo('/requirements').at(-1)).get('offset'), '0', '回到第 1 页')

  // 换每页条数 → 重新从第 1 页查
  await mini.act(root, () => mini.findButton('下一页').props.onClick())
  const sizeSelect = mini.nodes().find((el) => el.type === 'select' && el.props.title === '每页条数')
  assert.ok(sizeSelect, '要有「每页条数」选择')
  await mini.act(root, () => sizeSelect.props.onChange({ target: { value: '50' } }))
  const resized = fetchStub.callsTo('/requirements').at(-1)
  assert.equal(queryOf(resized).get('limit'), '50')
  assert.equal(queryOf(resized).get('offset'), '0', '换每页条数后回第 1 页')
})

test('行为：请求进行中有 loading（按钮 + 列表区都看得出来）', async () => {
  const fetchStub = createFetchStub()
  fetchStub.hang('/logs')
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-behavior' })

  await mini.act(root)
  // 切到日志 tab：/logs 挂起不返回
  await mini.act(root, () => mini.findButton('开发日志').props.onClick())
  const during = mini.texts()
  assert.ok(during.includes('正在查询…'), `请求中要有 loading 文案，实际：${during.slice(0, 260)}`)
  assert.ok(!during.includes('共 0 条'), 'loading 中不许先报一个假的「共 0 条」（总数还没回来）')

  // 放开挂起的请求 → loading 消失，结果 + 总数落地
  assert.equal(fetchStub.release(), 1)
  await mini.act(root)
  const after = mini.texts()
  assert.ok(!after.includes('正在查询…'), '请求结束后 loading 要消失')
  assert.ok(after.includes('共 42 条'), `日志 tab 也要显示总数，实际：${after.slice(0, 260)}`)
})

test('行为：过期响应不许覆盖新结果（慢的旧请求晚到）', async () => {
  // 第 1 次 /requirements 挂起（total=5），第 2 次立刻返回（total=7）
  const fetchStub = createFetchStub({ totalsByCall: [5, 7] })
  fetchStub.hang('/requirements')
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-behavior' })

  await mini.act(root) // 第 1 次请求挂起中
  await mini.act(root, () => mini.findInput('搜索需求').props.onChange({ target: { value: '看板' } }))
  await mini.act(root, () => mini.findButton('查询').props.onClick()) // 第 2 次请求，立刻返回
  assert.ok(mini.texts().includes('共 7 条'), `新结果先落地：${mini.texts().slice(0, 200)}`)

  // 慢的旧请求这时才回来 → 不许把列表/总数改回去
  assert.equal(fetchStub.release(1), 1)
  await mini.act(root)
  assert.ok(mini.texts().includes('共 7 条'), '过期响应必须被丢弃（不能覆盖新结果）')
  assert.ok(!mini.texts().includes('共 5 条'), '旧请求的总数不许回写')
})

test('行为：条件改了没点查询 → 界面明说「条件已改」（否则分不清生效没有）', async () => {
  const fetchStub = createFetchStub()
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-behavior' })
  await mini.act(root)

  assert.ok(!mini.texts().includes('条件已改'), '刚挂载（没改动）不该有脏提示')
  await mini.act(root, () => mini.findInput('搜索需求').props.onChange({ target: { value: '看板' } }))
  assert.ok(mini.texts().includes('条件已改，点「查询」生效'), `改完要提示：${mini.texts().slice(0, 240)}`)
  // 查询按钮此时应该被高亮成 primary（可点，且不再是灰的）
  const queryBtn = mini.findButton('查询')
  assert.ok(!queryBtn.props.disabled, '查询按钮不许因为 loading 被禁用（序号守卫已能处理重复点）')
  // Btn 用 primary 选样式（不外传 primary），所以看边框色：高亮 = 主题色
  assert.match(String(queryBtn.props.style.border), /brand-1/, '有未应用的改动时「查询」要高亮成主题色')

  await mini.act(root, () => queryBtn.props.onClick())
  assert.ok(!mini.texts().includes('条件已改'), '点了查询后脏提示消失')
  assert.ok(mini.texts().includes('✓ 5 条'), `要点出条数 + 时间：${mini.texts().slice(0, 240)}`)
})

test('行为：查不到时说的是「没有匹配 xxx」，不是「还没有需求记录」', async () => {
  const fetchStub = createFetchStub({ total: 0 })
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-behavior' })
  await mini.act(root)
  // 默认条件（空）→ 空库口径
  assert.ok(mini.texts().includes('还没有需求记录'), `空库口径：${mini.texts().slice(0, 200)}`)

  await mini.act(root, () => mini.findInput('搜索需求').props.onChange({ target: { value: '不存在的需求' } }))
  await mini.act(root, () => mini.findButton('查询').props.onClick())
  const texts = mini.texts()
  assert.ok(texts.includes('没有匹配 「不存在的需求」 的需求'), `要带上条件：${texts.slice(0, 240)}`)
  assert.ok(mini.findButton('清掉条件'), '空结果要给「清掉条件」的出口')
})

test('行为：页码越界自动夹回最后一页（删数据 / 换条件后不停在空白页）', async () => {
  // 第一次查 total=45（3 页），翻到第 3 页时服务端只剩 5 条（1 页）
  const fetchStub = createFetchStub({ totalsByCall: [45, 45, 45, 5] })
  const { mini, renderPanel } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: 'session-behavior' })
  await mini.act(root)

  await mini.act(root, () => mini.findButton('下一页').props.onClick())
  assert.ok(mini.texts().includes('第 2/3 页'))
  await mini.act(root, () => mini.findButton('下一页').props.onClick())
  assert.ok(mini.texts().includes('第 3/3 页'))
  // 数据变少（有人在别处删了需求）：刷一次 → 服务端说只剩 5 条（1 页），此时页码还停在第 3 页
  await mini.act(root, () => mini.findButton('刷新').props.onClick())
  const offsets = fetchStub.callsTo('/requirements').map((url) => queryOf(url).get('offset'))
  assert.equal(offsets.at(-1), '0', `越界后要夹回第 1 页重查，实际 offsets=${offsets.join(',')}`)
  assert.ok(mini.texts().includes('第 1/1 页'), '页码要回到第 1/1 页')
})

test('行为：轮询（无 sessionId 时每 60 秒）刷新数据，但不闪 loading、不吞点击', async () => {
  const fetchStub = createFetchStub()
  const { mini, renderPanel, tickTimers } = mountPanel(fetchStub)
  const root = () => renderPanel({ sessionId: null }) // 无 sessionId → 轮询开启
  await mini.act(root)
  const before = fetchStub.calls.length

  assert.equal(tickTimers(), 1, '应当注册了一个轮询定时器')
  await mini.act(root)
  assert.ok(fetchStub.calls.length > before, '轮询确实会重新拉数据')
  assert.ok(!mini.texts().includes('正在查询…'), '轮询不该点亮 loading（否则面板每 60 秒自己闪一下）')
  assert.ok(!mini.findButton('查询').props.disabled, '轮询期间查询按钮不许被禁用')
})
