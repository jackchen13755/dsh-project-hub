/**
 * lib/paths.js + lib/projects.js + lib/workspace.js —— cwd→项目 id、项目发现、宿主只读数据源。
 *
 * `roots` / `env` 一律走**参数注入**（不直接依赖跑测试的机器上真实工作根）；
 * 只有内部写死用 `defaultWorkRoots()` 的地方（`projectCandidatesFrom`）靠
 * `useTempHome()` 设的 `DSH_PROJECT_ROOTS` 兜住确定性。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { after, before, test } from 'node:test'
import {
  archivesRoot,
  backupDir,
  dataDir,
  dateInTz,
  dbPath,
  defaultWorkRoots,
  deriveRequirementId,
  dshHome,
  projectIdFromCwd,
  sessionsRoot,
  slugify,
} from '../lib/paths.js'
import { decodeMangledCwd, discoverWorkspaceProjects, isProjectDir, projectFromCwd, readGitRemote } from '../lib/projects.js'
import { projectCandidatesFrom, readProjectCaches, readWorkspaceRegistry } from '../lib/workspace.js'
import { useTempHome, writeFixture } from './helpers.js'

let tmp = null
let scratch = null
let workRoot = null
let spmsRoot = null
let spmsUiRoot = null

/** 造一个带 `.git/config` 的目录。 */
function makeGitRepo(dir, configText = null) {
  mkdirSync(join(dir, '.git'), { recursive: true })
  if (configText) writeFileSync(join(dir, '.git', 'config'), configText)
  return dir
}

before(() => {
  tmp = useTempHome()
  scratch = tmp.dir
  workRoot = tmp.workRoot
  spmsRoot = tmp.projectCwd('spms')
  spmsUiRoot = tmp.projectCwd(join('spms-ui', 'spms'))
  writeFixture(spmsRoot, 'package.json', '{"name":"spms"}')
  makeGitRepo(spmsUiRoot, '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:jackchen13755/spms-ui.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n')
  // 干扰项：不是项目目录
  writeFixture(join(workRoot, 'docs'), 'readme.md', '# docs\n')
  writeFixture(join(workRoot, '.hidden'), 'package.json', '{}')
})

after(() => tmp?.restore())

test('paths: dshHome/dbPath/dataDir/sessionsRoot 由 env 决定', () => {
  const env = { DSH_HOME: '/tmp/fake-dsh-home' }
  assert.equal(dshHome(env), '/tmp/fake-dsh-home')
  assert.equal(dataDir(env), '/tmp/fake-dsh-home/project-hub')
  assert.equal(dbPath(env), '/tmp/fake-dsh-home/project-hub/hub.db')
  assert.equal(backupDir(env), '/tmp/fake-dsh-home/project-hub/backups')
  assert.equal(sessionsRoot(env), '/tmp/fake-dsh-home/sessions')
  assert.equal(archivesRoot(env), '/tmp/fake-dsh-home/sessions-archive')

  const home = dshHome({})
  assert.equal(typeof home, 'string')
  assert.ok(home.endsWith('/.dsh'), `缺省应是 ~/.dsh（实际 ${home}）`)
})

test('paths: slugify / deriveRequirementId', () => {
  assert.equal(slugify('  Spms UI / Spms  '), 'spms-ui-spms')
  assert.equal(slugify('SPMS_5921'), 'spms-5921')
  assert.equal(slugify('---'), '')
  assert.equal(slugify(null), '')
  // 中文必须保留（Unicode slug）：ASCII 白名单会让 '/w/工作/spms' 与 '/w/spms' 撞同一个 id，
  // 纯中文目录还会塌成空串 → 'unknown'，多个项目在 projects.id 主键上互相覆盖。
  assert.equal(slugify('多层/中文 目录'), '多层-中文-目录')
  assert.equal(slugify('工作/spms'), '工作-spms')

  assert.equal(deriveRequirementId('spms', '5921'), 'SPMS-5921')
  assert.equal(deriveRequirementId('spms-ui', '5921'), 'SPMS-UI-5921')
  assert.equal(deriveRequirementId('spms', ' 009753 '), 'SPMS-009753')
  assert.equal(deriveRequirementId('', '5921'), '5921')
  assert.equal(deriveRequirementId('spms', ''), '')
  assert.equal(deriveRequirementId(null, null), '')
})

