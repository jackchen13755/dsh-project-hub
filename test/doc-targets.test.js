/**
 * 读需求文档时**分辨出这条需求要落在哪些工作区、每个工作区做哪一端**，并回填到需求记录。
 *
 * 用户诉求（原话要点）：
 *   · 「读文档信息是希望能分辨出需要的工作区和端信息，回填」。
 *
 * 三条硬规则（都是「只补空、不覆盖」的展开）：
 *   ① 调用方显式传了 projects（工具参数 / 面板表单填过）→ 一个字都不改，只把建议放返回值；
 *   ② 需求还没有项目 → 用文档里认出来的项目补上；
 *   ③ 已有项目且它的端空着、文档也只指向一个端 → 补端；文档写了多端就空着（无从判断谁做哪端）。
 *
 * 夹具里的人名/项目名/域名一律是假的（真实数据不能进仓库）。
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import {
  parseDocMeta,
  parsePlatforms,
  parseProjectTokens,
  platformFromLabel,
  stripRoleAssignments,
} from '../lib/doc-meta.js'
import { resolveDocTitle } from '../lib/doc-title.js'
import { buildTools } from '../lib/tools.js'
import { openStore, useTempHome, writeFixture } from './helpers.js'

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

/** 多端文档：正文写「服务端」，UI 文件表里写「PC端」。 */
const DOC_MULTI = `# 【6100】Queue 数据记录

相关人员
产品：张三
前端：王五
后端：赵六
QA：钱八

项目：demo-app
平台：PC、APP

本次涉及服务端接口改造，仓库 https://github.com/demo-org/demo-api

UI 文件
PC端：https://www.figma.com/design/AAAA
APP端：https://www.figma.com/design/BBBB
`

/** 单端文档：只有 PC 一张设计稿。 */
const DOC_PC_ONLY = `# 【6101】只在 PC 端加一个入口

项目：demo-app

UI 文件
PC端：https://www.figma.com/design/CCCC
`

/** 单端文档：只有 APP 一张设计稿。 */
const DOC_APP_ONLY = `# 【6102】只在 APP 端加一个入口

项目：demo-app

UI 文件
APP端：https://www.figma.com/design/DDDD
`

test('端：设计稿标签 + 正文措辞都认，且「后端：赵六」这种角色行不会被当成服务端', () => {
  const meta = parseDocMeta(DOC_MULTI)
  assert.deepEqual(meta.targets.platforms, ['PC', 'APP', '服务端'])

  // 关键坑：角色表里的「后端：赵六」是**人**，不是服务端
  assert.deepEqual(parsePlatforms('后端：赵六 孙七'), [])
  assert.deepEqual(parsePlatforms('后端：赵六\n本次不改服务端'), ['服务端'])
  assert.deepEqual(parsePlatforms(''), [])
})

test('端：platformFromLabel 只认「整词就是端名」，资料名不算', () => {
  assert.equal(platformFromLabel('PC端'), 'PC')
  assert.equal(platformFromLabel('APP端'), 'APP')
  assert.equal(platformFromLabel('pc'), 'PC')
  assert.equal(platformFromLabel('移动端'), 'APP')
  assert.equal(platformFromLabel('服务端'), '服务端')
  assert.equal(platformFromLabel('后端设计'), null, '「后端设计」是资料名，不是端')
  assert.equal(platformFromLabel('UI 设计'), null)
  assert.equal(platformFromLabel(''), null)
})

test('stripRoleAssignments：像人名的值才剥，描述性内容留着', () => {
  assert.equal(stripRoleAssignments('后端：赵六').trim(), '')
  assert.match(stripRoleAssignments('后端需要支持 PC 与 APP'), /PC 与 APP/)
})

test('工作区：明写的「项目：X」、托管地址、拉丁标识符都进候选', () => {
  const tokens = parseProjectTokens(DOC_MULTI)
  assert.ok(tokens.includes('demo-app'), '「项目：demo-app」要收')
  assert.ok(tokens.includes('demo-org/demo-api'), '仓库地址要收 org/repo')
  assert.ok(tokens.includes('demo-api'), '仓库地址还要收 repo 名')
  // 明显不是项目名的技术词不该占位
  for (const noise of ['pc', 'app', 'figma', 'https']) assert.ok(!tokens.includes(noise), `不该收 ${noise}`)
})

test('resolveDocTitle（本地文件）也带回 targets', async () => {
  const file = writeFixture(tmp.dir, 'doc.md', DOC_MULTI)
  const res = await resolveDocTitle(file)
  assert.equal(res.ok, true)
  assert.deepEqual(res.targets.platforms, ['PC', 'APP', '服务端'])
  assert.ok(res.targets.projectTokens.includes('demo-app'))
})

