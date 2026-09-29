/**
 * 路径与标识解析。
 *
 * 事实源是 SQLite：`$DSH_HOME/project-hub/hub.db`（做法对齐 dsh-memory-core）。
 * 会话日志目录与 dsh 自身一致：`$DSH_HOME/sessions/<mangled-cwd>/<session-id>/`。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'

/** `$DSH_HOME`（缺省 `~/.dsh`）。 */
export function dshHome(env = process.env) {
  return env.DSH_HOME ? resolve(env.DSH_HOME) : join(homedir(), '.dsh')
}

/** 本插件的数据目录（DB、备份）。 */
export function dataDir(env = process.env) {
  return join(dshHome(env), 'project-hub')
}

export function dbPath(env = process.env) {
  return join(dataDir(env), 'hub.db')
}

export function backupDir(env = process.env) {
  return join(dataDir(env), 'backups')
}

/** 会话日志根目录。 */
export function sessionsRoot(env = process.env) {
  return join(dshHome(env), 'sessions')
}

/** 归档会话目录（老会话被挪走后仍可扫描；不存在就跳过）。 */
export function archivesRoot(env = process.env) {
  return join(dshHome(env), 'sessions-archive')
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 通用 slug：小写、非字母数字折成 `-`、压缩重复、去首尾。 */
export function slugify(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * 工作根目录（用于把 cwd 折算成项目 id）。
 *
 * 命中顺序很关键：先长后短，`~/Desktop/dsh/github` 要排在 `~/Desktop` 前面，
 * 否则 `~/Desktop/dsh/github` 会被折成 `dsh-github` 之外的怪 slug。
 */
export function defaultWorkRoots(env = process.env) {
  if (env.DSH_PROJECT_ROOTS) {
    return env.DSH_PROJECT_ROOTS.split(':')
      .filter(Boolean)
      .map((p) => resolve(p))
      .sort((a, b) => b.length - a.length)
  }
  const home = homedir()
  return [
    'Desktop/dsh/github',
    'Desktop/dsh',
    'Desktop/work',
    'Desktop',
    'Documents',
    'projects',
    'code',
    'src',
    'work',
  ]
    .map((p) => join(home, p))
    .filter((p) => existsSync(p))
    .sort((a, b) => b.length - a.length)
}

/**
 * cwd → 项目 id。
 *
 * 规则：去掉命中的工作根前缀，剩下的相对路径 slug 化（`spms`、`spms-ui-spms`）；
 * 都不命中时退化成目录名。这样 `~/Desktop/work/spms` 与 `~/Desktop/work/spms-ui/spms`
 * 是两个不同项目（用户实际就是两个仓库）。
 */
export function projectIdFromCwd(cwd, roots = defaultWorkRoots()) {
  const abs = resolve(String(cwd))
  for (const root of roots) {
    const rel = relative(root, abs)
    if (rel && !rel.startsWith('..') && !rel.startsWith('/')) {
      const slug = slugify(rel)
      if (slug) return slug
    }
  }
  return slugify(basename(abs)) || 'unknown'
}

/** 时区化的 `YYYY-MM-DD`（默认东八区，跟用户作息一致）。 */
export function dateInTz(ms, tz = 'Asia/Shanghai') {
  const d = ms instanceof Date ? ms : new Date(Number(ms))
  if (Number.isNaN(d.getTime())) return null
  // sv-SE 的短日期格式恰好是 YYYY-MM-DD，省掉手工补零
  return new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(d)
}

export function nowMs() {
  return Date.now()
}

/** 需求 id 的派生：`<PROJECT大写>-<号>`（前缀由本插件自行拼接）。 */
export function deriveRequirementId(projectId, no) {
  const proj = String(projectId ?? '').trim().toUpperCase().replace(/\s+/g, '-')
  const num = String(no ?? '').trim()
  if (!num) return ''
  return proj ? `${proj}-${num}` : num
}
