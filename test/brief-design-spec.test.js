/**
 * 「设计稿（权威依据，必须先读）」段 + 转交模板里的本地报告路径（用户 2026-09-30 要求）。
 *
 * 要解决的问题（真实失败）：**主 agent 把设计依据留在自己上下文里，给子 agent / 专家派活时
 * 只写了「照设计稿做个 XX」** —— 对方手里既没有 Figma 登录态、也没有你这里的链接和本地解码报告，
 * 做出来必然跟 UI 不一致。
 *
 * 所以本用例钉的是「主 agent 该怎样把设计依据交出去」：
 *   ① 有本地已解码的设计规格报告（`spec` 链接）时：段落要**带出报告路径**，并说明它是权威依据、
 *      数值以它为准、「需向设计确认」的条目要逐条确认；
 *   ② 有 UI 原稿链接时：明说**本会话没有 Figma 登录态、不要去访问**；
 *   ③ 段里必须有一句：**派活给子 agent / 专家时这一节要原样带上**；
 *   ④ 转交模板（可直接复制的任务正文）里也要**带上报告路径** —— 这才是真的"交出去"；
 *   ⑤ 没有设计依据（既无 spec 也无 ui）时整段不出现；
 *   ⑥ `spec` 链接不重复出现在「资料链接」里；仍按「端」裁剪。
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { buildRequirementBrief, designSpecSection } from '../lib/brief.js'
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

const REPORT = '/tmp/fig6031/6031-figma-findings.md'
const FIGMA = 'https://www.figma.com/design/5e4oj8CPE9KEVBXLaKH52a/?node-id=144-2295'

function seed({ withReport = true, withUi = true } = {}) {
  const links = [{ kind: 'doc', url: 'https://doc.example/6031', title: '需求文档' }]
  if (withReport) links.push({ kind: 'spec', url: REPORT, title: '6031 设计规格', note: '重点读 §4.1 §4.2 §2.5；§6.2 是需向设计确认的矛盾点' })
  if (withUi) links.push({ kind: 'ui', url: FIGMA, title: '展示侧画板 144:2295' })
  return store.saveRequirement({
    id: 'SPMS-6001',
    no: '6001',
    title: 'Profile Search/Create/Edit 需求变更',
    readTitle: false,
    projects: [{ project: 'spms-pc', platform: 'PC', root: '/tmp/work/spms-pc' }],
    links,
  })
}

test('有本地规格报告：段落带出报告路径，且排在「资料链接」之前', () => {
  seed()
  const { brief } = buildRequirementBrief(store, 'SPMS-6001')

  assert.match(brief, /## 设计稿（权威依据，必须先读）/)
  assert.ok(brief.includes(REPORT), '必须带出本地报告路径')
  assert.match(brief, /本地已解码的设计规格报告/)
  assert.match(brief, /重点：重点读 §4\.1/, '链接备注（重点看哪几节）要带出来')
  assert.match(brief, /解码\*\*出来的几何数据/, '要说明它是解码出来的权威数据，不是目测')
  assert.match(brief, /需向设计确认 \/ 存疑.*逐条确认/s, '报告里的存疑项要逐条确认，不许自己拍板')

  const at = (s) => brief.indexOf(s)
  assert.ok(at('## 设计稿') < at('## 资料链接'), '设计稿是权威依据 → 排在资料链接之前')
  assert.ok(at('## 设计稿') > at('# 需求 SPMS-6001'), '仍在需求标题之后')
})

test('有 UI 原稿链接：明说没有 Figma 登录态、不要去访问', () => {
  seed()
  const { brief } = buildRequirementBrief(store, 'SPMS-6001')
  assert.match(brief, /原稿（只作人工对照，\*\*不要去访问\*\*）：https:\/\/www\.figma\.com\/design\/5e4oj8/)
  assert.match(brief, /本会话没有 Figma 登录态/)
  assert.match(brief, /以本地报告里的节点数据为准/)
})

test('核心要求：段里必须写清「派活给子 agent / 专家时这一节要原样带上」', () => {
  seed()
  const { brief } = buildRequirementBrief(store, 'SPMS-6001')
  assert.match(brief, /\*\*派活给子 agent \/ 专家时，这一节必须原样带上\*\*/)
  assert.match(brief, /报告路径 \+ 关键画板截图 \+ 原稿链接 \+ 具体 `node-id`/)
  assert.match(brief, /对方手里没有数据/, '要点明后果：只给描述 = 对方没数据')
  assert.match(brief, /\*\*不要转述几何\*\*/, '几何让执行方自己从证据里读，主 agent 只转交决策')
  assert.match(brief, /落到仓库/, '证据别只放 /tmp（会被清）')
  assert.match(brief, /设计走查对照表/, '验收要对照表，填不出设计值就说明没看设计稿')
  assert.match(brief, /先按设计几何实现/, '设计稿与需求文档冲突时的处置规则')
})

