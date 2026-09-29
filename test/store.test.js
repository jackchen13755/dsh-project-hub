/**
 * lib/store.js —— 领域层（项目 / 需求台账 / 开发记录 / 检索 / 报表 / 会话扫描落库）。
 *
 * 每个 test 一个全新临时 `DSH_HOME`（`Store.open()` 走 process.env），
 * 结束时 close + 删目录。核心断言是**扫描落库幂等**：连跑两次 changed=0、work_logs 不增长，
 * 连 `full:true` 重扫也不重复（靠 `(date,project_id,requirement_id,session_id) WHERE source='session-scan'`
 * 这个部分唯一索引）。
 */
import assert from 'node:assert/strict'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { setMeta } from '../lib/db.js'
import { dateInTz } from '../lib/paths.js'
import { SCHEMA_VERSION } from '../lib/schema.js'
import { Store } from '../lib/store.js'
import {
  at,
  evHeader,
  evTitle,
  evToolCall,
  evUser,
  mangleCwd,
  openStore,
  useTempHome,
  writeFixture,
  writeSessionFrames,
} from './helpers.js'

const TA = at('2026-03-01T02:00:00Z') // 上海 2026-03-01 10:00
const TB = at('2026-03-02T02:00:00Z') // 上海 2026-03-02 10:00
const TC = at('2026-03-03T02:00:00Z') // 上海 2026-03-03 10:00
const TD = at('2026-03-04T02:00:00Z') // 上海 2026-03-04 10:00

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

/** 合成一个两帧会话：3 天、3 个需求号 + 1 天没有需求号。 */
function seedSession(t, extraFrame = null) {
  const cwd = t.projectCwd('spms')
  const frames = [
    [
      evHeader({ id: 'sess-store-1', cwd, createdAt: TA - 60000, agentPreset: 'dsh' }),
      evTitle('SPMS 批量修复', TA),
      evUser('【5921】和 bug55036 一起修', TA),
      evToolCall('bash', TA),
    ],
    [evUser('需求 22 继续', TB), evUser('整理文档，没有需求号', TC)],
  ]
  if (extraFrame) frames.push(extraFrame)
  const written = writeSessionFrames(t.sessionsRoot, { sessionId: 'sess-store-1', mangled: mangleCwd(cwd), frames })
  return { cwd, ...written }
}

const logIds = (s) => s.listLogs({ archived: 'include', limit: 100 }).items.map((l) => l.id).sort((a, b) => a - b)

// ── 打开 / 迁移 ────────────────────────────────────────────────────────────

test('store: Store.open 走 DSH_HOME 建库并迁移；打开失败只返回 error 不抛', () => {
  assert.equal(dateInTz(TA), '2026-03-01')
  assert.equal(store.dbPath, join(tmp.home, 'project-hub', 'hub.db'))
  assert.equal(existsSync(store.dbPath), true, '库文件应该被创建')
  assert.equal(existsSync(join(tmp.home, 'project-hub')), true)

  const status = store.status({ version: '9.9.9', scanIntervalMinutes: 15 })
  assert.equal(status.ok, true)
  assert.equal(status.version, '9.9.9')
  assert.equal(status.scanIntervalMinutes, 15)
  assert.equal(status.dbPath, store.dbPath)
  assert.equal(status.schemaVersion, SCHEMA_VERSION)
  assert.ok(SCHEMA_VERSION >= 1)
  assert.equal(status.lastScanAt, null)
  assert.equal(status.lastScan, null)
  assert.deepEqual(status.counts, {
    projects: 0,
    requirements: 0,
    archivedRequirements: 0,
    workLogs: 0,
    archivedLogs: 0,
    manualLogs: 0,
    scanLogs: 0,
    activity: 0,
    scannedSessions: 0,
    activeDays: 0,
  })

  // 显式 env 参数也能指定另一个库
  const other = join(tmp.dir, 'other-home')
  const opened = Store.open({}, { DSH_HOME: other })
  assert.equal(opened.error, undefined)
  assert.equal(opened.store.dbPath, join(other, 'project-hub', 'hub.db'))
  opened.store.close()

  // DSH_HOME 指向一个「文件」→ 建目录失败 → 返回 error，不抛（index.js 靠它空转）
  const asFile = writeFixture(tmp.dir, 'not-a-dir', 'x')
  const broken = Store.open({}, { DSH_HOME: asFile })
  assert.equal(broken.store, null)
  assert.equal(typeof broken.error, 'string')
  assert.ok(broken.error.length > 0)
})

// ── 需求台账 ──────────────────────────────────────────────────────────────

