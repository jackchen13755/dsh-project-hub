/**
 * schema 迁移（只增不改：新版本往后追加，历史版本永不修改）。
 *
 * 三条纪律（对齐 dsh-memory-core）：
 *   1. `project_id` / `requirement_id` 一律用**空串**而不是 NULL —— SQLite 唯一索引里
 *      NULL 彼此不相等，用 NULL 会让「同一天同会话只写一条」的幂等索引失效；
 *   2. 扫描派生的记录靠**部分唯一索引**（`WHERE source='session-scan'`）幂等，
 *      手工记录不受该约束（同一天同一需求可以记多条）；
 *   3. 时间戳：`*_at` 是 epoch ms，`date` 是时区化的 `YYYY-MM-DD` 文本（可直接比较排序）。
 */

export const SCHEMA_VERSION = 6

export const MIGRATIONS = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root TEXT,
  remote TEXT,
  aliases TEXT,
  kind TEXT DEFAULT 'work',
  created_at INTEGER,
  updated_at INTEGER,
  last_seen_at INTEGER,
  archived_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name ON projects(name);

CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  no TEXT,
  title TEXT,
  project_id TEXT NOT NULL DEFAULT '',
  status TEXT DEFAULT 'developing',
  priority TEXT,
  doc_url TEXT,
  doc_title TEXT,
  doc_local TEXT,
  doc_title_at INTEGER,
  wbs_url TEXT,
  wbs_note TEXT,
  design_url TEXT,
  design_note TEXT,
  tags TEXT,
  extra TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  last_worked_at TEXT,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_req_project ON requirements(project_id);
CREATE INDEX IF NOT EXISTS idx_req_no ON requirements(no);
CREATE INDEX IF NOT EXISTS idx_req_archived ON requirements(archived_at);

CREATE TABLE IF NOT EXISTS work_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  requirement_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'dev',
  title TEXT,
  detail TEXT,
  minutes INTEGER,
  source TEXT NOT NULL DEFAULT 'manual',
  session_id TEXT,
  evidence TEXT,
  created_at INTEGER,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_logs_date ON work_logs(date);
