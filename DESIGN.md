# dsh-project-hub 设计

> 一句话：把「需求 → 文档/WBS/后端设计 + 所属项目」和「哪天在开发哪个项目的哪个需求」
> 收进一张 SQLite 台账，按项目 / 需求 / 日期随时检索。
>
> 已实现：§1–§8。**方案（未实现）：§9 需求冲突预判与变更对账** —— 治「新需求评审看不出与既有实现的冲突」
> 与「需求变更没回写到文档」两个痛点，含数据模型、采集方式、验收口径与分期。

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

## 3.8 文档结构化信息（`lib/doc-meta.js`，schema v5）

从需求文档页面里读四类东西（**全部结论来自一条真实 Confluence 页面的实测**）：

| 信息 | 来源 | 备注 |
| --- | --- | --- |
| 标题 | `<h1 id="title-text">` → `<title>`（剥 ` - 空间 - 站点` 后缀）→ 正文 h1 | Confluence **REST 的 `title` 最干净**，有 pageId 时优先用它 |
| **谁创建的** | Confluence `/rest/api/content/<id>?expand=history,version,space` | ⚠️ 服务端 HTML **没有**创建者；页面 JS 包里那行 `//作者 xxx@…` 是**插件作者注释**，拿它当创建者就是误判（实测踩到） |
| **谁是产品** | 正文「相关人员」表：`产品：X` / `UI：Y` / `前端：Z` / `后端：…` / `QA：…` | `产品经理 > 产品负责人 > 产品` 依次取；全量角色塞 `extra.roles`（不为每个角色加列） |
| **UI 设计链接** | 正文文本 **+ `<a href>`**（`PC端：<figma>` / `APP端：<figma>`） | 只在 `href` 里的也要收（夹具先行暴露了这个漏洞）；保存时按 `(requirement_id,'ui',url)` **OR IGNORE** 并入，重复保存不会长两条 |

保存路径（`store.saveRequirement`）：**先读文档 → 再定需求号/需求 ID → 落 creator/product/roles → 并入 UI 链接**，
返回 `{ noFromTitle, metaFromDoc, uiFromDoc }` 供面板与工具提示「需求号 5922 取自标题 / 带出 2 条 UI 链接」。

> 隐私：这一层解析过的真实人名/域名**不得**进仓库 —— 测试夹具一律用假人名（张三/李四）与 `*.example.com`。

## 3.9 多项目 + 每个项目的「端」（schema v6）

一条需求常常要在多个项目里开发（PC 端一个仓库、APP 端另一个）。模型：

| 位置 | 作用 |
| --- | --- |
| `requirement_projects(requirement_id, project_id, platform, is_primary, sort)` | 需求 ↔ 多项目；`platform` 就是「端」；**第一条 = 主项目** |
| `requirements.project_id` | 保留为**主项目镜像**（需求 ID 前缀、老筛选口径靠它）；`setRequirementProjects` 会同步（空列表时不动，避免需求变孤儿） |
| `listRequirements({project})` | 改成「主项目 **或任一挂载项目**」命中，否则副项目里的需求筛不出来 |

**提示词按端裁剪**（`briefPlatformSlice`）：
- 判据是「链接标题**正好等于**一个端名」（`PLATFORM_TITLES`），不是「包含」——
  `《后端设计》` 含「后端」，用包含法会把这条**通用资料**当成服务端剔掉（实测踩到）。
- 本端的 + 没标端的都留；另一端的剔出去，并在提示词末尾写一行
  「另有 N 条属于 X 的资料**本次不用看**」，不做静默丢弃。
- 任务段写死：`本次只做 **X 端** 的开发` / `只实现与 X 端相关的部分；文档里其它端（Y）的内容不要实现、不要照抄`
  / `文档中只描述其它端的段落直接跳过，并在结论里说明「与本次无关」`。

## 4. 需求文档标题（R4）