test('store: saveRequirement 自动拼 id（spms+5921 → SPMS-5921）并回填 docTitle；重复保存是更新', async () => {
  const doc = writeFixture(tmp.dir, 'req-5921.md', '---\ntitle: 需求甲：分页越界修复\n---\n\n# 别的标题\n')

  const first = await store.saveRequirement({ project: 'spms', no: '5921', docUrl: doc })
  assert.equal(first.created, true)
  assert.equal(first.requirement.id, 'SPMS-5921')
  assert.equal(first.requirement.no, '5921')
  assert.equal(first.requirement.projectId, 'spms')
  assert.equal(first.requirement.projectName, 'spms')
  assert.equal(first.requirement.status, 'developing')
  assert.equal(first.titleRead.ok, true)
  assert.equal(first.titleRead.title, '需求甲：分页越界修复')
  assert.equal(first.titleRead.source, 'markdown-frontmatter')
  assert.equal(first.requirement.docTitle, '需求甲：分页越界修复', 'docTitle 要落库')
  assert.equal(first.requirement.title, '需求甲：分页越界修复', 'title 缺省用文档标题')
  assert.equal(first.requirement.docUrl, doc)
  assert.ok(first.requirement.docTitleAt > 0)
  assert.ok(first.requirement.createdAt > 0)
  assert.equal(first.requirement.archivedAt, null)

  // 重复保存 → 更新，不是新增
  const again = await store.saveRequirement({ project: 'spms', no: '5921', title: '手写标题' })
  assert.equal(again.created, false)
  assert.equal(again.requirement.id, 'SPMS-5921')
  assert.equal(again.requirement.title, '手写标题')
  assert.equal(again.requirement.docTitle, '需求甲：分页越界修复', '没给 docUrl 时保留原 docTitle')
  const listed = store.listRequirements()
  assert.equal(listed.total, 1, '同一个需求 id 只应有一行')
  assert.equal(listed.items[0].id, 'SPMS-5921')

  // 只给 id：从尾部数字反推 no；项目不同 → 各自一行
  const byId = await store.saveRequirement({ project: 'spms', id: 'SPMS-7777', tags: 'p0, 分页；回归' })
  assert.equal(byId.requirement.id, 'SPMS-7777')
  assert.equal(byId.requirement.no, '7777')
  assert.deepEqual(byId.requirement.tags, ['p0', '分页', '回归'])
  const otherProject = await store.saveRequirement({ project: 'spms-ui', no: '7777' })
  assert.equal(otherProject.requirement.id, 'SPMS-UI-7777')
  assert.equal(store.listRequirements().total, 3)

  // 状态别名
  const aliased = await store.saveRequirement({ project: 'spms', no: '5921', status: '开发中', priority: 'P0' })
  assert.equal(aliased.requirement.status, 'developing')
  assert.equal(aliased.requirement.priority, 'P0')

  // readTitle:false 不读文档标题
  const noRead = await store.saveRequirement({ project: 'spms', no: '8888', docUrl: doc, readTitle: false })
  assert.equal(noRead.titleRead, null)
  assert.equal(noRead.requirement.docTitle, null)

  // 文档读不到 → 保存照常成功，只是没有标题
  const missingDoc = await store.saveRequirement({ project: 'spms', no: '9999', docUrl: join(tmp.dir, 'nope.md') })
  assert.equal(missingDoc.titleRead.ok, false)
  assert.equal(missingDoc.titleRead.source, 'missing')
  assert.equal(missingDoc.requirement.docTitle, null)
  assert.equal(missingDoc.requirement.title, null)

  // 两个都没有 → 抛（API 层翻成 400）
  await assert.rejects(() => store.saveRequirement({ project: 'spms' }), /缺少需求 ID/)
})

