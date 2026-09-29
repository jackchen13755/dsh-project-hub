# dsh-project-hub 设计

> 一句话：把「需求 → 文档/WBS/后端设计 + 所属项目」和「哪天在开发哪个项目的哪个需求」
> 收进一张 SQLite 台账，按项目 / 需求 / 日期随时检索。

## 1. 事实源与目录

- 事实源：SQLite `$DSH_HOME/project-hub/hub.db`（与 dsh-memory-core 同款做法：`node:sqlite`
  的 `DatabaseSync`，WAL + busy_timeout，迁移表 `meta.schema_version`）。
- 派生：`/project-hub/api/*` HTTP 路由（给 Web 面板）+ agent 工具面（`ph_*`）。
- 备份：`$DSH_HOME/project-hub/backups/hub-YYYYMMDD.db`（`VACUUM INTO`）。
- **不联网也能用**：GitHub（仓库 jackchen13755/dsh-project-hub）只是代码的家，数据不上云。

## 2. 数据模型（schema v1）

| 表 | 作用 | 关键列 |
| --- | --- | --- |
| `meta` | 键值 | `schema_version`、`last_scan_at` |
| `projects` | 项目台账 | `id`(slug) `name` `root` `remote` `aliases` `kind` `last_seen_at` |
| `requirements` | 需求台账（按需求 ID 唯一） | `id` `no` `title` `project_id` `status` `priority` `tags` `extra` `last_worked_at` `archived_at` + 各类**主链接镜像** `doc_url/doc_title`、`wbs_url/wbs_note`、`design_url/design_note`、`ui_url/ui_note` |
| `requirement_links` | **链接事实源**（每类可多条） | `requirement_id` `kind`(doc/wbs/design/ui/other) `url` `title` `note` `sort`，唯一键 `(requirement_id, kind, url)` |
| `work_logs` | 开发记录（手工 + 扫描） | `date` `project_id` `requirement_id` `kind` `title` `detail` `minutes` `source` `session_id` `evidence` `archived_at` |
| `activity` | 扫描派生的「天 × 项目 × 需求 × 会话」聚合 | `date` `project_id` `requirement_id` `session_id` `msgs` `tool_calls` `first_time` `last_time` `sample` |
| `scanned_sessions` | 扫描水位（增量） | `session_id` `path` `cwd` `project_id` `mtime` `bytes` `days` `scanned_at` |

- 需求 ID 前缀由实现侧拼接：无 `id` 时用 **`<项目显示名大写>-<需求号>`**（`spms` → `SPMS-5921`）。
  用显示名而不是 slug，是因为同一个产品的多个仓库（`work/spms` 与 `work/spms-ui/spms`）目录名相同、
  slug 不同；用显示名可让同一个需求（SPMS-5921）只占一条台账，而每条开发记录仍保留自己的
  `project_id`，报表照样能区分是哪个仓库。
- **链接是多条模型（v4）**：UI 设计 / 需求文档 / WBS / 后端设计 / 其它，**每类都可以多条**；
  `requirement_links` 是事实源，`requirements` 的旧列只是「各类第一条链接」的镜像（老接口继续可用）。
  写入语义：`links:[{kind,url,title,note}]` 按 `(kind,url)` upsert；`replaceLinks:true` 时按类整体替换
  （只动传了的类别）；单值字段 `docUrl/wbsUrl/designUrl/uiUrl` = **替换该类主链接**（换 URL 会清空旧标题）。
  文档类链接缺标题会逐条读回（一次保存最多 3 条，避免贴十几条链接时打爆网络）。
- 扫描生成的工作记录幂等：唯一索引 `(date, project_id, requirement_id, session_id) WHERE source='session-scan'`。
- 搜索用 `LIKE` 子串匹配（数据量百级，实测毫秒级），中文不需要分词器。
- `search().days` 与 `report().days` **同一口径**（扫描活动 + 手工记录都出现），避免面板两个视图对不上；
  只有手工记录的那天会回查 `projects` 表补 `projectName`。
- 项目 id 用 Unicode slug（`\p{L}\p{N}`）：中文目录保留，不与同名 ASCII 目录撞 id，也不塌成 `unknown`。
- 扫描 `dryRun` 报的是「**将会写入**多少」（回查部分唯一索引），不是恒为 0。

## 3. 会话扫描（「哪天开发了哪些项目的哪些需求」）

- 会话日志：`$DSH_HOME/sessions/<mangled-cwd>/<session-id>/session.v<N>.jsonl.zstd`，
  **多帧 zstd 追加**，必须逐帧解压（帧边界算法见 `dsh-memory-core/lib/session-log.js`，本插件自带一份实现）。
- 第 1 条事件是会话头：`{type:'session', id, createdAt, cwd, agentPreset}` → 明文 `cwd` 直接给出**项目**。
- 之后每条事件都有 `time`（epoch ms）+ `seq`：按 `Asia/Shanghai` 归日 → **哪一天**。
- 从 `user/message` / `assistant/message` 文本里抽需求号（`【5921】`、`#5921`、`REQ-5921`、
  `BUG 55036`、`需求 5921`、`单号 5921`）→ **哪个需求**。
- 增量（**唯一模式**）：`scanned_sessions` 记 `mtime+bytes`，未变则跳过；失败过的会话下次重试。
  提取规则变更要重新派生时，走 schema 迁移清空水位（见 `lib/schema.js` v2），不提供「全量重扫」入口。
- `limit` 的语义是**本轮真正扫描的会话数上限**（默认 300，文件枚举始终看全量）——否则会话总数一旦超过
  limit，排在后面的会话会永远轮不到。
