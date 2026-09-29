/**
 * lib/paths.js + lib/projects.js + lib/workspace.js —— cwd→项目 id、项目发现、宿主只读数据源。
 *
 * `roots` / `env` 一律走**参数注入**（不直接依赖跑测试的机器上真实工作根）；
 * 只有内部写死用 `defaultWorkRoots()` 的地方（`projectCandidatesFrom`）靠
 * `useTempHome()` 设的 `DSH_PROJECT_ROOTS` 兜住确定性。
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
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
