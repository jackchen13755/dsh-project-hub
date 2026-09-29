/**
 * lib/tools.js —— 模型可见工具面（`ph_*`）。
 *
 * 契约（DESIGN §7）：注册成原始 JSON Schema 定义，必须有
 * `name / description / parameters / execute / output{ schema, render }`。
 * 这里既验结构，也用真 store（临时 DSH_HOME）把 10 个 `execute` 全跑一遍。
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { buildTools, cwdOf } from '../lib/tools.js'
import {
  assertSchemaRequired,
  at,
  evHeader,
  evUser,
  mangleCwd,
  openStore,
  useTempHome,
  writeFixture,
  writeSessionFrames,
} from './helpers.js'

const EXPECTED_NAMES = [
  'ph_save_requirement',
  'ph_get_requirement',
  'ph_list_requirements',
  'ph_list_projects',
  'ph_log_work',
  'ph_link',
  'ph_brief',
  'ph_drift',
  'ph_review',
  'ph_search',
  'ph_scan_sessions',
  'ph_report',
  'ph_archive',
  'ph_doc_title',
]

let tmp = null
let store = null
let tools = null
let byName = null

beforeEach(() => {
  tmp = useTempHome()
  store = openStore()
  tools = buildTools({ store, config: {}, version: '0.1.0-test' })
  byName = new Map(tools.map((t) => [t.name, t]))
})

afterEach(() => {
  try {
    store?.close()
  } catch {
    /* 已关闭 */
  }
  store = null
  tools = null
  byName = null
  tmp?.restore()
  tmp = null
})

const run = (name, args, exec) => byName.get(name).execute(args, exec)

test('tools: buildTools 返回 14 个工具，结构契约齐全', () => {
  assert.equal(tools.length, 14)
  assert.deepEqual(tools.map((t) => t.name), EXPECTED_NAMES)
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string')
    assert.ok(tool.description.length > 20, `${tool.name} 的 description 太短`)
    assert.equal(tool.parameters.type, 'object', `${tool.name}.parameters 应是 object`)
    assert.ok(Array.isArray(tool.parameters.required), `${tool.name}.parameters.required 应是数组`)
    assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(typeof tool.execute, 'function')
    assert.ok(tool.output, `${tool.name} 缺少 output`)
    assert.equal(tool.output.schema.type, 'object')
    assert.ok(tool.output.schema.required.includes('text'), `${tool.name}.output.schema.required 应含 text`)
    assert.equal(typeof tool.output.render, 'function')
  }

  // render 契约：只回 text 段
  for (const tool of tools) {
    assert.deepEqual(tool.output.render({}, { text: 'x' }), [{ type: 'text', text: 'x' }])
    assert.deepEqual(tool.output.render({ whatever: 1 }, { text: 'x', id: 'SPMS-1' }), [{ type: 'text', text: 'x' }])
    assert.deepEqual(tool.output.render({}, { text: '' }), [{ type: 'text', text: '' }])
  }

  // 必填参数
  assert.deepEqual(byName.get('ph_get_requirement').parameters.required, ['id'])
  // ph_log_work 现在是「新增或编辑」：传 id 即编辑，title 不再强制必填
  assert.deepEqual(byName.get('ph_log_work').parameters.required, [])
  assert.ok(byName.get('ph_log_work').parameters.properties.id, '应支持按 id 编辑记录')
  assert.deepEqual(byName.get('ph_archive').parameters.required, ['target', 'id'])
  assert.deepEqual(byName.get('ph_doc_title').parameters.required, ['url'])
  assert.deepEqual(byName.get('ph_save_requirement').parameters.required, [], '项目/id 都能从会话 cwd 推')

  // 枚举约束
  assert.deepEqual(byName.get('ph_archive').parameters.properties.target.enum, ['requirement', 'log', 'project'])
  assert.deepEqual(byName.get('ph_list_requirements').parameters.properties.archived.enum, ['exclude', 'only', 'include'])
  assert.deepEqual(byName.get('ph_log_work').parameters.properties.kind.enum, ['dev', 'bug', 'doc', 'review', 'meeting', 'release', 'other'])
  assert.deepEqual(byName.get('ph_save_requirement').parameters.properties.tags.type, 'array')
  assert.equal(byName.get('ph_save_requirement').parameters.properties.readTitle.type, 'boolean')
  assert.equal(byName.get('ph_scan_sessions').parameters.properties.dryRun.type, 'boolean')

  // 工具名不得重复
  assert.equal(new Set(EXPECTED_NAMES).size, EXPECTED_NAMES.length)
})

