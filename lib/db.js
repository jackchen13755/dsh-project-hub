/**
 * DB 打开 / 迁移 / 备份。
 *
 * 打开即跑 PRAGMA（WAL + busy_timeout），多进程读写不互斥；schema 变更只走 MIGRATIONS，
 * 事务内执行；备份用 `VACUUM INTO`（在线、一致、不需要停写）。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureDir } from './paths.js'
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js'

/** 打开数据库并应用 PRAGMA（不建表；建表见 `migrate`）。 */
export function openDb(path, { create = true } = {}) {
  if (!create && !existsSync(path)) throw new Error(`数据库不存在：${path}`)
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
  `)
  return db
}

export function closeDb(db) {
  try {
    db.close()
  } catch {
    /* 已关闭 */
  }
}

export function currentVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
    return row ? Number(row.value) : 0
  } catch {
    return 0
  }
}

/** 顺序执行未应用的迁移；每个迁移一个事务，失败回滚且不留半成品。 */
export function migrate(db, { log = () => {} } = {}) {
  const from = currentVersion(db)
  let applied = 0
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue
    db.exec('BEGIN')
    try {
      db.exec(m.sql)
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(m.version))
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* 忽略 */
      }
      throw new Error(`迁移 v${m.version} 失败：${error.message}`)
    }
    applied += 1
    log(`schema 迁移：v${m.version} 已应用`)
  }
  return { from, to: currentVersion(db), applied, target: SCHEMA_VERSION }
}

export function getMeta(db, key, fallback = null) {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    return row ? row.value : fallback
  } catch {
    return fallback
  }
}

export function setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(String(key), String(value))
}

/** `PRAGMA quick_check`：返回 `{ ok, messages }`。 */
export function quickCheck(db) {
  try {
    const rows = db.prepare('PRAGMA quick_check').all()
    const messages = rows.map((r) => Object.values(r)[0]).filter(Boolean)
    return { ok: messages.length === 1 && messages[0] === 'ok', messages }
  } catch (error) {
    return { ok: false, messages: [error.message] }
  }
}

/** 单写者串行队列：所有写事务排队执行（读不排队）。 */
export class WriteQueue {
  constructor() {
    this.tail = Promise.resolve()
  }

  run(fn) {
    const next = this.tail.then(fn, fn)
    this.tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  idle() {
    return this.tail
  }
}

/** 每日备份：`VACUUM INTO <dir>/hub-YYYYMMDD.db`，按 `keep` 轮转。 */
export function backupDaily(db, dir, { keep = 7, now = new Date() } = {}) {
  ensureDir(dir)
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const file = join(dir, `hub-${stamp}.db`)
  if (existsSync(file)) rmSync(file)
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  const all = readdirSync(dir)
    .filter((n) => /^hub-\d{8}\.db$/.test(n))
    .sort()
    .reverse()
  const removed = []
  for (const stale of all.slice(keep)) {
    rmSync(join(dir, stale))
    removed.push(stale)
  }
  return { file, bytes: statSync(file).size, kept: Math.min(all.length, keep), removed }
}