`lib/doc-title.js`：`local:`/绝对路径 → 读文件（front-matter `title:` → 首个 `# H1` → 文件名）；
`http(s)` → 抓 HTML（10s 超时、256KB 截断）→ `<title>`（剥站点后缀）→ 首个 `<h1>`。
`ph_save_requirement` 默认 `readTitle`，标题缺省时自动回填。

**取页带登录态（`lib/page-fetch.js`，与 dsh-zentao-workbench 同款策略链）**：
① 浏览器中继（`dsh-fetch-page` 守护进程 `127.0.0.1:9317` 的 `POST /forward`，扩展自动附带登录 Cookie）
> ⚠️ **只要守护进程可达就实测转发，不看 `/status` 的 `running` 标志**：本机实测 `running:false` 时
> `POST /forward` 依然 200 拿到页面（禅道插件注释里也记了「该标志不可靠，以实测为准」）。
> 本项目曾信了这个标志 → 中继整跳被跳过 → 掉到裸 fetch → 内部站点只剩登录页（用户实测报障）。
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
> jar 没命中时 `jarLookup()` 会带回「扫过的 jar 里都有哪些 host」，错误里直接说
> 「jar 里没有 X 的 Cookie（现存的 jar 只有：zen.example.com）」，比「没有可用的 jar」有用得多。
>
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
| POST | `/requirements/status` | `{ id, status }`（只改状态，严格校验 7 个正式状态 + 中文别名；卡片下拉与「开新会话自动置开发中」都走它） | `{ ok, changed, requirement }` |
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

**两个「开新会话」**：`POST /open-session {branch:true}` 会在提示词里插入「## 开工前：从 master 拉新分支并切过去」
（分支名 + 命名格式 + `git fetch origin && git checkout -b <branch> origin/master` + 「已存在就直接切」+「基线是 master」）。
分支名由 `lib/branch.js` 生成：`feature/YYYYMMDD-<英文slug>-<需求号>`，日期按 `Asia/Shanghai`，
英文 slug 只保留标题里的拉丁字母/数字段（纯中文标题退化成 `req`），**同一天同一需求稳定复现**。
不带 `branch` 的路径**一个字节都没变** —— 测试会把分支段整块抠掉后断言两份提示词完全一致。

**复制 vs 开会话**：卡片「复制」/ 详情里每个项目的「复制」走 `GET /brief`（**纯渲染**：不登记 workspace、
不建会话），剪贴板不可用时把简报正文显示在提示条里；「开新会话」才走 `POST /open-session`（会 ensureWorkspace）。
这条边界有测试钉住：复制路径下 `ensureWorkspace` 的调用次数必须是 0。

**状态**：卡片上的状态下拉直接改（`POST /requirements/status`，只碰 `status` + `updated_at`，
不重写标题/链接/项目）；`setRequirementStatus` **严格校验**（`normStatus` 对未知值原样透传，
所以这里用 `REQ_STATUSES.includes()` 二次卡一道，避免下拉/接口写进拼错的状态）。
点「开新会话」时若状态不是 `developing` 就**先置开发中再开会话**（顺序有意：开会话失败也不影响状态；
`shouldMarkDeveloping()` 决定要不要写）。

**「开新会话」（卡片与详情各一个按钮）**：宿主 `POST /open-session` 解析需求 → 渲染简报 →
把项目目录登记成宿主 workspace（`ctx.workspaceRegistry.create`），返回 `workspace.id + prompt`；
客户端再用能力探测式调用建会话并投喂首条消息（本机实测链路）：
`sessions.create({ workspaceId })` → `sessions.open(id)` → `sessions.scope(id).get('conversation').send(prompt)`，
拿不到 scope 时退到 `sessions.using(id, {}, binding => …)`；任何一步失败都**复制简报到剪贴板**并如实说明原因。
## 9. 需求冲突预判与变更对账（**方案设计，尚未实现**）

