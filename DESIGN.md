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

## 3.5 标签（`requirements.tags`）

一列逗号拼接的文本（`parseTags` 支持数组或中英文逗号字符串）。三处用法与两个口径：

| 用途 | 实现 |
| --- | --- |
| 聚合给 UI | `store.listTags({archived,project})` → `[{tag,count}]`，按条数降序、同数按**码位**排序（不用 `localeCompare('zh')`：排序随 ICU 版本飘，下拉顺序会变） |
| 筛选 | `listRequirements({tag})` / `search({tag})`，SQL 用 `(',' || REPLACE(tags,' ','') || ',') LIKE '%,tag,%'` 做**整词**匹配 —— 否则「评审」会把「待评审」也捞进来 |
| 输入补全 | 客户端 `parseTagInput` / `addTagToText` / `tagSuggestions`（排除已选、排除像 URL 的条目、按次数降序、最多 12 个） |

> 实测坑：有人在「标签」框里贴了 Figma 设计稿链接（应填在「UI 设计」链接里）。所以
> `tagSuggestions` 会把含 `://`、超过 32 字的条目挡在建议之外，避免这种脏数据扩散成"标签"。

## 4. 需求文档标题（R4）

`lib/doc-title.js`：`local:`/绝对路径 → 读文件（front-matter `title:` → 首个 `# H1` → 文件名）；
`http(s)` → 抓 HTML（10s 超时、256KB 截断）→ `<title>`（剥站点后缀）→ 首个 `<h1>`。
`ph_save_requirement` 默认 `readTitle`，标题缺省时自动回填。

**取页带登录态（`lib/page-fetch.js`，与 dsh-zentao-workbench 同款策略链）**：
① 浏览器中继（`dsh-fetch-page` 守护进程 `127.0.0.1:9317` 的 `POST /forward`，扩展自动附带登录 Cookie）
→ ② cookie jar（Netscape 格式：`$DSH_COOKIE_JAR` / `~/.config/zentao/cookies.txt` /
`~/.dsh/storages/dsh-zentao-workbench/cookies.txt`，按 host 匹配、剔除过期）
→ ③ 裸 fetch。**会话失效时服务端给的往往不是登录表单，而是一个跳转壳**
（禅道实测 153 字节：`<script>self.location='/index.php?m=user&f=login&referer=…'</script>`，既无 `<title>` 也无表单），
所以链路会**跟一跳**（最多 2 跳）后再判定。**拿到登录页时**（`looksLikeLoginPage`：标题以 登录/登陆/login 开头、
或「账号+密码」表单、或「请先登录」文案、或跳转目标含 `f=login`）不写标题，而是返回
`{ ok:false, source:'needs-login', needsLogin:true, staleJar, hops, strategy, error }`（error 里带上每一跳的原因与处置建议），
避免把「登录」两个字当需求标题存进台账。
> 实测：本机 `~/.config/zentao/cookies.txt`（2026-09-23 导出）里的会话已过期 → 服务端把请求跳到登录页，
> 链路如实报 `staleJar:true` 并提示「重新导出 jar 或连上浏览器扩展」；`~/.local/bin/zentao-export-cookies` 重导后即可自动读回真实标题。
> 坑：判定正则不能写 `(登录)\b` —— `\b` 只在「词字符/非词字符」交界成立，中文不是 `\w`，
> `登录 - 禅道` 永远匹配不上（本项目实测踩过）。

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
| POST | `/requirements/delete` | `{ id }` | `{ ok, deleted }`（**硬删**：连同该需求的全部链接） |
| GET | `/logs` | `project?,requirement?,from?,to?,kind?,q?,limit?,offset?` | `{ ok, total, items:[{id,date,projectId,requirementId,kind,title,detail,minutes,source,sessionId,evidence}] }` |
| POST | `/logs/add` | `{ date?,project,requirement?,kind?,title,detail?,minutes? }` | `{ ok, log }` |
| POST | `/logs/update` | `{ id, date?,project?,requirement?,kind?,title?,detail?,minutes? }`（只改传了的字段；扫描派生的记录也能改，且不被重扫覆盖） | `{ ok, log }` |
| POST | `/logs/delete` | `{ id }` | `{ ok, deleted }`（硬删，不可恢复） |
| GET | `/search` | `q?,project?,requirement?,from?,to?,kind?,limit?` | `{ ok, requirements:[...], logs:[...], days:[{date,projects:[{projectId,projectName,requirements:[{id,title,msgs,lastTime}]}]}] }` |
| POST | `/scan` | `{ since?,dryRun?,limit? }`（只做增量；传 `full`/`rebuild` 会在响应里回 `ignored` + `note`） | `{ ok, sessions, changed, skipped, activities, logs, days, errors, errorDetails, ignored? }` |
| GET | `/report` | `from?,to?,project?` | `{ ok, days:[{date,projects:[{projectId,projectName,logCount,requirements:[{id,title,msgs,toolCalls,lastTime}]}]}], totals }` |
| POST | `/doc-title` | `{ url?,path? }` | `{ ok, title, source }` |
| GET | `/requirements/tags` | `archived?,project?` | `{ ok, tags:[{tag,count}] }`（按条数降序，同数按码位；面板下拉与表单补全共用） |
| GET | `/brief` | `id?,project?,task?,logs?` | `{ ok, brief, project:{id,name,root}, requirement:{id,title,status,links} }` |
| POST | `/open-session` | `{ id, task?, logs? }` | `{ ok, prompt, project, workspace:{id,path,title,created}\|null, workspaceError, canCreate, requirement }` |

