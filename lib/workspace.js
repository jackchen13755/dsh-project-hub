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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { dshHome, projectIdFromCwd } from './paths.js'

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
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

/** 会话投影缓存（零解压）：`[{ sessionId, cwd, createdAt, title }]`。 */
export function readProjectCaches(env = process.env, { limit = 600 } = {}) {
  const dir = join(dshHome(env), 'storages', 'session_projcache', 'sessions')
  if (!existsSync(dir)) return []
  const out = []
  let names = []
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).slice(0, limit)
  } catch {
    return []
  }
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