> 立此章的原因（用户 2026-09-29 提出的真实痛点）：
> ① 项目多轮迭代后，**新需求评审时无法判断是否与既有实现冲突**，往往要等开发完才撞上；
> ② **需求变更经常没回写到需求文档**，文档与实现持续漂移。
> 本章只写设计与验收口径，**未写任何代码**；实施按 §9.7 分期。

### 9.1 根因

台账里现在有三条线，但**互不相认**：

| 线 | 记的是 | 现在存在哪 |
| --- | --- | --- |
| 需求文档 | **意图**（要做什么） | `requirement_links(kind=doc)` + `doc_title` / `doc_title_at` |
| 代码 | **事实**（实际改了什么） | ❌ 完全没有 |
| 会话 / 开发记录 | **过程**（谁哪天就哪条需求说了什么、动了什么） | `work_logs` + `activity` + 会话扫描 |

冲突发生在**实现**层面，而"文档 vs 文档"的比对永远看不出冲突 —— 这就是「开发后才发现」；
变更没回写文档，本质是**文档与实现之间没人对账**（漂移）。

**解决思路一句话**：用**需求号**把三条线缝起来，把"判断冲突"从"凭记忆"变成"看证据"。

### 9.2 方案 A｜需求 ↔ 代码 影响索引（治「开发后才发现」）—— ✅ **P1 已实现（schema v7）**

> 实现状态（2026-09-29）：`lib/git-index.js` 采集/解析 + `code_touches`/`code_recent`/`code_scans` 三张表（schema v7→v8）+
> `POST /code/scan`、`GET /code/coverage|touches|recent` + 面板「代码索引」卡片 + 需求详情显示代码落点 +
> CLI `dsh-ph code scan|touches|coverage|recent`。
>
> **实测把最初的设计纠正了两处（很重要，别再按老假设实现）**：
>
> | 原始假设 | 实测（spms 近 365 天） | 改成什么 |
> | --- | --- | --- |
> | 需求号写在**提交信息**里 | 非 merge 提交 5288 个，带号的只有 **20 个（0.4%）** | 需求号的真正载体是**分支名**（`feature/20260922-log-lock-5829`、`uatfix/20260922-payment-method-55716`，175 条带号分支） |
> | 用 `merge-base + origin/main` 归属文件 | 一次给 3000–4000 个文件（整条发布线），毫无意义 | 改成 **`git diff <merge>^1 <merge>`**：实测 3–23 个文件，正是这个需求落地时的改动集；>400 文件的合并（`release-wl`/`uatfix` 这类发布线同步，占 ~6%）跳过并计数 |
>
> 两个必须记住的**假号坑**（都踩过，已修 + 回归测试）：
> ① 分支名里的 8 位日期会被宽松正则切成假号：`uatfix/20260922-payment-method-55716` → `20260` ⇒ 必须**锚定结尾** `[-_/](\d{4,6})$`；
> ② `YYYYMM` 也是日期戳：`feature/202606-cycle` → 假号 `202606` ⇒ 6 位且形如 `20xx0m/1m` 的一律排除。
>
> 实测效果：spms 扫 4000 提交 + 500 合并 → **204 个需求 / 2116 行文件归属**（提交 290 + 特性合并 128）；
> hs_config → **38 个需求 / 1585 行**。查历史需求：`5829 → isomorph/views/Reservation（88 次/41 文件）`、
> `5693 → isomorph/views/Housekeeping`（正是 5922 第 4 项同区域的 6 月那条）。新需求查出来是 0 条 —— **不编造**。
>
> 另外多了一张 `code_recent`（**全部**提交的文件活动，不带号也收）：给"这块最近谁在动"和 P2 漂移对账用。

**采集**（纯本地，无外部依赖）：
- 对每个 `projects.root` 跑一次
  `git -C <root> log --all --name-only --date=short --pretty=format:'%H%x09%ad%x09%D%x09%s' --since=<N>`
  —— 一次命令同时拿到提交号/日期/**refs（含分支名）**/主题 + 改动文件清单；
