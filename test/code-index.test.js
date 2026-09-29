/**
 * P1：需求 ↔ 代码 影响索引（DESIGN.md §9.2）。
 *
 * 关键验证点：
 *   ① 需求号抽取要认本团队真实的提交写法（`（#5829）`、`fix(5823+5824)`、`feat: 5693 lf …`、`feature/20260922-log-lock-5829`）；
 *   ② 年份（1900–2099 的 4 位数）不能被当成需求号；
 *   ③ **在真实 git 仓库上跑一遍**（不是 mock）：建仓库→提交→扫描→落库→查询，
 *      并核对「带号覆盖率」这个唯一输入约束。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { branchRequirementNo, extractNosFromText, groupTouchesByModule, moduleOf, parseGitLog, scanGitRepo, usefulPath } from '../lib/git-index.js'
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

test('需求号抽取：认本团队真实的提交/分支写法', () => {
  assert.equal(extractNosFromText('feat(bill-log): 账单变更日志抽屉按设计稿重排并新增操作对象列与筛选（#5829）').join(','), '5829')
  assert.equal(extractNosFromText('fix(5823+5824): 跑case修复发票项目管理问题并优化错误刷新逻辑').join(','), '5823,5824')
  assert.equal(extractNosFromText('feat: 5693 lf 搜索日期范围调整').join(','), '5693')
  assert.equal(extractNosFromText('Merge branch feature/20260922-log-lock-5829 of gitlab…').join(','), '5829')
  assert.equal(extractNosFromText('【5922】L&F Q3 Enhancements/Queue数据记录').join(','), '5922')
  assert.equal(extractNosFromText('fix: 更新 DATE_SELECT_RANGE_MONTH 为 24').length, 0, '没有号就不猜')
})

test('需求号抽取：年份不当需求号，短号/长号也要认', () => {
  assert.equal(extractNosFromText('chore: 2026 年度规划').length, 0, '2026 是年份')
  assert.equal(extractNosFromText('release 2025-09-01').length, 0)
  assert.equal(extractNosFromText('#582').join(','), '582', '3 位号也认')
  assert.equal(extractNosFromText('#123456').join(','), '123456')
})

test('moduleOf / usefulPath：模块取前 3 段，构建产物不进索引', () => {
  assert.equal(moduleOf('isomorph/views/Housekeeping/LostAndFound/index.tsx'), 'isomorph/views/Housekeeping')
  assert.equal(moduleOf('a/b.ts'), 'a', '模块 = 去掉文件名后的目录')
  assert.equal(moduleOf('README.md'), 'README.md', '根目录文件退化成文件名')
  assert.equal(usefulPath('isomorph/views/x.ts'), true)
  assert.equal(usefulPath('node_modules/foo/index.js'), false)
  assert.equal(usefulPath('dist/app.js'), false)
  assert.equal(usefulPath(''), false)
})

test('parseGitLog：按 \\u0001 分块解析，带号提交计数正确', () => {
  const raw = [
    '\u0001abc1234|2026-09-29|feat: 做点事（#5829）|HEAD -> master',
    'isomorph/views/A/index.tsx',
    'isomorph/models/B/index.ts',
    '\u0001def5678|2026-09-28|fix: 顺手改改|',
    'isomorph/views/A/index.tsx',
  ].join('\n')
  const { commits, numbered } = parseGitLog(raw)
  assert.equal(commits.length, 2)
  assert.equal(numbered, 1, '只有一个提交带号')
  assert.equal(commits[0].nos.join(','), '5829')
  assert.equal(commits[0].files.length, 2)
  assert.equal(commits[1].nos.length, 0)
})

test('groupTouchesByModule：按模块聚合、按提交次数排序', () => {
  const rows = [
    { path: 'isomorph/views/LostAndFound/a.tsx', module: 'isomorph/views/LostAndFound', commits: 3, lastSeen: '2026-09-01', sample: 'x' },
    { path: 'isomorph/views/LostAndFound/b.tsx', module: 'isomorph/views/LostAndFound', commits: 2, lastSeen: '2026-09-20', sample: 'y' },
    { path: 'isomorph/models/Other/c.ts', module: 'isomorph/models/Other', commits: 1, lastSeen: '2026-08-01', sample: 'z' },
  ]
  const grouped = groupTouchesByModule(rows, { limit: 5 })
  assert.equal(grouped[0].module, 'isomorph/views/LostAndFound')
  assert.equal(grouped[0].commits, 5)
  assert.equal(grouped[0].files, 2)
  assert.equal(grouped[0].lastSeen, '2026-09-20')
  assert.equal(grouped[1].module, 'isomorph/models/Other')
})

// ── 真实 git 仓库上的端到端 ──────────────────────────────────────────────

function makeRepo(dir, commits) {
  mkdirSync(dir, { recursive: true })
  const run = (args, env = {}) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...env } })
  run(['init', '-q', '-b', 'master'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  for (const [index, item] of commits.entries()) {
    const file = join(dir, item.path)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, `// ${item.subject}\n`)
    run(['add', '-A'])
    const when = `${item.date}T10:00:00`
    run(['commit', '-q', '-m', item.subject], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when })
    assert.ok(index >= 0)
  }
  return dir
}

test('真实 git 仓库：扫描 → 需求↔文件索引 + 覆盖率 + 按模块聚合', async () => {
  const root = join(tmp.dir, 'repo-a')
  makeRepo(root, [
    { date: '2026-09-01', path: 'isomorph/views/LostAndFound/index.tsx', subject: 'feat(lostfound): 新增物品分类（#5829）' },
    { date: '2026-09-02', path: 'isomorph/views/LostAndFound/Options.tsx', subject: 'feat(lostfound): 分类选项顺序调整（#5829）' },
    { date: '2026-09-03', path: 'isomorph/views/LostAndFound/locales/zh.json', subject: 'chore(i18n): 补齐文案' },
    { date: '2026-09-04', path: 'isomorph/models/LostAndFound/index.ts', subject: 'feat: 5693 lf 搜索日期范围调整' },
  ])
  const project = store.upsertProject({ id: 'repo-a', name: 'repo-a', root })  // ⚠️ ensureProject 收的是「引用字符串」，建项目要用 upsertProject

  const scan = await store.scanCode({ project: project.id, sinceDays: 3650 })
  const row = scan.results[0]
  assert.equal(row.commits, 4)
  assert.equal(row.numbered, 3, '带号提交 3 个（5829 ×2 + 5693）')
  assert.equal(row.coverage, 0.75)
  assert.equal(row.requirements, 2)

  const modules = store.listCodeTouches('5829')
  assert.equal(modules[0].module, 'isomorph/views/LostAndFound')
  assert.equal(modules[0].files, 2)
  assert.equal(modules[0].commits, 2)
  assert.match(modules[0].sample, /#5829|分类/)

  const files = store.listCodeFiles('5829')
  assert.equal(files.length, 2)
  assert.ok(files.every((f) => f.last_seen >= '2026-09-01'))

  // 5693 也进了索引（历史需求一样能查）
  assert.equal(store.listCodeTouches('5693')[0].module, 'isomorph/models/LostAndFound')

  // 覆盖率与扫描状态
  const coverage = store.codeCoverage().find((c) => c.project_id === project.id)
  assert.equal(coverage.numbered, 3)
  assert.equal(Number(coverage.coverage), 0.75)
  assert.equal(Number(coverage.touch_rows), 3)
  assert.equal(Number(coverage.requirements), 2)

  // code_recent：不带号的提交也留在"这块最近谁在动"里
  const recent = store.listRecentModuleActivity({ project: project.id, module: 'LostAndFound' })
  assert.ok(recent.length >= 3)
  assert.ok(recent.some((r) => r.path.endsWith('locales/zh.json')), '没带号的 i18n 提交也在 recent 里')
})

test('真实 git 仓库：HEAD 未变时增量跳过；force 可强制重扫', async () => {
  const root = join(tmp.dir, 'repo-b')
  makeRepo(root, [{ date: '2026-09-10', path: 'src/a.ts', subject: 'feat: 初始化（#6001）' }])
  const project = store.upsertProject({ id: 'repo-b', name: 'repo-b', root })

  const first = await store.scanCode({ project: project.id, sinceDays: 3650 })
  assert.equal(first.results[0].commits, 1)
  const second = await store.scanCode({ project: project.id, sinceDays: 3650 })
  assert.match(second.results[0].skipped ?? '', /HEAD 未变/)
  const forced = await store.scanCode({ project: project.id, sinceDays: 3650, force: true })
  assert.equal(forced.results[0].commits, 1, 'force 会重扫但不重复计数')
  assert.equal(store.listCodeFiles('6001').length, 1)
})

test('没有本地目录的项目：如实报跳过，不抛错', async () => {
  const project = store.upsertProject({ id: 'no-root', name: 'no-root' })
  const scan = await store.scanCode({ project: project.id })
  assert.equal(scan.ok, true)
  assert.match(scan.results[0].skipped, /没有本地目录/)
  assert.equal(store.listCodeTouches('6001').length, 0)
})

test('scanGitRepo：非 git 目录返回 ok=false 并带原因', () => {
  const result = scanGitRepo(join(tmp.dir, 'not-a-repo'))
  assert.equal(result.ok, false)
  assert.match(result.error, /不是 git 仓库/)
})

test('branchRequirementNo：只认分支名**结尾**的号，8 位日期不会切成假号', () => {
  // 实测踩到的坑：uatfix/20260922-payment-method-55716 用宽松正则会被抓成 20260
  assert.equal(branchRequirementNo("Merge branch 'uatfix/20260922-payment-method-55716' into x"), '55716')
  assert.equal(branchRequirementNo("Merge branch 'feature/20260922-log-lock-5829'"), '5829')
  assert.equal(branchRequirementNo('feature-20260526-item-inventory-5728'), '5728')
  assert.equal(branchRequirementNo('feature/202606-cycle'), null, '没有号就不猜（p2p3 这种也不算）')
  assert.equal(branchRequirementNo('release/2026'), null)
  assert.equal(branchRequirementNo('hotfix/2025-09-01'), null, '日期片段不是号')
})

test('真实 git 仓库：需求号写在分支名上时，用「特性合并」归属文件', async () => {
  const root = join(tmp.dir, 'repo-merge')
  const run = (args, env = {}) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...env } })
  mkdirSync(root, { recursive: true })
  run(['init', '-q', '-b', 'master'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  const write = (path, text) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  // 主线
  write('src/base.ts', 'base\n')
  run(['add', '-A'])
  run(['commit', '-q', '-m', 'chore: 初始化'], { GIT_AUTHOR_DATE: '2026-09-01T10:00:00', GIT_COMMITTER_DATE: '2026-09-01T10:00:00' })
  // 特性分支：分支名带需求号，提交信息“不带号”（真实情况就是如此）
  run(['checkout', '-q', '-b', 'feature/20260910-queue-record-5922'])
  write('src/queue/list.tsx', 'list\n')
  write('src/queue/log.tsx', 'log\n')
  run(['add', '-A'])
  run(['commit', '-q', '-m', 'feat: 列表与日志'], { GIT_AUTHOR_DATE: '2026-09-10T10:00:00', GIT_COMMITTER_DATE: '2026-09-10T10:00:00' })
  run(['checkout', '-q', 'master'])
  run(['merge', '-q', '--no-ff', 'feature/20260910-queue-record-5922', '-m', "Merge branch 'feature/20260910-queue-record-5922'"], {
    GIT_AUTHOR_DATE: '2026-09-11T10:00:00',
    GIT_COMMITTER_DATE: '2026-09-11T10:00:00',
  })

  const project = store.upsertProject({ id: 'repo-merge', name: 'repo-merge', root })
  const scan = await store.scanCode({ project: project.id, sinceDays: 3650 })
  const row = scan.results[0]
  // 提交信息里没有号；但 `%D` 里挂着分支 ref（feature/...-5922）→ 提交号也能从 ref 认出来
  assert.equal(row.numbered, 1, '分支 ref 上的号也算信号')
  assert.equal(row.mergeNumbered, 1, '靠分支名认出了 1 个特性合并')

  const files = store.listCodeFiles('5922')
  assert.equal(files.length, 2, '特性合并带来的两个文件都归属到 5922')
  assert.deepEqual(files.map((f) => f.path).sort(), ['src/queue/list.tsx', 'src/queue/log.tsx'])
  assert.equal(files[0].module, 'src/queue')
  assert.match(files[0].sample, /feature\/20260910-queue-record-5922/, '样本留分支名/合并信息')
})

test('聚合要能吃「入库的 snake_case 行」（接口/工具都读它）', () => {
  const rows = [
    { path: 'src/queue/a.ts', module: 'src/queue', commits: 2, last_seen: '2026-09-20', sample: 'x' },
    { path: 'src/queue/b.ts', module: 'src/queue', commits: 1, last_seen: '2026-09-25', sample: null },
  ]
  const grouped = groupTouchesByModule(rows)
  assert.equal(grouped[0].module, 'src/queue')
  assert.equal(grouped[0].commits, 3)
  assert.equal(grouped[0].lastSeen, '2026-09-25', 'lastSeen 不能是 undefined')
})