test('paths: dateInTz 按 Asia/Shanghai 归日（跨零点边界）', () => {
  assert.equal(dateInTz(Date.parse('2026-03-01T15:59:00Z')), '2026-03-01') // 上海 23:59
  assert.equal(dateInTz(Date.parse('2026-03-01T16:00:00Z')), '2026-03-02') // 上海 00:00
  assert.equal(dateInTz(Date.parse('2026-03-01T16:00:00Z'), 'UTC'), '2026-03-01')
  assert.equal(dateInTz(new Date(Date.parse('2026-03-02T02:00:00Z'))), '2026-03-02')
  assert.equal(dateInTz('not-a-time'), null)
  assert.equal(dateInTz(undefined), null)
})

test('paths: projectIdFromCwd —— <root>/spms 与 <root>/spms-ui/spms 是两个不同 id', () => {
  const roots = [workRoot]
  const a = projectIdFromCwd(spmsRoot, roots)
  const b = projectIdFromCwd(spmsUiRoot, roots)
  assert.equal(a, 'spms')
  assert.equal(b, 'spms-ui-spms')
  assert.notEqual(a, b, '同名不同路径的仓库必须是两个项目')

  // 更长的根命中优先（defaultWorkRoots 先长后短就是为了这个）
  assert.equal(projectIdFromCwd(spmsUiRoot, [join(workRoot, 'spms-ui'), workRoot]), 'spms')
  assert.equal(projectIdFromCwd(spmsUiRoot, [workRoot, join(workRoot, 'spms-ui')]), 'spms-ui-spms')

  // 都不命中 → 退化成目录名 slug
  assert.equal(projectIdFromCwd('/other/place/My Project', [workRoot]), 'my-project')
  // cwd 恰好等于根 → relative 为空 → 也退化成目录名
  assert.equal(projectIdFromCwd(workRoot, [workRoot]), basename(workRoot).toLowerCase())
  assert.equal(projectIdFromCwd('/'), 'unknown')
  // 中文目录名保留（Unicode slug），不再塌成 'unknown'
  assert.equal(projectIdFromCwd(join(workRoot, '中文项目'), [workRoot]), '中文项目')
  assert.notEqual(
    projectIdFromCwd(join(workRoot, '工作', 'spms'), [workRoot]),
    projectIdFromCwd(join(workRoot, 'spms'), [workRoot]),
    '中文子目录不能与同名顶层目录撞 id',
  )

  const sortedRoots = defaultWorkRoots({ DSH_PROJECT_ROOTS: `${join(scratch, 'a')}:${join(scratch, 'a', 'b')}` })
  assert.deepEqual(sortedRoots, [join(scratch, 'a', 'b'), join(scratch, 'a')], '工作根必须按长度倒序')
})

test('projects: isProjectDir 认 .git / package.json 等标记', () => {
  assert.equal(isProjectDir(spmsRoot), true) // package.json
  assert.equal(isProjectDir(spmsUiRoot), true) // .git
  const empty = join(scratch, 'empty-dir')
  mkdirSync(empty, { recursive: true })
  assert.equal(isProjectDir(empty), false)
  assert.equal(isProjectDir(join(scratch, '不存在')), false)
  assert.equal(isProjectDir(join(workRoot, 'docs')), false)
})

