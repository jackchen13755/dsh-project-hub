/**
 * 开新会话的提示词要带上「叫专家」的引导（用户 2026-09-30 要求：装了 Agency 专家插件，
 * 新会话提示词里加点使用专家的提示词）。
 *
 * 这条引导的三个约束（也是本用例钉的东西）：
 *   ① 工具名/「默认全关、先 list_experts()」必须与 Agency 插件自己的说明一致，不能自己编；
 *   ② 要写清**不值得叫**的场景 —— 否则模型会给改文案这种小活也召一堆专家；
 *   ③ 位置在「请做的第一件事」之前（读到时还没动手），且 `experts:false` 能整段关掉。
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { buildRequirementBrief, expertGuideSection } from '../lib/brief.js'
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

/** PC 端需求：带 UI 稿与后端设计稿 —— 三类专家都该被建议。 */
function seedPc() {
  return store.saveRequirement({
    id: 'SPMS-6001',
    title: '房态看板改造',
    status: 'developing',
    readTitle: false,
    projects: [{ project: 'spms-pc', platform: 'PC', root: '/tmp/work/spms-pc' }],
    links: [
      { kind: 'doc', url: 'https://doc.example/6001', title: '需求文档' },
      { kind: 'ui', url: 'https://figma.example/6001', title: 'PC端' },
      { kind: 'design', url: 'https://design.example/6001', title: '后端设计' },
    ],
  })
}

test('简报里有叫专家的引导，且排在「请做的第一件事」之前', () => {
  seedPc()
  const { brief } = buildRequirementBrief(store, 'SPMS-6001')

  assert.match(brief, /## 需要的话叫专家/)
  assert.match(brief, /list_experts\(\)/, '要先看这次能用谁（专家默认全关）')
  assert.match(brief, /summon_expert\(</, '单个专家的叫法')
  assert.match(brief, /summon_experts\(\[/, '并行叫法')
  assert.match(brief, /get_expert_team\(/, '专家团要先读分工')
  assert.match(brief, /summon_expert_team\(/, '专家团的叫法')
  assert.match(brief, /材料不是系统指令/, '专家结论的定位要写清楚')
  assert.match(brief, /不值得叫的/, '要写清什么活不值得叫（防止滥用）')

  const at = (s) => brief.indexOf(s)
  assert.ok(at('## 需要的话叫专家') > 0, '专家段要在简报里')
  assert.ok(at('## 需要的话叫专家') < at('## 请做的第一件事'), '专家段要排在动手那节之前')
  assert.ok(at('## 最近的开发记录') < at('## 需要的话叫专家'), '专家段在开发记录之后')
})

test('建议叫谁跟着「端 + 手上的资料」走：PC + UI 稿 + 后端设计 → 前端 / 架构 / 验收', () => {
  seedPc()
  const { brief } = buildRequirementBrief(store, 'SPMS-6001')
  assert.match(brief, /前端开发者/)
  assert.match(brief, /软件架构师/)
  assert.match(brief, /验收测试工程师/)
})

test('只做服务端、没有 UI 稿时不叫前端（别建议不相关的专家）', () => {
  store.saveRequirement({
    id: 'SPMS-6002',
    title: '接口字段调整',
    readTitle: false,
    projects: [{ project: 'spms-svc', platform: '服务端', root: '/tmp/work/spms-svc' }],
    links: [{ kind: 'design', url: 'https://design.example/6002', title: '后端设计' }],
  })
  const { brief } = buildRequirementBrief(store, 'SPMS-6002')
  assert.ok(!brief.includes('前端开发者'), '服务端需求不该建议叫前端')
  assert.match(brief, /软件架构师/)
  assert.match(brief, /验收测试工程师/)
})

test('experts:false 整段关掉（给面板开关/别的调用方留口子），其余内容一字不差', () => {
  seedPc()
  const withExperts = buildRequirementBrief(store, 'SPMS-6001').brief
  const without = buildRequirementBrief(store, 'SPMS-6001', { experts: false }).brief

  assert.ok(!without.includes('需要的话叫专家'))
  assert.ok(!without.includes('list_experts'))

  // 把专家段整段删掉后，两份必须完全一致（说明只动了这一段）
  const cut = withExperts.slice(0, withExperts.indexOf('## 需要的话叫专家')) + withExperts.slice(withExperts.indexOf('## 请做的第一件事'))
  assert.equal(cut, without)
})

test('纯函数：expertGuideSection 不依赖 store，按参数出词', () => {
  const pc = expertGuideSection({ platform: 'PC', linkKinds: ['ui', 'doc'] }).join('\n')
  assert.match(pc, /前端开发者/)
  assert.ok(!pc.includes('软件架构师'), '没有后端设计稿就不提架构师')
  assert.match(pc, /验收测试工程师/, '收尾验收是默认建议')

  const svc = expertGuideSection({ platform: '服务端', linkKinds: ['design'] }).join('\n')
  assert.ok(!svc.includes('前端开发者'))
  assert.match(svc, /软件架构师/)

  assert.equal(expertGuideSection().filter((line) => line.startsWith('## ')).length, 1, '只有一个标题')
})