test('store: addLog（kind=bug、指定 date）后 requirement.lastWorkedAt 更新', async () => {
  await store.saveRequirement({ project: 'spms', no: '5921', title: '分页越界修复' })
  const read = () => store.rowToRequirement(store.requirementDetail('SPMS-5921'))

  assert.equal(read().lastWorkedAt, null)
  assert.equal(read().workCount, 0)

  const log = store.addLog({
    date: '2026-03-05',
    project: 'spms',
    requirement: 'SPMS-5921',
    kind: 'bug',
    title: '修复分页越界',
    detail: '改了 offset 计算',
    minutes: 90,
  })
  assert.ok(log.id > 0)
  assert.equal(log.date, '2026-03-05')
  assert.equal(log.kind, 'bug')
  assert.equal(log.projectId, 'spms')
  assert.equal(log.projectName, 'spms')
  assert.equal(log.requirementId, 'SPMS-5921')
  assert.equal(log.requirementTitle, '分页越界修复')
  assert.equal(log.title, '修复分页越界')
  assert.equal(log.minutes, 90)
  assert.equal(log.source, 'manual')
  assert.equal(log.sessionId, null)
  assert.equal(log.archivedAt, null)

  const after = read()
  assert.equal(after.lastWorkedAt, '2026-03-05', 'addLog 要回写 lastWorkedAt')
  assert.equal(after.workCount, 1)
  assert.equal(after.lastWorkDate, '2026-03-05')

  // MAX 语义：更晚的日期推进，更早的日期不倒退
  store.addLog({ date: '2026-03-09', project: 'spms', requirement: 'SPMS-5921', title: '又改了一版' })
  assert.equal(read().lastWorkedAt, '2026-03-09')
  assert.equal(read().workCount, 2)
  store.addLog({ date: '2026-02-01', project: 'spms', requirement: 'SPMS-5921', title: '补记录' })
  assert.equal(read().lastWorkedAt, '2026-03-09', 'lastWorkedAt 不能被更早的日期改回去')

  // 未登记的需求号 → 用同一个公式拼临时 id 挂上
  const temp = store.addLog({ date: '2026-03-05', project: 'spms', requirement: '55036', title: '修 bug' })
  assert.equal(temp.requirementId, 'SPMS-55036')

  // kind 归一化 / 缺省值
  assert.equal(store.addLog({ project: 'spms', title: 'x', kind: '修bug' }).kind, 'bug')
  assert.equal(store.addLog({ project: 'spms', title: 'x', kind: '瞎写' }).kind, 'other')
  assert.equal(store.addLog({ project: 'spms', title: 'x' }).kind, 'dev')
  const noReq = store.addLog({ project: 'spms', title: '纯记录' })
  assert.equal(noReq.requirementId, '')
  assert.equal(noReq.date, dateInTz(Date.now()), '缺省日期 = 东八区今天')
  const defaulted = store.addLog({ project: 'spms' })
  assert.equal(defaulted.title, 'spms 开发', '缺省标题')

  assert.equal(store.listLogs().total, 9)
})

test('store: listRequirements / listLogs 的 archived exclude|only|include 三态', async () => {
  await store.saveRequirement({ project: 'spms', no: '5921', title: '甲' })
  await store.saveRequirement({ project: 'spms', no: '5922', title: '乙' })
  const log1 = store.addLog({ project: 'spms', requirement: 'SPMS-5921', title: '记录一', date: '2026-03-05' })
  const log2 = store.addLog({ project: 'spms', requirement: 'SPMS-5922', title: '记录二', date: '2026-03-06' })

  assert.equal(store.listRequirements().total, 2)
  assert.equal(store.listLogs().total, 2)

  assert.equal(store.archiveRequirement('SPMS-5921').changed, 1)
  assert.equal(store.archiveLog(log1.id).changed, 1)

  const reqExclude = store.listRequirements({ archived: 'exclude' })
  assert.equal(reqExclude.total, 1)
  assert.deepEqual(reqExclude.items.map((r) => r.id), ['SPMS-5922'])
  const reqOnly = store.listRequirements({ archived: 'only' })
  assert.equal(reqOnly.total, 1)
  assert.equal(reqOnly.items[0].id, 'SPMS-5921')
  assert.ok(reqOnly.items[0].archivedAt > 0)
  assert.equal(store.listRequirements({ archived: 'include' }).total, 2)
  assert.equal(store.listRequirements().total, 1, '缺省 = exclude')

  const logExclude = store.listLogs({ archived: 'exclude' })
  assert.equal(logExclude.total, 1)
  assert.deepEqual(logExclude.items.map((l) => l.id), [log2.id])
  assert.equal(store.listLogs({ archived: 'only' }).items[0].id, log1.id)
  assert.ok(store.listLogs({ archived: 'only' }).items[0].archivedAt > 0)
  assert.equal(store.listLogs({ archived: 'include' }).total, 2)
  assert.equal(store.counts().archivedRequirements, 1)
  assert.equal(store.counts().archivedLogs, 1)

  // 恢复
  const restored = store.archiveRequirement('SPMS-5921', false)
  assert.equal(restored.changed, 1)
  assert.equal(restored.requirement.archivedAt, null)
  assert.equal(store.listRequirements({ archived: 'only' }).total, 0)
  assert.equal(store.listRequirements().total, 2)
  const restoredLog = store.archiveLog(log1.id, false)
  assert.equal(restoredLog.changed, 1)
  assert.equal(restoredLog.log.archivedAt, null)
  assert.equal(store.listLogs().total, 2)

  // 不存在的对象 / 不支持的类型
  assert.deepEqual(store.archiveRequirement('SPMS-0000'), { changed: 0, requirement: null })
  assert.deepEqual(store.archiveLog(999999), { changed: 0, log: null })
  assert.equal(store.archiveProject('spms').changed, 1)
  assert.throws(() => store.setArchived('bogus', 'x'), /不支持的归档对象/)
  assert.equal(store.listProjects().length, 0, '归档的项目默认不出现')
  assert.equal(store.listProjects({ archived: 'only' }).length, 1)
})

