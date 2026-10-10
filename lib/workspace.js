/**
 * 项目来源补充（宿主侧官方数据只读接入）。
 *
 * 两个官方数据源（都只读文件，服务缺席也能用）：
 *   ① `$DSH_HOME/storages/workspace.json` —— 宿主「工作区/项目」注册表
 *      （`ctx.workspaceRegistry` 的持久化形态：`{path, title, sessionIds}`），
 *      这就是「当前工作区有哪些项目」的官方答案；
 *   ② `$DSH_HOME/storages/session_projcache/sessions/<id>.json` —— 会话投影缓存，
 *      里面直接有 `identity.cwd / createdAt / rows.title.val`，
 *      **不解 zstd 就能拿到「哪个项目 / 哪天 / 什么标题」**，用于首屏候选与粗筛。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { dshHome, projectIdFromCwd } from './paths.js'

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 目录级结果缓存 —— 本模块的数据源是「宿主机自己写的只读投影」
 * （`session_projcache/sessions/` 在本机有 ~460 个文件 / 108MB）。
 * `GET /projects` 原先**每次请求**都同步读+parse 一遍这 108MB，实测冷 4.2s / 热 2.0s，
 * 直接把宿主事件循环占住。
 *
 * 失效判据 = **逐文件 `name + size + mtimeMs` 签名**，实测取一次签名约 3.9ms
 * （`readdirSync` 1.2ms + 460 次 `statSync` 2.7ms），相对读内容的 2051ms 是 525×。
 *
 * 判据的边界（**环境依赖，不要当成保证**）：
 *   - 宿主自己写会话投影时，`size` 或 `mtime` 必有一个变（本机 APFS 实测 `mtimeMs`
 *     有亚毫秒精度，同名同大小的原地改写也能察觉）→ 日常路径都安全；
 *   - **已知失效形态**：`(name, size, mtimeMs)` 三元组被精确复原时察觉不到 ——
 *     从备份/快照还原、`rsync --times`、`tar -x`、`git checkout` 这类保留 mtime 的写回；
 *     mtime 粒度只到秒的文件系统（部分 SMB/HFS+）会把窗口放大到 1 秒。
 *     这两种都**不是本目录的正常写入方式**（写入方就是宿主自己），故按可接受风险收下。
 *     （将来若要堵上：`utimes` 改不了 `ctime`，把 ctime 纳入签名即可。）
 *
 * 只对**进程内**有意义：多进程共享同一 `DSH_HOME` 时，另一进程写出的文件表现为
 * 本进程下一次取签名时被发现（`DSH_HOME` 的写入方本就是宿主自己）。
 */
const dirCache = new Map()

/**
 * 目录签名：只做 metadata，不读文件内容。目录不可读 → `null`（调用方当空处理）。
 * @param {string} dir
 */
export function dirSignature(dir) {
  let names
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return null
  }
  let signature = ''
  for (const name of names) {
    let stat
    try {
      stat = statSync(join(dir, name))
    } catch {
      continue // 刚被删掉：这次签名里不算它，下次就不会命中
    }
    signature += `${name}\u0000${stat.size}\u0000${stat.mtimeMs}\n`
  }
  return { names, signature, count: names.length }
}

/**
 * 按目录签名缓存一次「读整个目录」的结果。
 * @param {string} dir
 * @param {(names: string[]) => unknown} build 只在签名变化时调用
 */
function memoByDir(dir, build) {
  const current = dirSignature(dir)
  if (current === null) return build([])
  const hit = dirCache.get(dir)
  if (hit && hit.signature === current.signature) return hit.value
  const value = build(current.names)
  // 只留最近若干目录，避免长期驻留出无界增长（本机实际只会有寥寥几个）
  if (dirCache.size > 16) dirCache.clear()
  dirCache.set(dir, { signature: current.signature, value })
  return value
}

/** 测试用：丢掉目录缓存（真实调用方不需要）。 */
export function resetWorkspaceCaches() {
  dirCache.clear()
}

/** 宿主项目注册表（读不到就返回空数组，绝不抛）。 */
export function readWorkspaceRegistry(env = process.env) {
  const file = join(dshHome(env), 'storages', 'workspace.json')
  if (!existsSync(file)) return []
  const doc = readJson(file)
  const table = doc?.tables?.workspaces
  if (!table || typeof table !== 'object') return []
  const out = []
  for (const [key, record] of Object.entries(table)) {
    const path = record?.path
    if (!path) continue
    out.push({
      id: projectIdFromCwd(path),
      name: record.title ?? basename(path),
      root: path,
      remote: null,
      sessionIds: Array.isArray(record.sessionIds) ? record.sessionIds : [],
      createdAt: record.createdAt ?? null,
      updatedAt: record.updatedAt ?? null,
      source: 'workspace-registry',
      key,
    })
  }
  out.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  return out
}

/** 会话投影缓存（零解压）：`[{ sessionId, cwd, createdAt, title }]`。
 *
 * 结果按目录做 metadata 失效缓存 —— `limit` 只在缓存结果上切片，所以**全量解析只做一次**，
 * 不同 limit 的调用不会再各自重读 108MB。
 */
export function readProjectCaches(env = process.env, { limit = 600 } = {}) {
  const dir = join(dshHome(env), 'storages', 'session_projcache', 'sessions')
  if (!existsSync(dir)) return []
  const all = memoByDir(dir, (names) => {
    const out = []
    for (const name of names) {
      const doc = readJson(join(dir, name))
      const identity = doc?.record?.identity
      const cwd = identity?.cwd
      if (!cwd) continue
      out.push({
        sessionId: name.replace(/\.json$/, ''),
        cwd,
        createdAt: identity.createdAt ?? null,
        title: doc?.record?.rows?.title?.val ?? null,
      })
    }
    return out
  })
  return Array.isArray(all) ? all.slice(0, limit) : []
}

/** 去重后的项目候选（供下拉/工具面用）。 */
export function projectCandidatesFrom(registry, caches, { limit = 80 } = {}) {
  const seen = new Map()
  for (const p of registry) {
    if (!seen.has(p.id)) seen.set(p.id, p)
  }
  for (const c of caches) {
    const id = projectIdFromCwd(c.cwd)
    if (!seen.has(id)) seen.set(id, { id, name: basename(c.cwd) || id, root: c.cwd, remote: null, source: 'session-cache' })
  }
  return [...seen.values()].slice(0, limit)
}
