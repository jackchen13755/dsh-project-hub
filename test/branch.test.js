/**
 * 「开新会话」拆成两个：一个**带「从 master 拉新分支并切换」的提示词**，一个与原来完全一样。
 * 分支格式（用户给定）：`feature/YYYYMMDD-需求名称英文-需求号`。
 *
 * 三个必须钉住的点：
 *   ① 英文名 —— 标题多半是中文，只能取拉丁字母/数字段；纯中文标题退化成 `req` 而不是空串；
 *   ② 确定性 —— 同一需求同一天必须生成同一个分支名（否则每点一次都开新分支）；
 *   ③ **不带 branch 的提示词一个字节都没变** —— 另一个按钮就要求「和现在一样」。
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { branchFormatHint, branchName, englishSlug, requirementNumber } from '../lib/branch.js'
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