test('回填：需求还没有项目 → 用文档认出的项目补上（多端时端留空）', async () => {
  store.upsertProject({ id: 'demo-app', name: 'demo-app' })
  const file = writeFixture(tmp.dir, 'doc-multi.md', DOC_MULTI)
  const res = await store.saveRequirement({ id: 'DEMO-6100', docUrl: file })

  const projects = store.listRequirementProjects('DEMO-6100')
  assert.equal(projects.length, 1)
  assert.equal(projects[0].projectId, 'demo-app')
  assert.equal(projects[0].platform, null, '文档写了 PC+APP+服务端，无法判断谁做哪端 → 留空')
  assert.deepEqual(res.targetsFromDoc.applied.projects, ['demo-app'])
  assert.deepEqual(res.targetsFromDoc.matched.map((m) => m.projectId), ['demo-app'])
})

test('回填：文档只指向一个端 → 连端一起补上', async () => {
  store.upsertProject({ id: 'demo-app', name: 'demo-app' })
  const file = writeFixture(tmp.dir, 'doc-app.md', DOC_APP_ONLY)
  const res = await store.saveRequirement({ id: 'DEMO-6102', docUrl: file })

  const projects = store.listRequirementProjects('DEMO-6102')
  assert.equal(projects[0].projectId, 'demo-app')
  assert.equal(projects[0].platform, 'APP')
  assert.deepEqual(res.targetsFromDoc.applied.projects, ['demo-app'])
})

test('回填：已有项目但端空着 + 文档单端 → 补端（不新建项目）', async () => {
  store.upsertProject({ id: 'demo-app', name: 'demo-app' })
  await store.saveRequirement({ id: 'DEMO-6103', readTitle: false, projects: [{ project: 'demo-app' }] })
  assert.equal(store.listRequirementProjects('DEMO-6103')[0].platform, null)

  const file = writeFixture(tmp.dir, 'doc-pc.md', DOC_PC_ONLY)
  const res = await store.saveRequirement({ id: 'DEMO-6103', docUrl: file })
  const projects = store.listRequirementProjects('DEMO-6103')
  assert.equal(projects.length, 1)
  assert.equal(projects[0].platform, 'PC')
  assert.deepEqual(res.targetsFromDoc.applied.platforms, ['PC'])
})

test('回填：手填的项目与端一律不覆盖（只给建议）', async () => {
  store.upsertProject({ id: 'demo-app', name: 'demo-app' })
  store.upsertProject({ id: 'manual-app', name: 'manual-app' })
  await store.saveRequirement({ id: 'DEMO-6104', readTitle: false, projects: [{ project: 'manual-app', platform: 'H5' }] })

  const file = writeFixture(tmp.dir, 'doc-app.md', DOC_APP_ONLY)
  const res = await store.saveRequirement({ id: 'DEMO-6104', docUrl: file })

  const projects = store.listRequirementProjects('DEMO-6104')
  assert.equal(projects.length, 1, '不因为文档里认出了别的项目就加一条')
  assert.equal(projects[0].projectId, 'manual-app')
  assert.equal(projects[0].platform, 'H5', '手填的端不能被文档改写')
  assert.deepEqual(res.targetsFromDoc.applied.projects, [])
  assert.deepEqual(res.targetsFromDoc.matched.map((m) => m.projectId), ['demo-app'], '建议要如实报出来')
})

test('回填：显式传 projects 时同样只给建议，一个都不落', async () => {
  store.upsertProject({ id: 'demo-app', name: 'demo-app' })
  const file = writeFixture(tmp.dir, 'doc-app.md', DOC_APP_ONLY)
  const res = await store.saveRequirement({ id: 'DEMO-6105', docUrl: file, projects: [{ project: 'demo-app', platform: 'PC' }] })
  assert.equal(store.listRequirementProjects('DEMO-6105')[0].platform, 'PC')
  assert.deepEqual(res.targetsFromDoc.applied.projects, [])
  assert.deepEqual(res.targetsFromDoc.applied.platforms, [])
})

test('回填：文档里认不出任何已知项目 → 什么都不做，也不报错', async () => {
  const file = writeFixture(tmp.dir, 'doc-app.md', DOC_APP_ONLY)
  const res = await store.saveRequirement({ id: 'DEMO-6106', docUrl: file })
  assert.equal(store.listRequirementProjects('DEMO-6106').length, 0)
  assert.deepEqual(res.targetsFromDoc.matched, [])
  assert.deepEqual(res.targetsFromDoc.platforms, ['APP'])
})

