/**
 * 项目发现（R3：所属项目从「当前工作区已有项目」里做选择）。
 *
 * 三个来源合并去重：
 *   ① 当前会话 cwd 及其子目录里的项目目录（.git / package.json / pom.xml …）；
 *   ② 会话日志里出现过的 cwd（历史开发过的工作目录）；
 *   ③ 库里已登记的项目。
 *
 * 项目 id 由 `paths.projectIdFromCwd` 统一派生（去掉工作根前缀后 slug 化），
 * 所以「扫描出来的项目」和「手工登记的项目」id 天然对齐。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { projectIdFromCwd, defaultWorkRoots } from './paths.js'

const PROJECT_MARKERS = ['.git', 'package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'composer.json', 'Gemfile']
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'target', 'coverage', '.next', '.venv', 'venv', '__pycache__', 'Library', 'Applications'])

export function isProjectDir(dir) {
  try {
    return PROJECT_MARKERS.some((m) => existsSync(join(dir, m)))
  } catch {
    return false
  }
}

/** 读 `.git/config` 里的 origin url（只读文件，不调 git）。 */
export function readGitRemote(dir) {
  try {
    const file = join(dir, '.git', 'config')
    if (!existsSync(file)) return null
    const text = readFileSync(file, 'utf8')
    const m = text.match(/\[remote "origin"\][\s\S]*?url\s*=\s*(.+)/)
    if (!m) return null
    return m[1].trim().replace(/\.git$/, '') || null
  } catch {
    return null
  }
}

/**
 * 扫描 cwd 附近的项目目录（有界：深度 + 访问上限）。
 * @returns {Array<{ id:string, name:string, root:string, remote:string|null, source:'workspace' }>}
 */
export function discoverWorkspaceProjects(cwd, { maxDepth = 2, limit = 120, maxVisit = 600, roots = defaultWorkRoots() } = {}) {
  const out = []
  const seen = new Set()
  if (!cwd) return out
  const start = resolve(String(cwd))
  if (!existsSync(start)) return out

  let visited = 0
  const queue = [{ dir: start, depth: 0 }]
  const push = (root) => {
    if (seen.has(root)) return
    seen.add(root)
    out.push({
      id: projectIdFromCwd(root, roots),
      name: basename(root) || projectIdFromCwd(root, roots),
      root,
      remote: readGitRemote(root),
      source: 'workspace',
    })
  }
  if (isProjectDir(start)) push(start)

  while (queue.length > 0 && out.length < limit && visited < maxVisit) {
    const { dir, depth } = queue.shift()
    visited += 1
    if (depth >= maxDepth) continue
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const full = join(dir, entry.name)
      let ok = true
      try {
        ok = statSync(full).isDirectory()
      } catch {
        ok = false
      }
      if (!ok) continue
      if (isProjectDir(full)) push(full)
      queue.push({ dir: full, depth: depth + 1 })
      if (out.length >= limit || visited >= maxVisit) break
    }
  }
  return out
}

/** cwd → 项目对象（不落库，纯计算）。 */
export function projectFromCwd(cwd, { roots = defaultWorkRoots() } = {}) {
  const root = resolve(String(cwd))
  const id = projectIdFromCwd(root, roots)
  return { id, name: basename(root) || id, root, remote: readGitRemote(root), source: 'session' }
}

/** 会话目录名的兜底解码（拿不到会话头时才用）：`--Users-me-Desktop-work-spms--`。 */
export function decodeMangledCwd(dirname) {
  const inner = String(dirname ?? '').replace(/^-+|-+$/g, '')
  if (!inner) return null
  return `/${inner.replace(/-/g, '/')}`
}