test('projects: readGitRemote 解析 .git/config 的 origin url', () => {
  assert.equal(readGitRemote(spmsUiRoot), 'git@github.com:jackchen13755/spms-ui')
  assert.equal(readGitRemote(spmsRoot), null, '没有 .git 就是 null')

  const httpsProject = makeGitRepo(join(scratch, 'https-proj'), '[remote "origin"]\n\turl = https://github.com/jackchen13755/dsh-project-hub\n')
  assert.equal(readGitRemote(httpsProject), 'https://github.com/jackchen13755/dsh-project-hub')

  const noOrigin = makeGitRepo(join(scratch, 'no-origin'), '[remote "upstream"]\n\turl = git@github.com:other/repo.git\n')
  assert.equal(readGitRemote(noOrigin), null)
  makeGitRepo(join(scratch, 'empty-git'))
  assert.equal(readGitRemote(join(scratch, 'empty-git')), null)
  assert.equal(readGitRemote(join(scratch, '不存在')), null)
})

test('projects: discoverWorkspaceProjects 扫出项目（id 与 cwd 派生一致，跳过隐藏目录）', () => {
  const found = discoverWorkspaceProjects(workRoot, { roots: [workRoot] })
  const byId = new Map(found.map((p) => [p.id, p]))
  assert.deepEqual([...byId.keys()].sort(), ['spms', 'spms-ui-spms'])

  const spms = byId.get('spms')
  assert.equal(spms.root, spmsRoot)
  assert.equal(spms.name, 'spms')
  assert.equal(spms.source, 'workspace')
  assert.equal(spms.remote, null)

  const ui = byId.get('spms-ui-spms')
  assert.equal(ui.root, spmsUiRoot)
  assert.equal(ui.remote, 'git@github.com:jackchen13755/spms-ui')
  assert.ok(!byId.has('hidden'), '以 . 开头的目录要跳过')

  // 起点本身就是项目 → 也算一个
  const fromProject = discoverWorkspaceProjects(spmsRoot, { roots: [workRoot] })
  assert.equal(fromProject[0].id, 'spms')

  assert.deepEqual(discoverWorkspaceProjects(null), [])
  assert.deepEqual(discoverWorkspaceProjects(join(scratch, '不存在')), [])
  assert.equal(discoverWorkspaceProjects(workRoot, { roots: [workRoot], limit: 1 }).length, 1)
})

test('projects: projectFromCwd / decodeMangledCwd', () => {
  const p = projectFromCwd(spmsUiRoot, { roots: [workRoot] })
  assert.equal(p.id, 'spms-ui-spms')
  assert.equal(p.name, 'spms')
  assert.equal(p.root, spmsUiRoot)
  assert.equal(p.remote, 'git@github.com:jackchen13755/spms-ui')
  assert.equal(p.source, 'session')

  assert.equal(decodeMangledCwd('-Users-zhe-chen-Desktop-work-spms-'), '/Users/zhe/chen/Desktop/work/spms')
  assert.equal(decodeMangledCwd('--Users-demo-Desktop-work-spms--'), '/Users/demo/Desktop/work/spms')
  assert.equal(decodeMangledCwd(''), null)
  assert.equal(decodeMangledCwd('---'), null)
})

test('workspace: readWorkspaceRegistry 解析 storages/workspace.json', () => {
  const home = join(scratch, 'home-registry')
  writeFixture(join(home, 'storages'), 'workspace.json', JSON.stringify({
    version: 1,
    tables: {
      workspaces: {
        'ws-1': { path: spmsRoot, title: 'SPMS 项目', sessionIds: ['s1', 's2'], createdAt: 100, updatedAt: 200 },
        'ws-2': { path: spmsUiRoot, title: null, sessionIds: 'not-an-array', createdAt: 101, updatedAt: 300 },
        'ws-3': { title: '没有 path 的记录' },
      },
    },
  }))
  const items = readWorkspaceRegistry({ DSH_HOME: home })
  assert.equal(items.length, 2, '没有 path 的记录要跳过')
  assert.deepEqual(items.map((p) => p.key), ['ws-2', 'ws-1'], '按 updatedAt 倒序')
  assert.deepEqual(items.map((p) => p.id), ['spms-ui-spms', 'spms'])

  const first = items[0]
  assert.equal(first.root, spmsUiRoot)
  assert.equal(first.name, 'spms', 'title 为空 → 目录名')
  assert.deepEqual(first.sessionIds, [])
  assert.equal(first.source, 'workspace-registry')
  assert.equal(first.remote, null)

  const second = items[1]
  assert.equal(second.name, 'SPMS 项目')
  assert.deepEqual(second.sessionIds, ['s1', 's2'])
  assert.equal(second.createdAt, 100)
  assert.equal(second.updatedAt, 200)

  // 缺文件 / 坏 JSON / 没这张表 → 一律空数组，不抛
  assert.deepEqual(readWorkspaceRegistry({ DSH_HOME: join(scratch, 'home-empty') }), [])
  const broken = join(scratch, 'home-broken')
  writeFixture(join(broken, 'storages'), 'workspace.json', '{ 这不是 JSON')
  assert.deepEqual(readWorkspaceRegistry({ DSH_HOME: broken }), [])
  const noTable = join(scratch, 'home-notable')
  writeFixture(join(noTable, 'storages'), 'workspace.json', JSON.stringify({ tables: {} }))
  assert.deepEqual(readWorkspaceRegistry({ DSH_HOME: noTable }), [])
})

