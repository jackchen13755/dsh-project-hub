/**
 * 「开新会话」的拉分支有两种基线（用户 2026-09-30 要求）：
 *   ① 从 **master** 拉 —— 原来的唯一行为，一个字没变（`branch:true` 仍等价）；
 *   ② 从 **当前分支** 拉 —— 基线是当前 HEAD，不 fetch、不切 master，但要先清工作区。
 * 分支格式（用户给定）：`feature/YYYYMMDD-需求名称英文-需求号`。
 *
 * 四个必须钉住的点：
 *   ① 英文名 —— 标题多半是中文，只能取拉丁字母/数字段；纯中文标题退化成 `req` 而不是空串；
 *   ② 确定性 —— 同一需求同一天必须生成同一个分支名（否则每点一次都开新分支）；
 *   ③ **不带 branch 的提示词一个字节都没变**；
 *   ④ 两种基线的提示词**只差分支那一段**：命令与风险提醒不同，其余段一字不差。
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { branchFormatHint, branchName, englishSlug, normBranchMode, requirementNumber } from '../lib/branch.js'
import { buildRequirementBrief } from '../lib/brief.js'
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

test('englishSlug：只留英文/数字段，去掉标题里的需求号与中文', () => {
  assert.equal(englishSlug('【5922】L&F Q3 Enhancements/Queue数据记录'), 'l-f-q3-enhancements-queue')
  assert.equal(englishSlug('[6031] Profile Search/Create/Edit 需求变更'), 'profile-search-create-edit')
  assert.equal(englishSlug('房态看板改造'), '', '纯中文标题拿不到英文名')
  assert.equal(englishSlug('  ---  '), '')
  assert.ok(englishSlug('a'.repeat(80)).length <= 40, '超长要截断')
  assert.ok(!englishSlug('A B').endsWith('-'))
})

test('requirementNumber：优先 no，否则取需求 ID 尾巴上的数字', () => {
  assert.equal(requirementNumber({ no: '5922', id: 'SPMS-5922' }), '5922')
  assert.equal(requirementNumber({ no: null, id: 'SPMS-5922' }), '5922')
  assert.equal(requirementNumber({ no: '  6001 ', id: 'X' }), '6001')
  assert.equal(requirementNumber({ no: null, id: 'NO-DIGITS' }), '')
})

test('branchName：feature/YYYYMMDD-英文名-需求号；同一天同需求稳定复现', () => {
  const req = { id: 'SPMS-5922', no: '5922', title: '【5922】L&F Q3 Enhancements/Queue数据记录' }
  assert.equal(branchName(req, { date: '2026-09-29' }), 'feature/20260929-l-f-q3-enhancements-queue-5922')
  assert.equal(branchName(req, { date: '20260929' }), branchName(req, { date: '2026-09-29' }), '两种日期写法等价')
  assert.equal(branchName(req, { date: '2026-09-29' }), branchName(req, { date: '2026-09-29' }), '确定性')
  // 纯中文标题 → 退化成 req，但格式仍然成立
  assert.equal(branchName({ id: 'SPMS-7001', no: '7001', title: '房态看板改造' }, { date: '2026-09-29' }), 'feature/20260929-req-7001')
  // 没有需求号也能拼出来（只是少一段）
  assert.equal(branchName({ id: 'SPMS-X', no: null, title: 'Queue Board' }, { date: '2026-09-29' }), 'feature/20260929-queue-board')
  assert.match(branchFormatHint(), /feature\/YYYYMMDD-需求名称英文-需求号/)
})

test('提示词：branch=true 才加「从 master 拉新分支」段落', async () => {
  await store.saveRequirement({
    id: 'SPMS-5922',
    no: '5922',
    project: 'spms',
    title: '【5922】L&F Q3 Enhancements/Queue数据记录',
    readTitle: false,
    links: [{ kind: 'doc', url: 'https://doc.example/5922', title: '需求文档' }],
  })

  const plain = buildRequirementBrief(store, 'SPMS-5922')
  assert.equal(plain.branch, null)
  assert.ok(!plain.brief.includes('拉新分支'), '不带 branch 的提示词不能出现分支段落')
  assert.ok(!plain.brief.includes('git checkout'), '不带 branch 的提示词不能出现 git 命令')

  const withBranch = buildRequirementBrief(store, 'SPMS-5922', { branch: true })
  assert.match(withBranch.branch, /^feature\/\d{8}-l-f-q3-enhancements-queue-5922$/)
  assert.match(withBranch.brief, /## 开工前：从 master 拉新分支并切过去/)
  assert.match(withBranch.brief, /命名格式：feature\/YYYYMMDD-需求名称英文-需求号/)
  assert.match(withBranch.brief, /git fetch origin && git checkout -b feature\/\d{8}-l-f-q3-enhancements-queue-5922 origin\/master/)
  assert.match(withBranch.brief, /这个分支已经存在就直接/)
  assert.match(withBranch.brief, /\*\*基线是 master\*\*/)
  // 其它段落照旧（只是多了一段）
  assert.match(withBranch.brief, /## 资料链接/)
  assert.match(withBranch.brief, /https:\/\/doc\.example\/5922/)

  // 两个按钮的提示词**只差这一段**：把分支段整块去掉（并归一空行）后必须完全一致
  const stripBranch = (text) =>
    String(text)
      .split('\n')
      .filter((line) => !line.startsWith('## 开工前：'))
      .filter((line) => !/^- (分支名|命名格式|命令|\*\*基线是 master\*\*|不要把 master)/.test(line))
      .join('\n')
      .replace(/\n{2,}/g, '\n')
      .trim()
  assert.equal(stripBranch(withBranch.brief), stripBranch(plain.brief), '除分支段外，两份提示词必须一致')
})