// ── 会话扫描落库 ──────────────────────────────────────────────────────────

test('store: scanSessions 把多帧合成会话落库（活动 / 记录 / 项目 / 需求号）', async () => {
  const s = seedSession(tmp)
  assert.equal(store.needsRescan({ file: s.file, mtime: 1, bytes: 1 }), true, '没扫过 → 需要扫')
  assert.equal(store.scanState(s.file), null)

  const res = await store.scanSessions()
  assert.equal(res.files, 1)
  assert.equal(res.changed, 1)
  assert.equal(res.skipped, 0)
  assert.equal(res.activities, 6)
  assert.equal(res.logs, 4)
  assert.deepEqual(res.days, ['2026-03-01', '2026-03-02', '2026-03-03'])
  assert.deepEqual(res.errors, [])
  assert.equal(res.sessions.length, 1)
  assert.equal(res.sessions[0].sessionId, 'sess-store-1')
  assert.equal(res.sessions[0].cwd, s.cwd)
  assert.equal(res.sessions[0].projectId, 'spms')
  assert.equal(res.sessions[0].title, 'SPMS 批量修复')
  assert.equal(res.sessions[0].msgs, 3)
  assert.deepEqual(res.sessions[0].days, ['2026-03-01(2需求)', '2026-03-02(1需求)', '2026-03-03(0需求)'])

  // 项目按会话头的 cwd 建立
  const projects = store.listProjects()
  assert.equal(projects.length, 1)
  assert.equal(projects[0].id, 'spms')
  assert.equal(projects[0].name, 'spms')
  assert.equal(projects[0].root, s.cwd)
  assert.equal(projects[0].lastWorkedDate, '2026-03-03')
  assert.equal(projects[0].requirementCount, 0)

  // 工作记录：标题/类型/来源/证据
  const logs = store.listLogs({ source: 'session-scan', limit: 10 }).items
  assert.equal(logs.length, 4)
  const byDate = new Map(logs.map((l) => [`${l.date}|${l.requirementId}|${l.kind}`, l]))
  const dev = byDate.get('2026-03-01|SPMS-5921|dev')
  assert.equal(dev.title, '开发 SPMS-5921')
  assert.equal(dev.projectId, 'spms')
  assert.equal(dev.sessionId, 'sess-store-1')
  assert.equal(dev.detail, 'SPMS 批量修复')
  assert.equal(dev.evidence, '【5921】和 bug55036 一起修')
  assert.equal(dev.minutes, null)
  assert.equal(dev.source, 'session-scan')
  const bug = byDate.get('2026-03-01|SPMS-55036|bug')
  assert.equal(bug.title, '修复 SPMS-55036', 'bug 号的记录标题用「修复」')
  assert.equal(byDate.get('2026-03-02|SPMS-22|dev').title, '开发 SPMS-22')
  const projectLevel = logs.find((l) => l.date === '2026-03-03')
  assert.equal(projectLevel.requirementId, '', '没有需求号的那天记一条项目级记录')
  assert.equal(projectLevel.title, 'SPMS 批量修复')

  // 扫描水位
  const state = store.scanState(s.file)
  assert.equal(state.session_id, 'sess-store-1')
  assert.equal(state.project_id, 'spms')
  assert.equal(state.cwd, s.cwd)
  assert.equal(state.days, '2026-03-01,2026-03-02,2026-03-03')
  assert.equal(state.msgs, 3)
  assert.equal(state.events, 6)
  assert.equal(state.bytes, s.bytes)
  assert.equal(state.error, null)
  assert.equal(store.needsRescan({ file: s.file, mtime: state.mtime, bytes: state.bytes }), false)

  const counts = store.counts()
  assert.equal(counts.projects, 1)
  assert.equal(counts.workLogs, 4)
  assert.equal(counts.scanLogs, 4)
  assert.equal(counts.activity, 6)
  assert.equal(counts.scannedSessions, 1)
  assert.equal(counts.activeDays, 3)

  const meta = store.lastScan()
  assert.ok(meta.at > 0)
  assert.deepEqual(meta.result, { files: 1, changed: 1, skipped: 0, activities: 6, logs: 4, days: ['2026-03-01', '2026-03-02', '2026-03-03'], errors: 0 })

  // 没有需求号那天不该产生 activity 的需求行
  const timeline = store.timeline({ limit: 10 })
  assert.deepEqual(timeline.map((d) => d.date), ['2026-03-03', '2026-03-02', '2026-03-01'])
  const day3 = timeline[0]
  assert.equal(day3.projects[0].requirements.length, 0)
  assert.equal(day3.projects[0].projectName, 'spms')
  assert.equal(day3.sessionCount, 1)
})

