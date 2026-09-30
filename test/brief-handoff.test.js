/**
 * 开新会话的提示词要解决一个真实失败（用户 2026-09-30 反馈）：
 *
 *   「开启子 agent 时，只给了主 agent 的描述，没有直接给 UI 链接，导致子 agent 开发结果不符合 UI。」
 *
 * 根因不是"没提醒"，而是**转交时链接被描述化**：主 agent 自己看得到链接，写 subagent/expert 的 task
 * 时只写了"照设计稿做个 XX"，对方上下文里根本没有 URL。所以本用例钉的是「**把 URL 填好的现成模板**」：
 *   ① 段落在「资料链接」之后（读到链接的地方就能看到怎么把它交出去）；
 *   ② 模板正文里必须**带真实 URL**（UI 稿优先，且要是能被 copy 的干净 URL）；
 *   ③ 没登记 UI 稿时**不许让模型自己想象界面**，要写明"先问清楚找谁要"；
 *   ④ 台账里被写脏的 url 字段（`PC端：https://…《PC端》`）要截成干净 URL —— 否则转交出去的是坏链接；
 *   ⑤ 仍按「端」裁剪：PC 端的提示词里不能出现 APP 端的 UI 稿；
 *   ⑥ `handoff:false` 能整段关掉。
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { buildRequirementBrief, cleanUrl, handoffSection } from '../lib/brief.js'
import { openStore, useTempHome } from './helpers.js'

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

const FIGMA_PC = 'https://www.figma.com/design/abc/Lost---Found?node-id=405-475'
const FIGMA_APP = 'https://www.figma.com/design/abc/Lost---Found?node-id=999-111'

function seed() {
  return store.saveRequirement({
    id: 'SPMS-6001',
    no: '6001',
    title: '房态看板改造',
    readTitle: false,
    projects: [{ project: 'spms-pc', platform: 'PC', root: '/tmp/work/spms-pc' }],
    links: [
      { kind: 'doc', url: 'https://doc.example/6001', title: '需求文档' },
      { kind: 'design', url: 'https://design.example/6001', title: '后端设计' },
      { kind: 'ui', url: FIGMA_PC, title: 'PC端' },
      { kind: 'ui', url: FIGMA_APP, title: 'APP端' },
    ],
  })
}

test('转交模板在「资料链接」之后，且带**真实 UI 链接**（不是"照设计稿做"这种描述）', () => {
  seed()
  const { brief } = buildRequirementBrief(store, 'SPMS-6001')

  assert.match(brief, /## 转交出去（subagent \/ 专家）时：这些链接必须原样带上/)
  assert.ok(brief.includes(FIGMA_PC), '模板正文里必须有真实的 UI 节点链接')
  assert.match(brief, /别只给「描述」/, '要点明失败模式：只给描述 → 对方没有链接')
  assert.match(brief, /node-id=/, 'UI 稿要给带 node-id 的节点链接')
  assert.match(brief, /summon_expert/, '叫专家时也用这段当 task')
  assert.match(brief, /要你做的事：/, '模板要留出「要你做的事」')
  assert.match(brief, /一致/, '交付要求要写「与 UI 稿一致，不一致要列出来」')

  const at = (s) => brief.indexOf(s)
  assert.ok(at('## 转交出去') > at('## 资料链接'), '转交段紧跟资料链接')
  assert.ok(at('## 转交出去') < at('## 请做的第一件事'), '转交段在动手那节之前')
})

test('仍按端裁剪：PC 端提示词里的模板不出现 APP 端 UI 稿', () => {
  seed()
  const { brief } = buildRequirementBrief(store, 'SPMS-6001')
  const handoff = brief.slice(brief.indexOf('## 转交出去'), brief.indexOf('## 最近的开发记录'))
  assert.ok(handoff.includes(FIGMA_PC), 'PC 端 UI 稿要在模板里')
  assert.ok(!handoff.includes('999-111'), 'APP 端 UI 稿不许进本次的模板')
})

test('没登记 UI 稿时说清"先问清楚找谁要"，不许模型自己想象界面', () => {
  store.saveRequirement({
    id: 'SPMS-6002',
    title: '接口字段调整',
    readTitle: false,
    projects: [{ project: 'spms-svc', platform: '服务端', root: '/tmp/work/spms-svc' }],
    links: [{ kind: 'design', url: 'https://design.example/6002', title: '后端设计' }],
  })
  const { brief } = buildRequirementBrief(store, 'SPMS-6002')
  assert.match(brief, /没有登记 UI 稿/)
  assert.match(brief, /别自己想象一套界面/)
  assert.ok(!brief.includes('node-id='), '没有 UI 稿时不该出现节点链接的提醒凑数')
})

test('被写脏的 url 字段要截成干净 URL（否则转交出去的是坏链接）', () => {
  // 台账实测形态：整句粘进 url 字段
  assert.equal(cleanUrl('PC端：https://figma.example/x?node-id=1-2《PC端》'), 'https://figma.example/x?node-id=1-2')
  assert.equal(cleanUrl('https://doc.example/1　《需求文档》'), 'https://doc.example/1')
  assert.equal(cleanUrl('没有链接'), '没有链接', '不是 URL 就原样返回，不要凭空造一个')

  store.saveRequirement({
    id: 'SPMS-6003',
    title: '脏链接',
    readTitle: false,
    projects: [{ project: 'spms-pc', platform: 'PC', root: '/tmp/work/spms-pc' }],
    links: [{ kind: 'ui', url: 'PC端：https://figma.example/f?node-id=7-8《PC端》' }],
  })
  const { brief } = buildRequirementBrief(store, 'SPMS-6003')
  const handoff = brief.slice(brief.indexOf('## 转交出去'), brief.indexOf('## 最近的开发记录'))
  assert.match(handoff, /https:\/\/figma\.example\/f\?node-id=7-8/)
  assert.ok(!/PC端：https/.test(handoff), '模板里不该出现"PC端："这种前缀')
})

test('handoff:false 整段关掉（其余内容一字不差）', () => {
  seed()
  const withHandoff = buildRequirementBrief(store, 'SPMS-6001').brief
  const without = buildRequirementBrief(store, 'SPMS-6001', { handoff: false }).brief

  assert.ok(!without.includes('转交出去'))
  assert.match(without, /## 资料链接/, '关掉转交段不影响资料链接')

  /** 整块抠掉一个小节（从它的 `## ` 标题到下一个 `## ` 标题），再**去掉所有空行**后比较 ——
   *  比逐行过滤稳：模板正文行、``` 围栏都一起走，也不受小节之间空行数差异影响。 */
  const normalize = (text) => String(text).split('\n').filter((line) => line.trim() !== '').join('\n')
  const cutSection = (text, heading) => {
    const lines = String(text).split('\n')
    const start = lines.findIndex((line) => line.startsWith(heading))
    if (start < 0) return normalize(lines.join('\n'))
    let end = lines.findIndex((line, i) => i > start && line.startsWith('## '))
    if (end < 0) end = lines.length
    return normalize([...lines.slice(0, start), ...lines.slice(end)].join('\n'))
  }
  assert.equal(
    cutSection(withHandoff, '## 转交出去'),
    cutSection(without, '## 转交出去'),
    '除转交段外，两份必须一字不差',
  )
})

test('纯函数：handoffSection 不依赖 store，按参数出词', () => {
  const lines = handoffSection({ id: 'X-1', title: 'T', platform: 'APP', ui: [{ url: 'https://f.example/a', title: 'APP端' }] })
  const text = lines.join('\n')
  assert.match(text, /需求 X-1：T（本次只做 APP 端）/)
  assert.match(text, /https:\/\/f\.example\/a/)
  assert.match(text, /```text/, '要有可复制的一段')
  assert.equal(lines.filter((l) => l.startsWith('## ')).length, 1, '只有一个标题')
})