test('workspace: readProjectCaches 解析 session_projcache（零解压拿 cwd/标题）', () => {
  const home = join(scratch, 'home-cache')
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  writeFixture(dir, 'sess-a.json', JSON.stringify({
    record: { identity: { cwd: spmsRoot, createdAt: 111 }, rows: { title: { val: '分页越界修复' } } },
  }))
  writeFixture(dir, 'sess-b.json', JSON.stringify({ record: { identity: { cwd: spmsUiRoot }, rows: {} } }))
  writeFixture(dir, 'sess-c.json', JSON.stringify({ record: { identity: {} } })) // 没 cwd → 跳过
  writeFixture(dir, 'notes.txt', 'not json')

  const items = readProjectCaches({ DSH_HOME: home })
  assert.equal(items.length, 2)
  const a = items.find((c) => c.sessionId === 'sess-a')
  assert.equal(a.cwd, spmsRoot)
  assert.equal(a.createdAt, 111)
  assert.equal(a.title, '分页越界修复')

  const b = items.find((c) => c.sessionId === 'sess-b')
  assert.equal(b.cwd, spmsUiRoot)
  assert.equal(b.title, null)
  assert.equal(b.createdAt, null)

  assert.equal(readProjectCaches({ DSH_HOME: home }, { limit: 1 }).length, 1)
  assert.deepEqual(readProjectCaches({ DSH_HOME: join(scratch, 'home-empty') }), [])
})

test('workspace: readProjectCaches 的目录缓存不能返回陈旧数据', async () => {
  const home = join(scratch, 'home-cache-stale')
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  writeFixture(dir, 'sess-a.json', JSON.stringify({ record: { identity: { cwd: spmsRoot }, rows: {} } }))

  const env = { DSH_HOME: home }
  const first = readProjectCaches(env)
  assert.deepEqual(first.map((c) => c.sessionId), ['sess-a'])

  // ① 新增会话文件 → 下一次读必须看见（目录 mtime / 文件名清单任一判据命中即可）
  writeFixture(dir, 'sess-b.json', JSON.stringify({ record: { identity: { cwd: spmsUiRoot }, rows: {} } }))
  const second = readProjectCaches(env)
  assert.deepEqual(second.map((c) => c.sessionId).sort(), ['sess-a', 'sess-b'], '新增的投影缓存必须立刻可见')

  // ② 删除会话文件 → 下一次读必须看不见（缓存不能把已删的会话留在候选里）
  rmSync(join(dir, 'sess-a.json'))
  const third = readProjectCaches(env)
  assert.deepEqual(third.map((c) => c.sessionId), ['sess-b'], '删掉的文件不能还被缓存带出来')

  // ③ 原地改写（文件名与个数都不变）→ 也必须察觉，否则标题/项目会停在旧值
  await new Promise((resolve) => setTimeout(resolve, 20))
  writeFixture(dir, 'sess-b.json', JSON.stringify({
    record: { identity: { cwd: spmsRoot }, rows: { title: { val: '改过的标题' } } },
  }))
  const fourth = readProjectCaches(env)
  assert.equal(fourth.length, 1)
  assert.equal(fourth[0].cwd, spmsRoot, '原地改写后不能再返回旧的 cwd')
  assert.equal(fourth[0].title, '改过的标题')
})