test('tools: ph_save_requirement / ph_get_requirement 走真 store', async () => {
  const doc = writeFixture(tmp.dir, 'req-5921.md', '---\ntitle: 需求甲：分页越界修复\n---\n\n# 别的标题\n')

  const created = await run('ph_save_requirement', {
    project: 'spms',
    no: '5921',
    docUrl: doc,
    priority: 'P0',
    tags: ['分页', '回归'],
  })
  assertSchemaRequired(created, byName.get('ph_save_requirement').output.schema, 'ph_save_requirement')
  assert.equal(created.id, 'SPMS-5921')
  assert.equal(created.created, true)
  assert.match(created.text, /已新建需求 SPMS-5921/)
  assert.match(created.text, /需求甲：分页越界修复/)
  assert.match(created.text, /来源 markdown-frontmatter/)

  const updated = await run('ph_save_requirement', { id: 'SPMS-5921', title: '手写标题' })
  assert.equal(updated.created, false)
  assert.match(updated.text, /已更新需求 SPMS-5921/)

  // 未给标题 + 文档读不到 → 只提示，不报错
  const noTitle = await run('ph_save_requirement', { project: 'spms', no: '9999', docUrl: join(tmp.dir, 'nope.md') })
  assert.equal(noTitle.created, true)
  assert.match(noTitle.text, /文档标题没读到/)

  const got = await run('ph_get_requirement', { id: 'SPMS-5921' })
  assertSchemaRequired(got, byName.get('ph_get_requirement').output.schema, 'ph_get_requirement')
  assert.equal(got.id, 'SPMS-5921')
  assert.match(got.text, /手写标题/)
  assert.match(got.text, /^SPMS-5921/)
  assert.match(got.text, /开发记录 0 条/)

  const missing = await run('ph_get_requirement', { id: 'SPMS-0000' })
  assert.equal(missing.id, 'SPMS-0000')
  assert.match(missing.text, /没有找到需求 SPMS-0000/)

  // 按号查找（带 project）
  const byNo = await run('ph_get_requirement', { id: '5921', project: 'spms' })
  assert.equal(byNo.id, 'SPMS-5921')
})