- 产出：`activity` 明细 + `work_logs`（`source='session-scan'`，标题形如「开发 SPMS-5921」）。

## 4. 需求文档标题（R4）

`lib/doc-title.js`：`local:`/绝对路径 → 读文件（front-matter `title:` → 首个 `# H1` → 文件名）；
`http(s)` → 抓 HTML（10s 超时、256KB 截断）→ `<title>`（剥站点后缀）→ 首个 `<h1>`。
`ph_save_requirement` 默认 `readTitle`，标题缺省时自动回填。

## 5. 项目来源（R3）

`lib/projects.js`：候选 = ① 当前会话 cwd 及其子目录里的 git 仓库；② 会话日志里出现过的 cwd；
③ 库里已有项目。项目 id 由「去掉工作根前缀后的相对路径」slug 化（`spms`、`spms-ui-spms`），
有 git remote 时附 `remote` 便于识别。UI 用下拉选择，工具面也可传 `project` 名/别名。

## 6. HTTP API 契约（前缀 `/project-hub/api`）

统一 JSON；失败 `{ ok:false, error }` + 4xx/5xx。

| 方法 | 路径 | 入参 | 返回 |
| --- | --- | --- | --- |
| GET | `/status` | - | `{ ok, version, dbPath, counts:{projects,requirements,workLogs,activity,scannedSessions}, lastScanAt, scanIntervalMinutes }` |
| GET | `/projects` | `cwd?` | `{ ok, projects:[{id,name,root,remote,requirementCount,lastWorkedDate,lastSeenAt}], candidates:[{id,name,root,source}] }` |
| POST | `/projects/add` | `{ name, root?, aliases? }` | `{ ok, project }` |
| GET | `/requirements` | `project?,q?,status?,archived?,limit?,offset?` | `{ ok, total, items:[{id,no,title,projectId,projectName,status,tags,updatedAt,lastWorkedAt,workCount,archivedAt,links:[{id,kind,kindLabel,url,title,note}]}] }` |
| GET | `/requirements/get` | `id` | `{ ok, requirement（含 links 与各类主链接字段）, logs:[...], days:[...] }` |
| POST | `/requirements/save` | `{ id?,no?,project,title?,docUrl?,wbsUrl?,designUrl?,uiUrl?,…Note?,links?:[{kind,url,title?,note?}],replaceLinks?,status?,priority?,tags?,readTitle? }` | `{ ok, requirement（含 links）, titleRead:{title,source}\|null, linkKinds }` |
| POST | `/requirements/link/add` | `{ id, kind, url, title?, note? }` | `{ ok, link, links:[...] }` |
| POST | `/requirements/link/remove` | `{ id, linkId? \| kind?+url? }` | `{ ok, removed, links:[...] }` |
| POST | `/requirements/archive` | `{ id, archived? }` | `{ ok, changed, requirement }` |
| POST | `/requirements/delete` | `{ id }` | `{ ok, deleted }` |
| GET | `/logs` | `project?,requirement?,from?,to?,kind?,q?,limit?,offset?` | `{ ok, total, items:[{id,date,projectId,requirementId,kind,title,detail,minutes,source,sessionId,evidence}] }` |
| POST | `/logs/add` | `{ date?,project,requirement?,kind?,title,detail?,minutes? }` | `{ ok, log }` |
| POST | `/logs/delete` | `{ id }` | `{ ok }` |
| GET | `/search` | `q?,project?,requirement?,from?,to?,kind?,limit?` | `{ ok, requirements:[...], logs:[...], days:[{date,projects:[{projectId,projectName,requirements:[{id,title,msgs,lastTime}]}]}] }` |
| POST | `/scan` | `{ since?,dryRun?,limit? }`（只做增量；传 `full`/`rebuild` 会在响应里回 `ignored` + `note`） | `{ ok, sessions, changed, skipped, activities, logs, days, errors, errorDetails, ignored? }` |
| GET | `/report` | `from?,to?,project?` | `{ ok, days:[{date,projects:[{projectId,projectName,logCount,requirements:[{id,title,msgs,toolCalls,lastTime}]}]}], totals }` |
| POST | `/doc-title` | `{ url?,path? }` | `{ ok, title, source }` |

## 7. Agent 工具面

`ph_save_requirement` · `ph_get_requirement` · `ph_list_requirements` · `ph_list_projects` ·
`ph_log_work` · `ph_link`（链接 add/remove/list）· `ph_search` · `ph_scan_sessions` · `ph_report` ·
`ph_archive` · `ph_doc_title`

## 8. 面板（lib/client.js）

**座位**：宿主右侧边栏页签 —— `ctx.inject(['sidebarRightTabs'])` 注册页签类型（`id`/`kind` 全局唯一）、
`slots.register('sidebar.right.pane.tab', { key: TYPE_ID })` 注册主体、`…pane.tab.title` 注册标题，
`sidebarRight.openTab(KIND)` 打开；**入口按钮**走 `sidebar.footer.action`（侧边栏底部「📋 项目管理」）。
内联渲染约束：根节点 `flex:1 1 auto` 撑满座位、滚动区 `min-height:0`，不渲染悬浮层/固定抽屉。

**内容**：工具栏（搜索 + 项目下拉 + 日期区间 + 类型 + 只看已归档 + 扫描 + 状态行）→ 需求台账卡片
（链接按类展示，每类带条数）/ 开发日志列表 → 两个折叠表单。需求表单里 **UI 设计 / 需求文档 / WBS /
后端设计** 四类各有「＋ 添加一条」，每条可填 URL / 标题 / 备注、可单条删除，「读标题」按条读回；
详情里还能直接加链接、逐条删除。数据全部走上面的 HTTP 契约，失败一律顶部提示条反馈。