/**
 * 缓存判据的**已知盲区**，写成测试是为了让它显式存在、而不是靠注释。
 *
 * 判据是 `name + size + mtimeMs`：如果写入方把三元组精确复原
 * （`tar -x` / `rsync --times` / `git checkout` 这类保留 mtime 的写回），缓存察觉不到。
 * 正常写入方是宿主自己（必改 size 或 mtime），所以这不是日常路径；
 * 这里断言的是「当前行为如何」，不是「这是对的」—— 将来若要收紧，改这条测试即起点。
 *
 * 注意复原必须用 **数值形式的 `mtimeMs / 1000`**：实测 `utimesSync(file, atime, mtime)`
 * 传 `Date` 会截断到整毫秒，反而复原不成功（实测差 0.47ms，于是缓存仍会察觉）。
 */
test('workspace: 目录缓存的已知盲区 —— 三元组被复原时察觉不到', () => {
  const home = join(scratch, 'home-cache-blindspot')
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  const env = { DSH_HOME: home }
  const file = join(dir, 'sess-a.json')

  // 手工构造两条**同字节长度**、只有 cwd 不同的内容：
  // 长度必须自己控制，不能靠两个 fixture 路径恰好等长。
  const original = '{"record":{"identity":{"cwd":"/work/aaa"}}}'
  const replaced = '{"record":{"identity":{"cwd":"/work/bbb"}}}'
  assert.equal(original.length, replaced.length, '前提：两条内容必须同字节长度')

  writeFixture(dir, 'sess-a.json', original)
  const before = statSync(file)
  assert.equal(readProjectCaches(env)[0].cwd, '/work/aaa')

  // 写入新内容，再把 mtime 精确复原回旧值（数值形式，保留亚毫秒）
  writeFixture(dir, 'sess-a.json', replaced)
  utimesSync(file, before.atimeMs / 1000, before.mtimeMs / 1000)
  const after = statSync(file)
  assert.equal(after.size, before.size, '前提：写入前后 size 不变')
  // 宽容到 1ms：在 mtime 粒度只到整毫秒的文件系统上 before.mtimeMs 可能恰好是整数，
  // 严格相等会假红；只要差值 < 1ms 就说明确实复现了「复原」这个前提。
  assert.ok(Math.abs(after.mtimeMs - before.mtimeMs) < 1, '前提：mtime 必须被复原，否则测的不是这个盲区')

  // 记录当前（已知会陈旧）的行为
  assert.equal(readProjectCaches(env)[0].cwd, '/work/aaa', '已知盲区：三元组复原后会返回陈旧数据')
})

test('workspace: projectCandidatesFrom 去重（注册表优先于会话缓存）', () => {
  const registry = [
    { id: 'spms', name: 'SPMS 项目', root: spmsRoot, source: 'workspace-registry' },
    { id: 'other', name: 'other', root: '/other', source: 'workspace-registry' },
  ]
  const caches = [
    { sessionId: 's1', cwd: spmsRoot, title: '重复的项目' },
    { sessionId: 's2', cwd: join(spmsUiRoot, 'deep'), title: '缓存里的项目' },
  ]
  const out = projectCandidatesFrom(registry, caches)
  assert.deepEqual(out.map((p) => p.id), ['spms', 'other', 'spms-ui-spms-deep'])
  assert.equal(out[0].name, 'SPMS 项目', '注册表的记录优先')
  assert.equal(out[0].source, 'workspace-registry')
  assert.equal(out[2].source, 'session-cache')
  assert.equal(out[2].name, 'deep')
  assert.equal(out[2].root, join(spmsUiRoot, 'deep'))
  assert.equal(out[2].remote, null)

  assert.equal(projectCandidatesFrom(registry, caches, { limit: 2 }).length, 2)
  assert.deepEqual(projectCandidatesFrom([], []), [])
})