test('API：GET /brief?branch=1 与 POST /open-session {branch:true}', async () => {
  await store.saveRequirement({ id: 'SPMS-6001', no: '6001', project: 'spms', title: '[6001] Profile Search/Create/Edit 需求变更', readTitle: false })

  const plain = await callApi(api.handler, { method: 'GET', url: `${BASE}/brief?id=SPMS-6001` })
  assert.equal(plain.json.branch, null)
  const branched = await callApi(api.handler, { method: 'GET', url: `${BASE}/brief?id=SPMS-6001&branch=1` })
  assert.match(branched.json.branch, /^feature\/\d{8}-profile-search-create-edit-6001$/)
  assert.match(branched.json.brief, /开工前：从 master 拉新分支/)

  const session = await callApi(api.handler, { method: 'POST', url: `${BASE}/open-session`, body: { id: 'SPMS-6001', branch: true } })
  assert.equal(session.statusCode, 200)
  assert.match(session.json.branch, /-6001$/)
  assert.match(session.json.prompt, /origin\/master/)
  const noBranch = await callApi(api.handler, { method: 'POST', url: `${BASE}/open-session`, body: { id: 'SPMS-6001' } })
  assert.equal(noBranch.json.branch, null)
  assert.ok(!noBranch.json.prompt.includes('origin/master'), '默认按钮不开分支')
})