- **需求号抽取**复用会话扫描那套（`lib/session-scan.js` 的 `extractRequirementTokens`）+ 分支名规则
  （本插件生成的 `feature/YYYYMMDD-<slug>-<号>` 天然可解析，见 §8 的「开新会话·拉分支」）；
- 落库成 `code_touches(requirement_id, project_id, path, module, first_seen, last_seen, commits)`，
  其中 `module` 取路径前 2–3 段（可配 `modules.yml` 覆盖，和 tracescope 的口径一致）。

**使用**：
1. **评审预判**：新需求（文档标题/正文里的模块名、页面名、接口路径）→ 命中 `code_touches` →
   输出「**这条新需求会碰到的既有需求 × 文件**」清单（按"最近改动 + 改动次数"排序）；
2. 卡片/详情显示「代码落点」：`src/pages/queue/** ← 12 次提交，最近 2026-08-17`；
3. **带号覆盖率**：`有需求号的提交 / 总提交`，覆盖率低时提示"按分支格式提交"，这是本方案唯一的输入约束。

**验收**：任选 3 条已上线需求，人工列出它们真实改动的模块；插件给出的模块清单与人工清单
重合度 ≥ 80%，且能指到具体提交（可点击/可复制 `git show <sha>`）。
> 部分达成（2026-09-29）：接口与展示齐了，`5829`/`5693`/`55716` 三条历史需求查出来的模块
> 与人工认知一致（如 5829 → `views/Reservation` 账单相关），但「3 条 × 重合度 ≥80%」的正式验收还没做。

**局限（写清楚，避免误用）**：提交信息不带需求号的改动覆盖不到（因此要暴露覆盖率）；
跨仓库（微服务）需要在多个 `projects.root` 上都跑；重构/重命名的历史轨迹会断。

### 9.3 方案 B｜三方对账 / 文档漂移（治「变更没回写文档」）—— ✅ **P2 已实现（schema v9）**

> 实现状态（2026-09-29）：`lib/drift.js`（判定纯函数）+ `lib/doc-snapshot.js`（快照）+ `doc_snapshots`/`requirement_drift` 两张表 +
> `POST /drift/refresh`、`GET /drift` + 面板第 4 个 tab「**变更对账**」+ 工具 `ph_drift` + CLI `dsh-ph drift refresh|list`。
> 与设计的差异：**判定优先级写死了「silent 压过 doc-stale」** —— 三条线里最新的动静都超过 `silentDays`（默认 30 天）时，
> 结论是「很久没动静」而不再催「文档没跟上」（都没人动了，催文档是噪声）。
> 快照**只存** `version / hash(正文 djb2) / excerpt(前 400 字) / changed_at / fetched_at`，**没有正文字段**（有测试断言 `PRAGMA table_info(doc_snapshots)` 里不含 `text`）。

三条时间线对齐到同一张表 `requirement_drift(requirement_id, doc_version, doc_changed_at,
code_last_at, session_last_at, verdict, evidence)`：

| 判定 | 条件 | 含义 |
| --- | --- | --- |
| `doc-stale` | **文档最后更新之后，过程记录里出现了「变更语义」**（改成/新增/去掉/不需要/调整…） | ⚠ 变更很可能没回写文档；把原话贴出来当证据 |
| `work-since-doc` | 文档在前、开发在后，记录里没有变更语义 | **正常推进**（不是漂移） |
| `doc-newer` | 文档比代码/记录新（或同期） | 文档最近动过：可能补了变更，也可能改了计划，看一眼 |
| `silent` | 三条线都超过 N 天无动静 | 需求躺平（提醒，而不是报错） |
| `unknown` | 没有文档快照，或没有任何代码/记录 | 数据不足，先抓快照 |

