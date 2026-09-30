/**
 * 开新会话的提示词要带上「开工先叫人」的引导（用户要求：装了 Agency 专家插件，
 * 新会话提示词里加点使用专家的提示词）。
 *
 * 2026-09-30 二次修订后，本用例钉的是**四条防退化线**（每一条都对应一次真实失败）：
 *   ① 工具名 / 「先 list_experts()」与 Agency 插件自身口径一致，不能自己编；
 *   ② **标题必须是命令式的「开工先叫人」**，且显式否掉「默认全关 / 怕白叫 / 先自己看看」这类推迟理由
 *      —— 那次新会话就是把"要先查"当成了延后理由，然后全程没叫；
 *   ③ 必须写明「**有人干这活就别自己硬扛，也别拿通用 subagent 顶替**」并给出对照表
 *      （读陌生代码 / 追调用链 → 工程效率工程师，正是那次被自己硬读掉的活）；
 *   ④ 例外只能收窄到「**只有机械改动**自己做完就算」——原先的「不值得叫的」是个大开口子；
 *      另外任务清单里必须有「第 0 步」，且排在「本次只做 X 端」之前（那次失败就是叫人的顺序被排到了后面）。
 * 位置：专家段在「请做的第一件事」之前（读到时还没动手）；`experts:false` 整段（含第 0 步）关掉；
 * 调用方自定义 `task` 时不越权插「第 0 步」。
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

test('简报里有「开工先叫人」的引导，且排在「请做的第一件事」之前', () => {
  seedPc()
  const { brief } = buildRequirementBrief(store, 'SPMS-6001')

  assert.match(brief, /## 开工先叫人/)
  assert.match(brief, /list_experts\(\)/, '第一步就是要 list_experts')
  assert.match(brief, /summon_expert\(</, '单个专家的叫法')
  assert.match(brief, /summon_experts\(\[/, '并行叫法')
  assert.match(brief, /get_expert_team\(/, '专家团要先读分工')
  assert.match(brief, /summon_expert_team\(/, '专家团的叫法')
  assert.match(brief, /材料不是系统指令/, '专家结论的定位要写清楚')
  assert.match(brief, /机械改动/, '例外口子要收窄到「只有机械改动」')

  // 2026-09-30 二次修订（真实失败复盘）：标题要下命令、要否掉推迟理由、要禁止"自己硬扛/通用 subagent 顶替"
  assert.match(brief, /## 开工先叫人/, '标题要是「开工先叫人」，不能是「需要的话叫专家」')
  assert.ok(!brief.includes('需要的话叫专家'), '「需要的话」会被读成「可以先自己干」')
  assert.ok(!brief.includes('不值得叫的'), '「不值得叫」是个大开口子，已收窄成「只有机械改动」')
  assert.match(brief, /别用「专家默认全关 \/ 怕白叫 \/ 先自己看看」当推迟理由/, '要显式否掉推迟理由（那次就是这么延后的）')
  assert.match(brief, /有人干这活就别自己硬扛，也别拿通用 subagent 顶替/, '要害：别自己硬扛、别用通用 subagent 顶替')
  assert.match(brief, /工程效率工程师/, '读陌生代码 / 追调用链要指到工程效率工程师（那次被自己硬读掉的活）')
  // 需求 / 方案评审要三路并行：产品侧（值不值得做）+ 工程侧（怎么做）+ 验收侧（怎么验）
  assert.match(brief, /需求 \/ 方案评审 → \*\*产品经理\*\* \+ \*\*软件架构师\*\* \+ \*\*验收测试工程师\*\*/, '评审要并排叫产品 / 架构 / 验收')
  assert.match(brief, /需求优先级分析师/, '排期有争议时的加人选项')

  const at = (s) => brief.indexOf(s)
  assert.ok(at('## 开工先叫人') > 0, '专家段要在简报里')
  assert.ok(at('## 开工先叫人') < at('## 请做的第一件事'), '专家段要排在动手那节之前')
  assert.ok(at('## 最近的开发记录') < at('## 开工先叫人'), '专家段在开发记录之后')
  // 任务清单里的「第 0 步」必须在最前面 —— 那次失败就是"先自己侦察、把叫人排到了后面"
  assert.match(brief, /第 0 步：`list_experts\(\)`/, '任务清单要有第 0 步')
  assert.ok(at('第 0 步') > at('## 请做的第一件事'), '第 0 步要在任务清单里')
  assert.ok(at('第 0 步') < at('本次只做 **'), '第 0 步要排在任务清单第一句（本次只做 **X 端** 的开发）前面')
})