test('转交模板里也带报告路径（这才是真的交出去）', () => {
  seed()
  const { brief } = buildRequirementBrief(store, 'SPMS-6001')
  const handoff = brief.slice(brief.indexOf('## 转交出去'), brief.indexOf('## 最近的开发记录'))
  assert.match(handoff, /设计证据（本地已解码，直接读、无需登录）：\/tmp\/fig6031\/6031-figma-findings\.md/)
  assert.match(handoff, /「设计走查对照表」（设计节点 → 设计值 → 改前 → 改后）/, '交付要求里要走查对照表')
  assert.ok(handoff.includes(FIGMA), '原稿链接也要在转交模板里（对方要能对照）')
})

test('截图与报告分开称呼：.png 叫「关键画板截图」，只有截图时提示以报告为准', () => {
  store.saveRequirement({
    id: 'SPMS-6003',
    title: '只挂了截图',
    readTitle: false,
    projects: [{ project: 'spms-pc', platform: 'PC', root: '/tmp/work/spms-pc' }],
    links: [
      { kind: 'spec', url: 'doc/plans/2026-09-30-x/design-evidence/144-2295.png', title: '展示侧画板' },
      { kind: 'ui', url: 'https://figma.example/x?node-id=144-2295', title: '展示侧' },
    ],
  })
  const { brief } = buildRequirementBrief(store, 'SPMS-6003')
  assert.match(brief, /\*\*关键画板截图\*\*：`doc\/plans\//)
  assert.ok(!brief.includes('本地已解码的设计规格报告'), '截图不能冒充解码报告')
  assert.match(brief, /几何数值要以解码报告为准/, '只有截图时要说清以报告为准')
})

test('只有 UI 稿、没有本地报告：段落照出，并提示先解码到本地', () => {
  seed({ withReport: false })
  const { brief } = buildRequirementBrief(store, 'SPMS-6001')
  assert.match(brief, /## 设计稿（权威依据，必须先读）/)
  assert.match(brief, /先让用户把对应画板\*\*解码到本地\*\*再动手/)
  assert.ok(!brief.includes('本地已解码的设计规格报告'), '没挂报告就不该声称有报告')
})

test('既没有 UI 稿也没有本地报告：整段不出现（不占篇幅）', () => {
  seed({ withReport: false, withUi: false })
  const { brief } = buildRequirementBrief(store, 'SPMS-6001')
  assert.ok(!brief.includes('设计稿（权威依据'), '没有设计依据就不出这一段')
  assert.equal(designSpecSection({}).length, 0, '纯函数同理')
})

test('spec 链接不重复出现在「资料链接」里；但仍按端裁剪', () => {
  store.saveRequirement({
    id: 'SPMS-6002',
    title: '多端需求',
    readTitle: false,
    projects: [{ project: 'spms-pc', platform: 'PC', root: '/tmp/work/spms-pc' }],
    links: [
      { kind: 'spec', url: '/tmp/pc/report.md', title: 'PC端' },
      { kind: 'spec', url: '/tmp/app/report.md', title: 'APP端' },
      { kind: 'ui', url: 'https://figma.example/pc?node-id=1-1', title: 'PC端' },
    ],
  })
  const { brief } = buildRequirementBrief(store, 'SPMS-6002')
  const specSection = brief.slice(brief.indexOf('## 设计稿'), brief.indexOf('## 资料链接'))
  const linksSection = brief.slice(brief.indexOf('## 资料链接'), brief.indexOf('## 转交出去'))

  assert.ok(specSection.includes('/tmp/pc/report.md'), 'PC 端报告要在设计稿段')
  assert.ok(!specSection.includes('/tmp/app/report.md'), 'APP 端报告不进本次')
  assert.ok(!linksSection.includes('report.md'), 'spec 链接不在资料链接里重复出现')
})