## 7. Agent 工具面

`ph_save_requirement` · `ph_get_requirement` · `ph_list_requirements` · `ph_list_projects` ·
`ph_log_work`（新增/编辑）· `ph_link`（链接 add/remove/list）· `ph_brief`（需求简报/提示词）·
`ph_search` · `ph_scan_sessions` · `ph_report` · `ph_archive` · `ph_doc_title`

## 8. 面板（lib/client.js）

**座位**：宿主右侧边栏页签 —— `ctx.inject(['sidebarRightTabs'])` 注册页签类型（`id`/`kind` 全局唯一）、
`slots.register('sidebar.right.pane.tab', { key: TYPE_ID })` 注册主体、`…pane.tab.title` 注册标题，
`sidebarRight.openTab(KIND)` 打开；**入口按钮**走 `sidebar.footer.action`（侧边栏底部「📋 项目管理」）。
内联渲染约束：根节点 `flex:1 1 auto` 撑满座位、滚动区 `min-height:0`，不渲染悬浮层/固定抽屉。

**内容（三个 tab 严格分开，不混在一起）**：
- **需求台账**：筛选（搜索 / 项目 / **标签** / 只看已归档；标签选项来自 `/requirements/tags`，带条数，
  卡片与详情里的 `#标签` 点一下即按它筛，当前筛选以一颗可清除的胶囊显示）+ 需求卡片（链接按类分组，**类别胶囊与每条链接都可点**；
  **项目胶囊按项目稳定配色** —— 对项目 id 做哈希取 12 色中间调色板，同一项目永远同色）+
  「＋ 需求」新建 与「编辑」载入表单（`replaceLinks` 整份保存链接）；
- **归档视图**（`只看已归档` 打开时）：顶部黄色提示条 + 每项多一个「删除」按钮。
  删除是**硬删且两段确认**（第一次点变「确认删除？」，再点才真删；`deleteButtonLabel` 是这条状态的纯函数），
  删需求会连带删掉它的全部链接；「恢复」则把条目放回日常列表；
- **开发日志**：筛选（搜索 / 项目 / 日期区间 / 类型）+ 记录列表（「编辑」→ `POST /logs/update`）+
  「＋ 记录」新增；
- **会话扫描**：扫描状态卡（上次扫描 / 周期 / 错误 / 会话文件·变更·跳过·活动·记录·天数）+
  「立即增量扫描」「预览（dryRun）」+ 按天活动报表（可跳到日志 tab 按那天过滤）。

需求表单里 **UI 设计 / 需求文档 / WBS / 后端设计** 四类各有「＋ 添加一条」，每条可填 URL / 标题 / 备注、
可单条删除、「读标题」按条读回，**行首 ↗ 直接打开**；详情里可直接加链接、逐条删除。
数据全部走上面的 HTTP 契约，失败一律顶部提示条反馈。

**「开新会话」（卡片与详情各一个按钮）**：宿主 `POST /open-session` 解析需求 → 渲染简报 →
把项目目录登记成宿主 workspace（`ctx.workspaceRegistry.create`），返回 `workspace.id + prompt`；
客户端再用能力探测式调用建会话并投喂首条消息（本机实测链路）：
`sessions.create({ workspaceId })` → `sessions.open(id)` → `sessions.scope(id).get('conversation').send(prompt)`，
拿不到 scope 时退到 `sessions.using(id, {}, binding => …)`；任何一步失败都**复制简报到剪贴板**并如实说明原因。