test('tools: ph_log_work / ph_search / ph_list_requirements / ph_list_projects / ph_report', async () => {
  await run('ph_save_requirement', { project: 'spms', no: '5921', title: '分页越界修复' })

  const log = await run('ph_log_work', {
    title: '修复 55036 分页越界',
    project: 'spms',
    requirement: 'SPMS-5921',
    kind: 'bug',
    date: '2026-03-05',
    detail: '改了 offset 计算',
    minutes: 90,
  })
  assertSchemaRequired(log, byName.get('ph_log_work').output.schema, 'ph_log_work')
  assert.ok(log.id > 0)
  assert.match(log.text, /已记录 #\d+/)
  assert.match(log.text, /\[bug\]/)
  assert.match(log.text, /需求 SPMS-5921/)

  const searched = await run('ph_search', { q: '分页' })
  assertSchemaRequired(searched, byName.get('ph_search').output.schema, 'ph_search')
  assert.equal(searched.requirements, 1)
  assert.equal(searched.logs, 1)
  assert.match(searched.text, /需求命中 1 条，开发记录命中 1 条/)

  const listed = await run('ph_list_requirements', {})
  assertSchemaRequired(listed, byName.get('ph_list_requirements').output.schema, 'ph_list_requirements')
  assert.equal(listed.count, 1)
  assert.equal(listed.total, 1)
  assert.match(listed.text, /共 1 条/)

  const noneListed = await run('ph_list_requirements', { q: '查不到的词' })
  assert.equal(noneListed.total, 0)
  assert.equal(noneListed.text, '（没有匹配的需求）')

  const projects = await run('ph_list_projects', {})
  assertSchemaRequired(projects, byName.get('ph_list_projects').output.schema, 'ph_list_projects')
  assert.equal(projects.count, 1)
  assert.match(projects.text, /台账里的项目 1 个/)
  assert.match(projects.text, /spms/)
  assert.match(projects.text, /候选项目/)

  const report = await run('ph_report', {})
  assertSchemaRequired(report, byName.get('ph_report').output.schema, 'ph_report')
  assert.equal(report.days, 1)
  assert.match(report.text, /2026-03-05/)

  const emptyReport = await run('ph_report', { from: '2030-01-01' })
  assert.equal(emptyReport.days, 0)
  assert.match(emptyReport.text, /这段时间没有任何开发记录/)
})

test('tools: ph_scan_sessions 扫合成会话（真 store），dryRun 不写库', async () => {
  const cwd = tmp.projectCwd('spms')
  writeSessionFrames(tmp.sessionsRoot, {
    sessionId: 'sess-tool-1',
    mangled: mangleCwd(cwd),
    frames: [
      [evHeader({ id: 'sess-tool-1', cwd, createdAt: at('2026-03-01T02:00:00Z') }), evUser('【5921】和 bug55036 一起修', at('2026-03-01T02:00:00Z'))],
      [evUser('需求 22 继续', at('2026-03-02T02:00:00Z')), evUser('整理文档', at('2026-03-03T02:00:00Z'))],
    ],
  })

  const scanned = await run('ph_scan_sessions', { limit: 10 })
  assertSchemaRequired(scanned, byName.get('ph_scan_sessions').output.schema, 'ph_scan_sessions')
  assert.equal(scanned.changed, 1)
  assert.equal(scanned.logs, 4)
  assert.match(scanned.text, /会话文件 1 个/)
  assert.match(scanned.text, /覆盖日期：2026-03-01, 2026-03-02, 2026-03-03/)
  assert.match(scanned.text, /→ spms/)
  assert.match(scanned.text, /「【5921】和 bug55036 一起修」/, '没有 session/title 时用首条用户消息当标题')
  assert.equal(store.counts().workLogs, 4)

  const again = await run('ph_scan_sessions', {})
  assert.equal(again.changed, 0)
  assert.match(again.text, /跳过 1 个/)

  store.purgeScanData()
  const dry = await run('ph_scan_sessions', { dryRun: true })
  assert.equal(dry.changed, 1)
  assert.match(dry.text, /（dryRun，未写库）/)
  assert.equal(store.counts().workLogs, 0)

  // since 支持 YYYY-MM-DD 与毫秒时间戳
  const rangedDate = await run('ph_scan_sessions', { since: '2020-01-01', limit: 5 })
  assert.equal(rangedDate.changed, 1)
  store.purgeScanData()
  const rangedMs = await run('ph_scan_sessions', { since: Date.now() + 60_000, limit: 5 })
  assert.equal(rangedMs.changed, 0)
  assert.equal(rangedMs.logs, 0)
})

test('tools: ph_archive 三种 target + 恢复 + 找不到', async () => {
  await run('ph_save_requirement', { project: 'spms', no: '5921', title: '甲' })
  const log = await run('ph_log_work', { title: '记录一', project: 'spms', requirement: 'SPMS-5921', date: '2026-03-05' })

  const archivedReq = await run('ph_archive', { target: 'requirement', id: 'SPMS-5921' })
  assertSchemaRequired(archivedReq, byName.get('ph_archive').output.schema, 'ph_archive')
  assert.equal(archivedReq.changed, 1)
  assert.equal(archivedReq.text, '已归档需求 SPMS-5921')
  assert.equal(store.listRequirements().total, 0)
  assert.equal(store.listRequirements({ archived: 'only' }).total, 1)

  const restoredReq = await run('ph_archive', { target: 'requirement', id: 'SPMS-5921', archived: false })
  assert.equal(restoredReq.changed, 1)
  assert.equal(restoredReq.text, '已恢复需求 SPMS-5921')
  assert.equal(store.listRequirements().total, 1)

  const archivedLog = await run('ph_archive', { target: 'log', id: log.id })
  assert.equal(archivedLog.changed, 1)
  assert.equal(archivedLog.text, `已归档记录 #${log.id}`)
  assert.equal(store.listLogs().total, 0)
  assert.equal((await run('ph_archive', { target: 'log', id: log.id, archived: false })).changed, 1)

  const archivedProject = await run('ph_archive', { target: 'project', id: 'spms' })
  assert.equal(archivedProject.changed, 1)
  assert.equal(archivedProject.text, '已归档项目 spms')
  assert.equal(store.listProjects().length, 0)
  assert.equal((await run('ph_archive', { target: 'project', id: 'spms', archived: false })).changed, 1)

  const notFound = await run('ph_archive', { target: 'requirement', id: 'SPMS-0000' })
  assert.equal(notFound.changed, 0)
  assert.equal(notFound.text, '没找到需求 SPMS-0000')
  assert.equal((await run('ph_archive', { target: 'log', id: 987654 })).text, '没找到记录 #987654')
  assert.equal((await run('ph_archive', { target: 'project', id: 'nope' })).text, '没找到项目 nope')
})

test('tools: ph_doc_title 读本地文件；exec 里的会话 cwd 当项目缺省值', async () => {
  const doc = writeFixture(tmp.dir, 'design.md', '# 后端设计：分页越界\n')
  const title = await run('ph_doc_title', { url: doc })
  assertSchemaRequired(title, byName.get('ph_doc_title').output.schema, 'ph_doc_title')
  assert.equal(title.title, '后端设计：分页越界')
  assert.match(title.text, /后端设计：分页越界（来源 markdown-h1）/)

  const failed = await run('ph_doc_title', { url: join(tmp.dir, 'nope.md') })
  assert.equal(failed.title, '')
  assert.match(failed.text, /没读到标题/)

  // exec.cwd 提供项目：不给 project 也能落到 spms
  const cwd = tmp.projectCwd('spms')
  const exec = { agent: { session: { header: { cwd } } } }
  const saved = await run('ph_save_requirement', { no: '5921' }, exec)
  assert.equal(saved.id, 'SPMS-5921')
  assert.match(saved.text, /项目：spms/)

  const logged = await run('ph_log_work', { title: '会话 cwd 推项目' }, exec)
  assert.match(logged.text, /项目 spms/)

  assert.equal(cwdOf(exec), cwd)
  assert.equal(cwdOf({ agent: {} }), null)
  assert.equal(cwdOf(null), null)
  assert.equal(cwdOf({ get agent() { throw new Error('boom') } }), null)
})