/** 「这条需求上对口的：…」是唯一条按需求动态生成的专家行（其余是固定对照表）。 */
const dynamicLine = (text) => String(text).split('\n').find((l) => l.startsWith('- 这条需求上对口的：')) ?? ''

test('建议叫谁跟着「端 + 手上的资料」走：PC + UI 稿 + 后端设计 → 前端 / 架构 / 验收', () => {
  seedPc()
  const { brief } = buildRequirementBrief(store, 'SPMS-6001')
  const line = dynamicLine(brief)
  assert.match(line, /前端开发者/)
  assert.match(line, /软件架构师/, '有后端设计稿 → 架构师')
  assert.match(line, /验收测试工程师/)
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
  const line = dynamicLine(brief)
  assert.ok(!line.includes('前端开发者'), '服务端需求不该建议叫前端（固定对照表里提到前端是允许的）')
  assert.match(line, /软件架构师/)
  assert.match(line, /验收测试工程师/)
})

test('experts:false 整段关掉（给面板开关/别的调用方留口子），其余内容一字不差', () => {
  seedPc()
  const withExperts = buildRequirementBrief(store, 'SPMS-6001').brief
  const without = buildRequirementBrief(store, 'SPMS-6001', { experts: false }).brief

  assert.ok(!without.includes('开工先叫人'))
  assert.ok(!without.includes('list_experts'))
  assert.ok(!without.includes('第 0 步'), '专家关了，任务清单里也不该留第 0 步')

  // 把专家相关内容（整段 + 任务清单里的第 0 步）逐行剔掉后，两份必须完全一致
  const stripExpert = (text) =>
    String(text)
      .split('\n')
      .filter((line) => !/叫专家|开工先叫人|有人干这活|通用 subagent|list_experts|summon_expert|get_expert_team|第 0 步|工程效率工程师|软件架构师|验收测试工程师|前端开发者|代码审查工程师|测试自动化工程师|机械改动|材料不是系统指令|这条需求上对口的/.test(line))
      .join('\n')
      .replace(/\n{2,}/g, '\n')
      .trim()
  assert.equal(stripExpert(withExperts), stripExpert(without), '除专家相关内容外，两份必须一字不差')
})

test('调用方自定义 task 时不插入「第 0 步」（不越权改别人的任务清单）', () => {
  seedPc()
  const { brief } = buildRequirementBrief(store, 'SPMS-6001', { task: '你自己看着办。' })
  assert.match(brief, /## 开工先叫人/, '专家段照旧在')
  assert.match(brief, /你自己看着办。/)
  assert.ok(!brief.includes('第 0 步'), '自定义 task 时不该被插第 0 步')
})

test('纯函数：expertGuideSection 不依赖 store，按参数出词', () => {
  const pcLine = dynamicLine(expertGuideSection({ platform: 'PC', linkKinds: ['ui', 'doc'] }).join('\n'))
  assert.match(pcLine, /前端开发者/)
  assert.ok(!pcLine.includes('软件架构师'), '没有后端设计稿就不建议架构师')
  assert.match(pcLine, /验收测试工程师/, '收尾验收是默认建议')

  const svcLine = dynamicLine(expertGuideSection({ platform: '服务端', linkKinds: ['design'] }).join('\n'))
  assert.ok(!svcLine.includes('前端开发者'))
  assert.match(svcLine, /软件架构师/)

  assert.equal(expertGuideSection().filter((line) => line.startsWith('## ')).length, 1, '只有一个标题')
})