test('工具：ph_doc_title 输出 targets，ph_save_requirement 的文本说清回填了什么', async () => {
  store.upsertProject({ id: 'demo-app', name: 'demo-app' })
  const byName = new Map(buildTools({ store, config: {}, version: '0.1.0-test' }).map((t) => [t.name, t]))

  const docFile = writeFixture(tmp.dir, 'doc-app.md', DOC_APP_ONLY)
  const read = await byName.get('ph_doc_title').execute({ url: docFile })
  assert.deepEqual(read.targets.platforms, ['APP'])
  assert.match(read.text, /涉及的端：APP/)

  const docMulti = writeFixture(tmp.dir, 'doc-multi.md', DOC_MULTI)
  const saved = await byName.get('ph_save_requirement').execute({ id: 'DEMO-6107', docUrl: docMulti }, { cwd: tmp.workRoot })
  assert.match(saved.text, /工作区已自动挂上：demo-app/)
  assert.match(saved.text, /文档里提到的端：PC、APP、服务端/)
})

// ── 以下是「代码审查提出、必须钉住」的三条：弱证据不许写库 ─────────────────────

test('端：`前端：PC 和 APP 都要` 不能被当人名整行剥掉（PC/APP 都要认出来）', () => {
  const meta = parseDocMeta('相关人员\n前端：PC 和 APP 都要\n产品：张三')
  assert.ok(meta.targets.platforms.includes('PC'), 'PC 不能丢')
  assert.ok(meta.targets.platforms.includes('APP'), 'APP 不能丢')
  assert.equal(meta.roles['产品'], '张三', '真正的角色表照样认')
})

test('端：正文顺口一句「后端」是**弱证据** —— 不许据此把项目的端写成服务端', async () => {
  store.upsertProject({ id: 'demo-app', name: 'demo-app' })
  await store.saveRequirement({ id: 'DEMO-6201', readTitle: false, projects: [{ project: 'demo-app' }] })
  // 文档只有正文提到后端，没有任何设计稿/平台行
  const file = writeFixture(tmp.dir, 'doc-weak.md', '# 【6201】改一下\n\n项目：demo-app\n\n本次涉及服务端接口改造\n')
  const res = await store.saveRequirement({ id: 'DEMO-6201', docUrl: file })

  assert.equal(store.listRequirementProjects('DEMO-6201')[0].platform, null, '弱证据不许写端')
  assert.deepEqual(res.targetsFromDoc.applied.platforms, [])
  assert.ok(res.targetsFromDoc.platforms.includes('服务端'), '但要说出来（只是没写库）')
  assert.deepEqual(res.targetsFromDoc.strongPlatforms, [], '服务端只是弱证据')
})

test('工作区：正文里出现的英文词是**弱证据** —— 不许据此自动挂项目', async () => {
  store.upsertProject({ id: 'report', name: 'report' })
  const file = writeFixture(tmp.dir, 'doc-weakproj.md', '# 【6202】改报表\n\n影响 report 模块的导出\n')
  const res = await store.saveRequirement({ id: 'DEMO-6202', docUrl: file })

  assert.equal(store.listRequirementProjects('DEMO-6202').length, 0, '弱证据不许自动挂项目')
  assert.deepEqual(res.targetsFromDoc.matched, [])
  assert.deepEqual(res.targetsFromDoc.weakMatches.map((m) => m.projectId), ['report'], '但要作为提示报出来')

  // 同一个项目，明写了「项目：report」就是强证据 → 可以挂
  const explicit = writeFixture(tmp.dir, 'doc-strongproj.md', '# 【6203】改报表\n\n项目：report\n')
  const res2 = await store.saveRequirement({ id: 'DEMO-6203', docUrl: explicit })
  assert.deepEqual(store.listRequirementProjects('DEMO-6203').map((p) => p.projectId), ['report'])
  assert.deepEqual(res2.targetsFromDoc.applied.projects, ['report'])
})

test('工作区：归档项目不参与自动挂载', async () => {
  store.upsertProject({ id: 'old-app', name: 'old-app' })
  const saved = await store.saveRequirement({ id: 'DEMO-6204', readTitle: false, projects: [{ project: 'old-app' }] })
  assert.ok(saved)
  store.archiveRequirement('DEMO-6204', true)
  store.db.prepare('UPDATE projects SET archived_at = ? WHERE id = ?').run(Date.now(), 'old-app')

  const file = writeFixture(tmp.dir, 'doc-old.md', '# 【6205】\n\n项目：old-app\n')
  const res = await store.saveRequirement({ id: 'DEMO-6205', docUrl: file })
  assert.deepEqual(res.targetsFromDoc.matched, [], '归档项目不参与匹配')
  assert.equal(store.listRequirementProjects('DEMO-6205').length, 0)
})