test('工具：ph_brief {branch:true} 返回分支名', async () => {
  await store.saveRequirement({ id: 'SPMS-6002', no: '6002', project: 'spms', title: 'Queue Board', readTitle: false })
  const plain = await byName.get('ph_brief').execute({ id: 'SPMS-6002' })
  assert.equal(plain.branch, '')
  const branched = await byName.get('ph_brief').execute({ id: 'SPMS-6002', branch: true })
  assert.match(branched.branch, /^feature\/\d{8}-queue-board-6002$/)
  assert.match(branched.text, /git checkout -b feature\//)
})

test('normBranchMode：三种取值，且兼容旧的 true', () => {
  for (const off of [false, null, undefined, '', '0', 'false', 'off', 'no']) {
    assert.equal(normBranchMode(off), false, `${String(off)} → 不带分支段`)
  }
  for (const master of [true, 'true', '1', 'master', 'origin/master', 'yes']) {
    assert.equal(normBranchMode(master), 'master', `${String(master)} → master`)
  }
  for (const current of ['current', 'Current', ' head ', 'current-branch']) {
    assert.equal(normBranchMode(current), 'current', `${String(current)} → current`)
  }
})

test('提示词：branch=current 从**当前分支**拉 —— 不 fetch、不切 master，但要先清工作区', async () => {
  await store.saveRequirement({
    id: 'SPMS-5923',
    no: '5923',
    project: 'spms',
    title: 'Queue 数据记录',
    readTitle: false,
    links: [{ kind: 'doc', url: 'https://doc.example/5923', title: '需求文档' }],
  })
  const cur = buildRequirementBrief(store, 'SPMS-5923', { branch: 'current' })

  assert.equal(cur.branchMode, 'current')
  assert.match(cur.branch, /^feature\/\d{8}-queue-5923$/, '分支名与 master 那条一样（只是基线不同）')
  assert.match(cur.brief, /## 开工前：从\*\*当前分支\*\*拉新分支并切过去/)
  assert.match(cur.brief, /git checkout -b feature\/\d{8}-queue-5923/)
  assert.ok(!cur.brief.includes('origin/master'), 'current 基线不许出现 origin/master')
  assert.ok(!cur.brief.includes('git fetch'), 'current 基线不做 fetch')
  assert.match(cur.brief, /基线就是你当前所在的分支/)
  assert.match(cur.brief, /别把当前分支上的无关改动带进这个新分支/, '要提醒先清工作区')
  assert.match(cur.brief, /这个分支已经存在就直接/, '两种基线都要说清「已存在就直接切」')
  assert.match(cur.brief, /## 资料链接/, '其余段落照旧')
})

test('两种基线只差分支那一段（其余一字不差）；branch:true 与 master 完全等价', async () => {
  await store.saveRequirement({ id: 'SPMS-5924', no: '5924', project: 'spms', title: 'Queue 数据记录', readTitle: false })

  const master = buildRequirementBrief(store, 'SPMS-5924', { branch: 'master' }).brief
  const current = buildRequirementBrief(store, 'SPMS-5924', { branch: 'current' }).brief
  assert.equal(buildRequirementBrief(store, 'SPMS-5924', { branch: true }).brief, master, '旧写法 true 必须与 master 一模一样')

  const stripBranch = (text) =>
    String(text)
      .split('\n')
      .filter((line) => !line.startsWith('## 开工前：'))
      .filter((line) => !/^- (分支名|命名格式|命令|工作区|别把当前分支|\*\*基线|不要把 master|提交只包含)/.test(line))
      .join('\n')
      .replace(/\n{2,}/g, '\n')
      .trim()
  assert.equal(stripBranch(master), stripBranch(current), '除分支段外，两种基线必须完全一致')
  assert.notEqual(master, current, '分支段本身必须不同（不能只换了标题）')
})

test('API：GET /brief?branch=current 与 POST /open-session {branch:"current"}', async () => {
  await store.saveRequirement({ id: 'SPMS-6003', no: '6003', project: 'spms', title: 'Queue Board', readTitle: false })

  const cur = await callApi(api.handler, { method: 'GET', url: `${BASE}/brief?id=SPMS-6003&branch=current` })
  assert.equal(cur.json.branchMode, 'current')
  assert.match(cur.json.brief, /从\*\*当前分支\*\*拉新分支/)

  const byName2 = await callApi(api.handler, { method: 'GET', url: `${BASE}/brief?id=SPMS-6003&branch=master` })
  assert.equal(byName2.json.branchMode, 'master', '?branch=master 也认')
  assert.match(byName2.json.brief, /origin\/master/)

  const session = await callApi(api.handler, { method: 'POST', url: `${BASE}/open-session`, body: { id: 'SPMS-6003', branch: 'current' } })
  assert.equal(session.statusCode, 200)
  assert.equal(session.json.branchMode, 'current')
  assert.match(session.json.prompt, /从\*\*当前分支\*\*拉新分支/)
  assert.ok(!session.json.prompt.includes('origin/master'), 'current 那条不许出现 origin/master')
})

test('工具：ph_brief {branch:"current"} 走当前分支；旧的 "true" 仍当 master', async () => {
  await store.saveRequirement({ id: 'SPMS-6004', no: '6004', project: 'spms', title: 'Queue Board', readTitle: false })

  const cur = await byName.get('ph_brief').execute({ id: 'SPMS-6004', branch: 'current' })
  assert.equal(cur.branchMode, 'current')
  assert.match(cur.text, /从\*\*当前分支\*\*拉新分支/)
  assert.ok(!cur.text.includes('origin/master'))

  const legacy = await byName.get('ph_brief').execute({ id: 'SPMS-6004', branch: 'true' })
  assert.equal(legacy.branchMode, 'master', '旧的字符串 true 仍当 master')
  assert.match(legacy.text, /origin\/master/)
})