> ⚠️ **口径修正（用户 2026-09-29 指出，第一版判错了）**：最初用「代码/记录比文档新 ⇒ 文档没跟上」——
> 这是**把因果关系搞反了**：正常流程就是「先有文档，再有开发」，代码比文档新是**健康态**。
> 现在的判据是**过程记录里有没有"文档之外的变更"**（`changeSignalsIn()` + `CHANGE_WORDS` 词表），
> 命中才叫 `doc-stale` 并把原话存进 `requirement_drift.signals`（schema v11）给评审的人看；
> 纯时间差只降级成 `work-since-doc`（正常）与 `doc-newer`（文档最近有更新）这两条提示。

**文档版本从哪来**：Confluence REST `/rest/api/content/<id>?expand=version,history`（§3.8 已在用同一通道，
带登录态经浏览器中继），取 `version.number` + `version.when` + `history.lastUpdated`。
非 Confluence（禅道/本地 md）退化为 `doc_title_at` + 正文 hash。

**正文快照**（建议同步做，成本很小）：新增 `doc_snapshots(requirement_id, url, hash, title,
excerpt, fetched_at)`，每次读文档存一版 `hash + 前 N 字`；这样"文档变了"能 diff 出**哪一段**变了，
而不是只知道"变过"。

**验收**：制造一次真实变更（改 Confluence 页面但不改台账）→ 24h 内该需求在面板上出现
`doc-stale` 标记且证据可点击；把文档补回去 → 标记消失。

### 9.4 方案 C｜一键「评审影响报告」（把 A+B 变成会上能用的东西）—— ✅ **P3 已实现**

> 实现状态（2026-09-29）：`lib/review.js`（相关性打分 / 文档缺口 / 问题模板 / Markdown 渲染，全是纯函数）+
> `store.buildReviewReport()` + `POST|GET /review-report` + 工具 **`ph_review`**（第 14 个）+ CLI `dsh-ph review <id>` +
> 面板卡片与详情里的「评审报告」按钮（生成后钉在顶部，可整份复制，也能直接当新会话提示词）。
> 报告固定五节：① 相关历史需求（带相关度与理由）② 潜在冲突点（**[强]/[中]/[弱]** + 出处）③ 建议会上问清楚的问题
> ④ 文档缺口检查（权限角色/边界异常/兼容/回滚灰度/接口定义/验收标准/数据迁移）⑤ 证据与边界。
> 相关性权重：同 Figma 稿 5 > 同代码模块 4/个 > 同后端设计文档 3 > 同项目同端 2 > 标题关键词 1；
> **只为排序，不当冲突概率**。证据不足时报告明写「证据不足，不代表无冲突」，不编造。
>
> 真机跑第一版时踩到一个**假警报**：文档缺口检查只看 400 字摘要，而正文后面对应的关键词（接口定义/权限/回滚）
> 全被判成"没写"。修法（schema v10）：抓快照时**对全文**算一遍关键词命中标记存进 `doc_snapshots.checks`，
> 报告优先用标记、没有标记才退化成扫摘要 —— 仍然**不存全文**。

`POST /project-hub/api/review-report {id}` → 渲染并返回报告（同时可作新会话提示词）：

1. **相关历史需求**：同模块（A）/ 同接口 / **同 Figma 文件** / 同页面 / 同端；每条给状态、代码落点、最近改动；
2. **潜在冲突点**：同一文件、同一接口、同一份 UI 稿、同一端 —— 按"证据强度"排序；
3. **建议在会上问的问题**（模板化，例：「这条改动与 `SPMS-6410` 改的是同一个列表页，是否共用同一份筛选逻辑？」）；
4. **文档缺口检查**：角色 / 边界 / 异常 / 兼容 / 回滚 是否写到；缺哪项就点哪项。

**很便宜的先手**（不依赖 A/B，已在 P0 实现）：**同一 Figma 文件被多条需求引用**就报警。
本机台账实测：2 条需求已引用 3 个 design id —— `figma.com/design/<fileKey>` 的 `fileKey` 直接可比，
同稿需求冲突概率极高。这条可以随时先做（半天）。