CREATE INDEX IF NOT EXISTS idx_logs_project ON work_logs(project_id, date);
CREATE INDEX IF NOT EXISTS idx_logs_req ON work_logs(requirement_id, date);
CREATE INDEX IF NOT EXISTS idx_logs_archived ON work_logs(archived_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_scan_unique
  ON work_logs(date, project_id, requirement_id, session_id)
  WHERE source = 'session-scan';

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  requirement_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  msgs INTEGER DEFAULT 0,
  tool_calls INTEGER DEFAULT 0,
  first_time INTEGER,
  last_time INTEGER,
  sample TEXT,
  session_title TEXT,
  scanned_at INTEGER,
  UNIQUE (date, project_id, requirement_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_activity_date ON activity(date);
CREATE INDEX IF NOT EXISTS idx_activity_req ON activity(requirement_id, date);

CREATE TABLE IF NOT EXISTS scanned_sessions (
  session_id TEXT PRIMARY KEY,
  path TEXT,
  cwd TEXT,
  project_id TEXT,
  first_time INTEGER,
  last_time INTEGER,
  msgs INTEGER,
  events INTEGER,
  days TEXT,
  mtime INTEGER,
  bytes INTEGER,
  scanned_at INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_scanned_project ON scanned_sessions(project_id);
`,
  },
  {
    // v2：修 v1 提取规则的写坏数据 —— 弱模式曾取错捕获组，把字母前缀当需求号
    //（`Number("SPMS")` = NaN），于是派生出一批 `xxx-NaN` 的假需求 id。
    // 做法：删掉这些派生行 + 清空扫描水位 —— 下次**增量**扫描会自然重新派生
    //（activity 是替换语义、work_logs 有部分唯一索引，重扫不会翻倍）。
    version: 2,
    sql: `
DELETE FROM activity WHERE requirement_id LIKE '%-NaN';
DELETE FROM work_logs WHERE requirement_id LIKE '%-NaN';
DELETE FROM scanned_sessions;
`,
  },
  {
    // v3：`projects.name` 不能唯一 —— 两个不同工作目录可以同名
    //（`~/Desktop/work/spms` 与 `~/Desktop/work/spms-ui/spms` 都叫 spms），
    // v1 的唯一索引会让后者插入时直接 `UNIQUE constraint failed: projects.name`，
    // 连带整条会话扫描失败（实测 10 个会话中招）。项目身份以 **id** 为准，name 只作显示。
    version: 3,
    sql: `
DROP INDEX IF EXISTS idx_projects_name;
CREATE INDEX IF NOT EXISTS idx_projects_name_lookup ON projects(name);
`,
  },
  {
    // v4：链接从「一个需求一条 URL」升级为「一个需求 N 条链接」（UI / 需求 / WBS / 设计 都可多条）。
    //
    //   - 新表 `requirement_links` 是链接的事实源：`(requirement_id, kind, url)` 唯一，
    //     kind ∈ doc(需求文档) / wbs / design(后端设计) / ui(UI 设计) / other；
    //   - `requirements` 上的旧列（doc_url / wbs_url / design_url + 备注）**保留**，
    //     作为「该 kind 主链接」的镜像 —— 老接口、老面板、老测试继续可用；
    //   - 新增 `ui_url` / `ui_note` 列镜像 UI 主链接；
    //   - 迁移把旧列里的历史链接灌进新表，不丢数据。
    version: 4,
    run(db) {
      // ① 新列（SQLite 没有 ADD COLUMN IF NOT EXISTS → 先查 PRAGMA，保证可重放）
      const columns = new Set(db.prepare('PRAGMA table_info(requirements)').all().map((row) => row.name))
      if (!columns.has('ui_url')) db.exec('ALTER TABLE requirements ADD COLUMN ui_url TEXT')
      if (!columns.has('ui_note')) db.exec('ALTER TABLE requirements ADD COLUMN ui_note TEXT')

      // ② 链接表
      db.exec(`
CREATE TABLE IF NOT EXISTS requirement_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'other',
  url TEXT NOT NULL,
  title TEXT,
  note TEXT,
  sort INTEGER DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_links_req ON requirement_links(requirement_id, kind, sort);
CREATE UNIQUE INDEX IF NOT EXISTS idx_links_unique ON requirement_links(requirement_id, kind, url);
`)

      // ③ 把旧单值列里的历史链接灌进新表（OR IGNORE → 重放安全）
      const backfill = [
        ['doc', 'doc_url', 'doc_title', 'NULL'],
        ['wbs', 'wbs_url', 'NULL', 'wbs_note'],
        ['design', 'design_url', 'NULL', 'design_note'],
      ]
      for (const [kind, urlCol, titleExpr, noteExpr] of backfill) {
        db.exec(`
INSERT OR IGNORE INTO requirement_links (requirement_id, kind, url, title, note, sort, created_at)
  SELECT id, '${kind}', ${urlCol}, ${titleExpr}, ${noteExpr}, 0, COALESCE(created_at, 0)
  FROM requirements WHERE ${urlCol} IS NOT NULL AND ${urlCol} <> '';
`)
      }
    },
  },
  {
    // v5：读文档时顺带记下「谁创建的」「谁是产品」（用户要求：标注出谁是产品）。
    // 这两列由 `lib/doc-meta.js` 从页面/Confluence REST 里读出来 —— 角色表里的其它角色
    // （UI / 前端 / 后端 / QA…）塞进既有的 extra JSON，不再为每个角色加列。
    version: 5,
    run(db) {
      const columns = new Set(db.prepare('PRAGMA table_info(requirements)').all().map((row) => row.name))
      if (!columns.has('creator')) db.exec('ALTER TABLE requirements ADD COLUMN creator TEXT')
      if (!columns.has('product')) db.exec('ALTER TABLE requirements ADD COLUMN product TEXT')
    },
  },
  {
    // v6：一条需求可以在**多个项目**里开发，每个项目各自带「端」（PC / APP / 服务端…）。
    // `requirements.project_id` 保留为「主项目」（需求 ID 前缀、旧接口的筛选口径都靠它），
    // 多项目关系放这张表；主项目 = is_primary=1 的那条。
    version: 6,
    run(db) {
      db.exec(`
CREATE TABLE IF NOT EXISTS requirement_projects (
  requirement_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  platform TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_req_projects_unique ON requirement_projects(requirement_id, project_id);
CREATE INDEX IF NOT EXISTS idx_req_projects_req ON requirement_projects(requirement_id, sort);
`)
      // 回填：已有的单项目需求 → 一条主项目记录（OR IGNORE → 可重放）
      db.exec(`
INSERT OR IGNORE INTO requirement_projects (requirement_id, project_id, platform, is_primary, sort, created_at, updated_at)
  SELECT id, project_id, NULL, 1, 0, COALESCE(created_at, 0), COALESCE(updated_at, 0)
  FROM requirements WHERE project_id IS NOT NULL AND project_id <> '';
`)
    },
  },
]