test('store: scanSessions 增量幂等 —— 第二次 changed=0，清水位重扫也不重复增长', async () => {
  const s = seedSession(tmp)

  const first = await store.scanSessions()
  assert.equal(first.changed, 1)
  assert.equal(first.logs, 4)
  const idsAfterFirst = logIds(store)
  assert.equal(idsAfterFirst.length, 4)
  const countsAfterFirst = store.counts()

  // ② 未变化 → 整体跳过
  const second = await store.scanSessions()
  assert.equal(second.files, 1)
  assert.equal(second.changed, 0, '没变化的会话不该重扫')
  assert.equal(second.skipped, 1)
  assert.equal(second.activities, 0)
  assert.equal(second.logs, 0)
  assert.deepEqual(second.days, [])
  assert.deepEqual(logIds(store), idsAfterFirst, 'work_logs 不重复增长')
  assert.deepEqual(store.counts(), countsAfterFirst)

  // ③ 清掉扫描水位（= schema 迁移 v2 让派生数据重新派生的做法）→ 重扫：
  //    activity 走 upsert、work_logs 靠部分唯一索引挡住 → changed=1 但一条不新增
  store.db.prepare('DELETE FROM scanned_sessions').run()
  const rescanned = await store.scanSessions()
  assert.equal(rescanned.changed, 1)
  assert.equal(rescanned.skipped, 0)
  assert.equal(rescanned.logs, 0, '重扫不该新增 work_logs')
  assert.equal(rescanned.activities, 6, 'activity 是替换语义，条数不变')
  assert.deepEqual(logIds(store), idsAfterFirst)
  assert.deepEqual(store.counts(), countsAfterFirst)

  // ④ since 晚于 mtime → 跳过
  const skippedBySince = await store.scanSessions({ since: Date.now() + 60_000 })
  assert.equal(skippedBySince.changed, 0)
  assert.equal(skippedBySince.skipped, 1)
  assert.deepEqual(store.counts(), countsAfterFirst)

  // ⑤ 追加一帧（多帧追加的真实形态）→ 只补新增那一天
  const beforeState = store.scanState(s.file)
  seedSession(tmp, [evUser('又回到【5921】', TD)])
  const nowStat = statSync(s.file)
  assert.ok(nowStat.size > beforeState.bytes, '追加后文件变长')
  assert.equal(store.needsRescan({ file: s.file, mtime: nowStat.mtimeMs, bytes: nowStat.size }), true, '追加后 mtime/bytes 变了 → 需要重扫')
  const appended = await store.scanSessions()
  assert.equal(appended.changed, 1)
  assert.equal(appended.logs, 1, '只新增新那天的记录')
  // days 是「本次重扫覆盖到的所有天」（整个文件重解），不是「新增的天」
  assert.deepEqual(appended.days, ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04'])
  assert.equal(store.counts().workLogs, 5)
  assert.equal(store.counts().activity, 8)
  assert.deepEqual(logIds(store).slice(0, 4), idsAfterFirst, '老记录 id 不变、不新增')
  const newLog = store.listLogs({ from: '2026-03-04', to: '2026-03-04' }).items
  assert.equal(newLog.length, 1)
  assert.equal(newLog[0].requirementId, 'SPMS-5921')
  assert.equal(newLog[0].sessionId, 'sess-store-1')
})

test('store: scanSessions dryRun 只报告不写库（但会报「将写入多少」）', async () => {
  const s = seedSession(tmp)
  const dry = await store.scanSessions({ dryRun: true })
  assert.equal(dry.changed, 1)
  assert.deepEqual(dry.days, ['2026-03-01', '2026-03-02', '2026-03-03'], 'dryRun 也报会覆盖哪些天')
  assert.equal(dry.sessions.length, 1)
  assert.deepEqual(dry.sessions[0].days, ['2026-03-01(2需求)', '2026-03-02(1需求)', '2026-03-03(0需求)'])
  // dryRun 报的是「将会写入多少」：3 天会话级活动 + 3 条需求级活动；记录 = 3 条需求级 + 1 条项目级
  assert.equal(dry.activities, 6, 'dryRun 也要给出将会写入的活动条数（否则预览恒为 0）')
  assert.equal(dry.logs, 4, 'dryRun 报将会新增的记录条数')
  assert.equal(store.counts().workLogs, 0)
  assert.equal(store.counts().activity, 0)
  assert.equal(store.counts().scannedSessions, 0, 'dryRun 不写水位')
  assert.equal(store.scanState(s.file), null)
  assert.equal(store.lastScan().at, null, 'dryRun 不更新 last_scan_at')

  // dryRun 之后照常能正常扫
  const real = await store.scanSessions()
  assert.equal(real.changed, 1)
  assert.equal(real.logs, 4)
  assert.equal(store.counts().workLogs, 4)
})

test('store: purgeScanData 清派生行但保留手工记录，之后重扫能完整重建', async () => {
  seedSession(tmp)
  await store.scanSessions()
  const manual = store.addLog({ date: '2026-03-05', project: 'spms', title: '手工记录' })
  assert.equal(store.counts().workLogs, 5)

  const purged = store.purgeScanData()
  assert.deepEqual(purged, { logs: 4, activity: 6, sessions: 1 })
  assert.equal(store.counts().workLogs, 1, '只剩手工记录')
  assert.equal(store.counts().activity, 0)
  assert.equal(store.counts().scannedSessions, 0)
  assert.equal(store.getLog(manual.id).title, '手工记录')

  const rebuilt = await store.scanSessions()
  assert.equal(rebuilt.changed, 1)
  assert.equal(rebuilt.logs, 4, '重扫把派生的 4 条记录重建回来')
  assert.equal(store.counts().workLogs, 5)
  assert.equal(store.listLogs({ source: 'session-scan' }).total, 4)
  // 只清某个项目
  assert.deepEqual(store.purgeScanData({ project: 'spms' }), { logs: 4, activity: 6, sessions: 1 })
  assert.deepEqual(store.purgeScanData({ project: '不存在' }), { logs: 0, activity: 0, sessions: 0 })
})

test('store: 同名不同路径的两个项目都能落库（v3 去掉 projects.name 唯一索引的回归）', async () => {
  const cwdA = tmp.projectCwd('spms') // 项目 id: spms，目录名 spms
  const cwdB = tmp.projectCwd(join('spms-ui', 'spms')) // 项目 id: spms-ui-spms，目录名也是 spms
  for (const [sessionId, cwd, day] of [
    ['sess-same-a', cwdA, TA],
    ['sess-same-b', cwdB, TB],
  ]) {
    writeSessionFrames(tmp.sessionsRoot, {
      sessionId,
      mangled: mangleCwd(cwd),
      frames: [[evHeader({ id: sessionId, cwd, createdAt: day }), evUser('【5921】开搞', day)]],
    })
  }

  const res = await store.scanSessions()
  assert.equal(res.files, 2)
  assert.equal(res.changed, 2)
  assert.deepEqual(res.errors, [], '同名项目不该让扫描失败（v1 的唯一索引会 UNIQUE constraint failed）')
  assert.equal(res.logs, 2)

  const projects = new Map(store.listProjects().map((p) => [p.id, p]))
  assert.deepEqual([...projects.keys()].sort(), ['spms', 'spms-ui-spms'])
  assert.equal(projects.get('spms').name, 'spms')
  assert.equal(projects.get('spms-ui-spms').name, 'spms', '两个项目同名，靠 id 区分')
  assert.equal(projects.get('spms').root, cwdA)
  assert.equal(projects.get('spms-ui-spms').root, cwdB)

  const byProject = new Map(store.listLogs({ source: 'session-scan' }).items.map((l) => [l.projectId, l]))
  assert.deepEqual([...byProject.keys()].sort(), ['spms', 'spms-ui-spms'])
  assert.equal(byProject.get('spms').requirementId, 'SPMS-5921')
  // 缺省 id 前缀 = 项目**显示名**大写（两个项目都叫 spms → 都得到 SPMS-），
  // 这样同一个禅道需求不会因为仓库目录不同被拆成两条台账（记录仍按 projectId 区分）
  assert.equal(byProject.get('spms-ui-spms').requirementId, 'SPMS-5921', '前缀取显示名而非 slug')
  assert.deepEqual(
    store.db.prepare('SELECT project_id FROM scanned_sessions ORDER BY project_id').all().map((r) => r.project_id),
    ['spms', 'spms-ui-spms'],
  )
})

test('store: schema 迁移 v2 —— 清掉 -NaN 派生行 + 清空扫描水位（重扫自动重建且不翻倍）', async () => {
  seedSession(tmp)
  await store.scanSessions()
  assert.equal(store.counts().workLogs, 4)
  assert.equal(store.counts().activity, 6)

  // 造历史坏数据：requirement_id 形如 <PREFIX>-NaN（deriveRequirementId 收到 NaN 号的产物）
  store.db
    .prepare("INSERT INTO work_logs (date, project_id, requirement_id, kind, title, source, session_id, created_at) VALUES ('2026-03-01','spms','SPMS-NaN','dev','坏记录','session-scan','sess-bad',1)")
    .run()
  store.db.prepare("INSERT INTO activity (date, project_id, requirement_id, session_id, msgs) VALUES ('2026-03-01','spms','SPMS-NaN','sess-bad',1)").run()
  assert.equal(store.counts().workLogs, 5)
  assert.equal(store.counts().activity, 7)

  // 把版本号退回 v1 → 重开库时重放 v2 / v3
  setMeta(store.db, 'schema_version', '1')
  store.close()
  store = openStore()

  assert.equal(store.counts().workLogs, 4, '-NaN 派生行被清掉')
  assert.equal(store.counts().activity, 6)
  assert.equal(store.counts().scannedSessions, 0, '扫描水位被清空 → 下次增量扫描重新派生')
  assert.equal(store.status().schemaVersion, SCHEMA_VERSION)

  const rebuilt = await store.scanSessions()
  assert.equal(rebuilt.changed, 1)
  assert.equal(rebuilt.logs, 0, '重扫不会翻倍（部分唯一索引）')
  assert.equal(store.counts().workLogs, 4)
  assert.equal(store.counts().activity, 6)
  assert.equal(store.counts().scannedSessions, 1)
})

// ── 检索 / 报表 ───────────────────────────────────────────────────────────

test('store: search 按需求 / 项目 / 日期 / 关键词过滤', async () => {
  seedSession(tmp)
  await store.scanSessions()
  const doc = writeFixture(tmp.dir, 'req-5921.md', '# 分页越界修复\n')
  await store.saveRequirement({ project: 'spms', no: '5921', docUrl: doc })
  const manual = store.addLog({ date: '2026-03-05', project: 'spms', requirement: 'SPMS-5921', kind: 'bug', title: '手工：修复分页越界' })

  const all = store.search({})
  assert.equal(all.requirementTotal, 1)
  assert.equal(all.logTotal, 5)
  // search 的 days 与 report 同口径：扫描活动 + 手工记录都会出现（避免两个视图对不上）
  assert.deepEqual(all.days.map((d) => d.date), ['2026-03-05', '2026-03-03', '2026-03-02', '2026-03-01'])

  const byKeyword = store.search({ q: '分页' })
  assert.equal(byKeyword.requirementTotal, 1, '需求标题命中')
  assert.equal(byKeyword.logTotal, 1, '记录标题命中')
  assert.equal(byKeyword.logs[0].id, manual.id)

  const byRequirement = store.search({ requirement: 'SPMS-5921' })
  assert.equal(byRequirement.requirementTotal, 1)
  assert.equal(byRequirement.logTotal, 2, '扫描记录 + 手工记录都挂在这个需求上')

  const byProject = store.search({ project: 'spms' })
  assert.equal(byProject.requirementTotal, 1)
  assert.equal(byProject.logTotal, 5)
  assert.equal(store.search({ project: '不存在' }).logTotal, 0)

  const byDate = store.search({ from: '2026-03-05', to: '2026-03-05' })
  assert.equal(byDate.logTotal, 1)
  assert.deepEqual(byDate.days.map((d) => d.date), ['2026-03-05'], '只有手工记录的那天也要出现在 days 里（与 report 同口径）')
  assert.equal(byDate.days[0].projects[0].projectName, 'spms', '项目名要回查 projects 表')
  assert.equal(byDate.requirementTotal, 1, '需求侧不吃 from/to 过滤（实际行为）')

  const byKind = store.search({ kind: 'bug' })
  assert.equal(byKind.logTotal, 2)
  assert.equal(store.search({ kind: 'meeting' }).logTotal, 0)

  // 归档过滤透传
  store.archiveRequirement('SPMS-5921')
  assert.equal(store.search({ q: '分页' }).requirementTotal, 0)
  assert.equal(store.search({ q: '分页', archived: 'include' }).requirementTotal, 1)
  assert.equal(store.search({ q: '分页', archived: 'only' }).requirementTotal, 1)
})

test('store: report 的 天-项目-需求 聚合（扫描活动 + 手工记录）', async () => {
  seedSession(tmp)
  await store.scanSessions()
  await store.saveRequirement({ project: 'spms', no: '5921', title: '分页越界修复' })
  store.addLog({ date: '2026-03-05', project: 'spms', requirement: 'SPMS-5921', kind: 'review', title: '评审需求' })

  const report = store.report()
  assert.deepEqual(report.days.map((d) => d.date), ['2026-03-05', '2026-03-03', '2026-03-02', '2026-03-01'])
  assert.deepEqual(report.totals, { days: 4, logCount: 5, requirementCount: 3, projectCount: 1 })

  const day1 = report.days.find((d) => d.date === '2026-03-01')
  assert.equal(day1.logCount, 2)
  assert.equal(day1.sessionCount, 1)
  assert.equal(day1.projects.length, 1)
  const proj1 = day1.projects[0]
  assert.equal(proj1.projectId, 'spms')
  assert.equal(proj1.projectName, 'spms')
  assert.deepEqual(proj1.requirements.map((r) => r.id).sort(), ['SPMS-55036', 'SPMS-5921'])
  assert.deepEqual(Object.keys(proj1.kinds).sort(), ['bug', 'dev'])
  assert.equal(proj1.requirements.find((r) => r.id === 'SPMS-5921').title, '分页越界修复', '登记过的需求能带出标题')

  const day3 = report.days.find((d) => d.date === '2026-03-03')
  assert.equal(day3.logCount, 1)
  assert.deepEqual(day3.projects[0].requirements, [], '没有需求号的那天只有项目级记录')

  const day5 = report.days.find((d) => d.date === '2026-03-05')
  assert.equal(day5.logCount, 1)
  assert.equal(day5.msgs, 0)
  assert.equal(day5.projects[0].projectName, 'spms', '只有手工记录的那天也要回查 projects 表补项目名')
  assert.deepEqual(day5.projects[0].requirements, [])
  assert.deepEqual(day5.projects[0].kinds, { review: 1 })

  // 项目 / 日期过滤
  assert.equal(store.report({ project: 'spms' }).totals.logCount, 5)
  assert.equal(store.report({ project: '不存在' }).totals.logCount, 0)
  const ranged = store.report({ from: '2026-03-02', to: '2026-03-03' })
  assert.deepEqual(ranged.days.map((d) => d.date), ['2026-03-03', '2026-03-02'])
  assert.equal(ranged.totals.logCount, 2)
})

// ── 项目候选 ──────────────────────────────────────────────────────────────

test('store: candidateProjects 合并 库内 + 工作区扫描 + 宿主工作区注册表 + 会话缓存', async () => {
  writeFixture(join(tmp.home, 'storages'), 'workspace.json', JSON.stringify({
    tables: { workspaces: { 'ws-1': { path: tmp.projectCwd('other'), title: '别的项目', sessionIds: ['s9'], updatedAt: 500 } } },
  }))
  const cacheDir = join(tmp.home, 'storages', 'session_projcache', 'sessions')
  writeFixture(cacheDir, 'sess-x.json', JSON.stringify({ record: { identity: { cwd: tmp.projectCwd('third') }, rows: {} } }))
  tmp.projectCwd('alpha')
  writeFixture(join(tmp.workRoot, 'alpha'), 'package.json', '{}')
  store.upsertProject({ id: 'spms', name: 'SPMS' })

  const candidates = store.candidateProjects(null)
  const byId = new Map(candidates.map((c) => [c.id, c]))
  assert.ok(byId.has('spms'))
  assert.equal(byId.get('spms').source, 'db')
  assert.equal(byId.get('other').source, 'workspace-registry')
  assert.equal(byId.get('other').name, '别的项目')
  assert.equal(byId.get('third').source, 'session-cache')

  const withCwd = store.candidateProjects(tmp.workRoot)
  assert.equal(withCwd.find((c) => c.id === 'alpha').source, 'workspace')
  assert.equal(store.candidateProjects(tmp.workRoot, { limit: 1 }).length, 1)
  // 去重：同一个 id 只出现一次
  assert.equal(new Set(candidates.map((c) => c.id)).size, candidates.length)

  // listProjects({cwd}) 把工作区里扫到、但库里没有的项目也带上
  const listed = store.listProjects({ cwd: tmp.workRoot })
  assert.deepEqual(listed.map((p) => p.id).sort(), ['alpha', 'spms'])
  assert.equal(listed.find((p) => p.id === 'alpha').requirementCount, 0)
  assert.equal(listed.find((p) => p.id === 'alpha').lastWorkedDate, null)
})

// ── 备份 / 自检 ───────────────────────────────────────────────────────────

test('store: quickCheck 与 backup（VACUUM INTO 到 backups/hub-YYYYMMDD.db）', async () => {
  await store.saveRequirement({ project: 'spms', no: '5921', title: '甲' })
  const check = store.quickCheck()
  assert.equal(check.ok, true)
  assert.deepEqual(check.messages, ['ok'])

  const backup = store.backup()
  assert.equal(existsSync(backup.file), true)
  assert.ok(backup.bytes > 0)
  assert.match(backup.file, /hub-\d{8}\.db$/)
  assert.ok(backup.file.startsWith(join(tmp.home, 'project-hub', 'backups')))
  assert.equal(backup.kept, 1)
  assert.deepEqual(backup.removed, [])

  // 备份文件本身是个能打开的库
  const reopened = Store.open({}, { DSH_HOME: tmp.home })
  assert.equal(reopened.error, undefined)
  assert.equal(reopened.store.listRequirements().total, 1)
  reopened.store.close()
  writeFileSync(join(tmp.dir, 'touch'), '') // 保证 tmp.dir 还在（清理由 afterEach 负责）
})