**验收**：拿一条历史需求当"新需求"喂进去，报告里应出现它真实冲突过的那条需求（人工回看得出的
冲突），并把冲突点定位到文件/接口/UI 稿级别；说不清的地方必须明确写"证据不足"，不许编。

### 9.5 方案 D｜变更待办（可选）—— ✅ **P4 已实现（schema v12，默认关闭）**

> 实现状态（2026-09-29）：`drift_todos` 表 + `syncDriftTodos()` + 面板「变更对账」里的待办区 + 工具 `ph_drift {action:"todos|enable-todos|sync-todos|close-todo"}`
> + CLI `dsh-ph drift todos [--sync] [--done <id>] | todo-enable | todo-disable` + 路由 `GET|POST /drift/todos`。
>
> 两条关键设计（都踩过坑后定下来的）：
> ① **默认关闭**：开关存在 `meta['drift.todoEnabled']`（配置 `driftTodo.enabled` 只作缺省），关着的时候
>    `syncDriftTodos()` 直接短路，不产生任何数据；启用后 `computeDrift()` 会顺手同步（幂等）。
> ② **签名 = 漂移期，不是"最新那条变更"**：一开始用 `日期|词` 做签名，同一漂移期再来一条变更就变成
>    **第二条待办**（实测踩到）。改成 `stale|<文档时间>|<文档版本>` —— 同一漂移期只有一条，
>    新变更只更新它的详情；同一需求下其它开放待办会被"并入"收敛，保证**一条需求同时只跟进一条**。
> ③ **闭环**：`syncDriftTodos()` 会**先重算**再同步（否则文档补上后读到的还是旧结论，关不掉——也实测踩到）；
>    不再判定为漂移的需求，其开放待办自动关闭并写明 `close_reason`「文档已更新/已不再判定为漂移」。

`doc-stale` 的需求生成待办（`mem_todo` 或禅道单，需显式开关）：标题「把 X 的这次变更补进文档」，
正文附证据链接（会话日期 + 提交 sha + 文档版本）。**默认关闭**，避免变成噪声源。

### 9.6 边界（明确不做什么）

- **不做"自动判定冲突"**：冲突是语义判断。插件给证据与线索，判定交给 agent/人
  （可以一键把「两份文档 + 代码落点」喂给 agent，让模型给结论）。
- **不抓取线下沟通**（钉钉/企微/口头）；但报告里会标「近 N 天无任何记录」，让"没记录"本身成为信号。
- **不引入向量库/嵌入检索**（先不做）：A 基于代码事实、可解释、可点开证据；文档级语义相似度
  可以作为后续增强（`doc_snapshots.excerpt` 已为它留了原料），但排序质量不稳定，不能作为第一版依据。
- **不改用户仓库**：只读 `git log`，不写、不 fetch（除非显式配置）。

### 9.7 分期与顺序

| 期 | 内容 | 依赖 | 预估 |
| --- | --- | --- | --- |
| P0 ✅ | **同 Figma 稿冲突提示**（§9.4 先手，已实现：`lib/link-index.js` + 卡片/详情/工具提示） | 无 | 半天 |
| P1 ✅ | 方案 A：`code_touches` 索引 + 覆盖率 + 需求显示代码落点（**已实现**） | 无 | 1–2 天 |
| P2 ✅ | 方案 B：`doc_snapshots` + `requirement_drift` 看板（第 4 个 tab「变更对账」，**已实现**） | A 的数据 | 1–2 天 |
| P3 ✅ | 方案 C：评审影响报告（HTTP + 工具 ph_review + CLI + 面板按钮，**已实现**） | A、B | 1–2 天 |
| P4 ✅ | 方案 D：漂移待办（**默认关闭**，已实现；同一漂移期一条、文档补上自动关闭） | B | 半天 |

**为什么这个顺序**：A 是 B/C 的地基（没有"代码事实"就没有可比对的第二条线）；
P0 不依赖任何东西且立刻能减少一类冲突，适合先落地验证"这个方向有用"。
