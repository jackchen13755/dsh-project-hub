# dsh-project-hub

> DeepSeek Harness 的**项目管理台账**插件：按需求 ID 存需求文档 / WBS / 后端设计文档 / 所属项目，
> 定期扫描 DSH 会话自动记下「哪天在开发哪个项目的哪个需求」，也能手动补录（例如当天解决的 bug），
> 然后按**项目 / 需求 / 日期**检索。事实源是一张 SQLite 库（做法对齐 `dsh-memory-core`）。

仓库：<https://github.com/jackchen13755/dsh-project-hub>（公开；**数据不出本机**，只存 `~/.dsh/project-hub/hub.db`）

## 它能做什么

| 能力 | 说明 |
| --- | --- |
| 需求台账 | 按需求 ID 一条记录：需求文档、WBS、后端设计文档、**UI 设计链接**、所属项目、状态、优先级、标签 |
| 多项目 + 端 | 一条需求**可以在多个项目里开发**，每个项目自带「端」（PC / APP / Pad / 小程序 / H5 / 服务端）。卡片上的项目胶囊**点一下就选中**，详情里每个项目各有「开」按钮 |
| 开新会话 ×2 | 「**开新会话**」= 原来那条（只管读资料开工，不动 Git）；「**开新会话·拉分支**」= 提示词里多一段「开工前：从 master 拉新分支并切过去」，分支名 `feature/YYYYMMDD-需求名称英文-需求号`（英文名从标题里取拉丁字母段，纯中文标题退化成 `req`，格式不变）。详情里每个项目也各有「开 / 开·分支 / 复制」 |
| 复制提示词 | 卡片与详情里每个项目都有「复制」：**只把（按端裁剪过的）需求简报拷进剪贴板，不开新会话**，可粘到任意会话里；复制不可用时把正文显示出来 |
| 按端裁剪提示词 | 开新会话时按选中项目的端生成提示词：写死「本次只做 X 端」、**剔除属于其它端的资料**（`PC端` 的 Figma 稿不会进 APP 端的会话），并列出「另有 N 条属于 X 的资料本次不用看」 |
| 排序 | 需求列表默认**新到旧**（新建优先），可切「最近开发优先 / 最近更新优先」；开发记录本来新到旧 |
| 链接可多条 | UI / 需求 / WBS / 设计 **每类都能加多条**（Figma、MasterGo、蓝湖…都算 UI），每条带标题与备注、可单条删除 |
| 读文档信息 | 读需求文档时一并带出：**标题**、**需求号**（`【5922】…` 这种自动填号并拼出 `SPMS-5922`）、**谁创建的**、**谁是产品**（页面角色表 `产品：X`）、**角色表**（UI/前端/后端/QA…），以及**页面里的 UI 设计链接**（Figma/MasterGo/蓝湖，带 `PC端/APP端` 标签）——UI 链接在保存时自动并进需求的「UI 设计」 |
| 自动读标题 | 保存需求文档时把文档标题读回来（本地 md 的 front-matter / `# H1`、网页的 `<title>` / `<h1>`），文档类链接**逐条**读 |
| 带登录态取页 | 内部文档站（禅道/Confluence…）走**禅道插件同款策略链**：浏览器中继（自动带登录 Cookie）→ cookie jar → 裸 fetch，并会跟一跳「JS 跳转壳」（会话失效时禅道就返回这个）；拿到登录页时如实报「需要登录 / 会话已过期」，**绝不把「登录」当标题存下来**。cookie jar 可用 `~/.local/bin/zentao-export-cookies` 重新导出。**只要浏览器插件桥的守护进程在跑就会优先实测转发**（`/status` 的 running 标志不可靠，实测 running:false 时也能转发成功）|
| 项目候选 | 项目从「当前工作区已有项目」里选：宿主工作区注册表 + 工作目录扫描 + 历史会话 cwd |
| 会话扫描 | 定期解压 `$DSH_HOME/sessions/**/session*.jsonl.zstd`（多帧 zstd），按天 × 项目 × 需求归集，落成开发记录 |
| 手动补录 | 「今天解决了 bug 55036」这类记录随手加，可关联需求、填耗时 |
| 检索 | 按项目 / 需求 / 日期区间 / 类型 / 关键词搜索，另有按天开发报表 |
| 卡片改状态 | 卡片上的状态下拉**直接改**（走轻量的 `POST /requirements/status`，不动标题/链接/项目），颜色跟着状态走 |
| 开新会话置开发中 | 点「开新会话」时若状态不是「开发中」，**自动置为开发中**（先改状态再开会话：即便开会话失败，状态也是对的；已在开发中则不重复写） |
| 可编辑 | 需求（标题/状态/优先级/标签/全部链接）与开发记录（日期/项目/需求号/类型/标题/详情/耗时）都能改；改过的扫描记录不会被下次增量扫描覆盖 |
| 开新会话 | 需求卡片/详情的「开新会话」：自动把项目目录登记成宿主 workspace → 在该工作区新建会话 → 把**需求简报**（ID/标题/项目/状态 + 全部链接 + 最近开发记录 + 任务提示）作为首条消息发进去；任何一步失败都会把简报复制到剪贴板并说明原因 |
| 归档 | 需求、开发记录、项目都能归档与恢复；默认列表只显示未归档（`archived=exclude\|only\|include`） |
| 删除 | **归档视图里**才出现「删除」（两段确认：点一次变「确认删除？」再点才删）；删除是硬删不可恢复，删需求会连带删掉它的全部链接。工具面 `ph_archive {hard:true}`、CLI `req delete` / `log delete` 同款语义 |
| 标签 | 给需求打自由关键词（逗号分隔）；**工具栏可按标签筛**（选项带条数）、**点卡片/详情里的 `#标签` 即筛**、表单里点「常用」标签一键补全；筛选是**整词匹配**（`评审` 不会命中 `待评审`） |
| 历史需求发现 | 从**共享源**发现历史需求进「候选箱」（**不进台账**，采纳才进）：① Confluence 文档树（`ancestor=<根 pageId>` 分页 + 增量 `lastModified`，同事建的文档也能发现）② git 带号分支（零成本骨架）。打分把「与你在做的需求同模块」「近 90 天改过」排前面 |
| 变更待办 | 「文档可能没跟上」的需求可自动生成待办（**默认关闭**，需显式启用）：同一漂移期只跟进一条、文档补上后自动关闭；面板在「变更对账」里开关与标记完成，CLI `dsh-ph drift todos \| todo-enable` |
| 评审影响报告 | 一键生成：相关历史需求（同 Figma 稿/同代码模块/同项目同端/关键词）+ 潜在冲突点（[强]/[中]/[弱] 带出处）+ **建议在会上问清楚的问题** + 文档缺口检查；界面生成后可整份复制，也能直接当新会话提示词。工具 `ph_review`、CLI `dsh-ph review <id>` |
| 变更对账 | 第 4 个 tab：把「需求文档（意图）× 代码（git 事实）× 会话/记录（过程）」三条时间线对齐。**判据是记录里出现了文档之外的变更语义**（改成/新增/去掉…）才叫 `⚠ 文档可能没跟上`；「文档在前、开发在后」是**正常推进**（不是漂移）。抓快照**只存版本号 + 正文 hash + 摘要，不存全文** |
| 同稿冲突提示 | 两条需求引用**同一份 Figma 设计稿**（`figma.com/design/<fileKey>`）时，卡片和详情打 `⚠ 同稿 …` 标记并可跳过去 —— 改同一份稿 = 冲突概率高 |
| 需求↔代码索引 | 扫 `git log`（只读）建「需求号 → 模块/文件/次数/最近时间」索引。**实测本团队需求号主要写在分支名上**（提交信息带号率仅 0.4%），所以两条信号都收：提交信息写号的 + **特性合并**（`git diff <merge>^1 <merge>`，>400 文件的发布线同步跳过）。详情显示**代码落点**，扫描 tab 显示每个项目的带号覆盖率；CLI `dsh-ph code scan|touches|coverage|recent`。实测 spms → 204 需求/2116 行，hs_config → 38 需求/1585 行 |
| 项目配色 | 卡片与日志里的**项目胶囊按项目稳定配色**（同一项目永远同色、不同项目基本不同色），一眼区分 `spms` / `hs_config` / `s360-mobile`… |

## 安装

**方式一（推荐，热装配）**：用 dsh-super-injector

```bash
# 在 DSH 会话里让 agent 执行（dir 换成你 clone 下来的目录）：
dev_install_package { "dir": "<本插件目录>", "profile": "<你的 profile>" }
# 或只做运行时注入：
dev_inject_plugin { "dir": "<本插件目录>" }
```

**方式二（bundle，随 profile 启动）**：把本包加进 `~/.dsh/profiles/web/package.json` 的
`dependencies`（`link:` 指向本目录）与 `dsh.profile.bundles`，重启 DSH 生效
（`cordis.patch.yml` 已按同族插件写法提供 `insert` 行）。

## 数据与文件

- 台账库：`$DSH_HOME/project-hub/hub.db`（SQLite，WAL；`node:sqlite`，零外部依赖）
- 每日备份：`$DSH_HOME/project-hub/backups/hub-YYYYMMDD.db`（`VACUUM INTO`，保留 7 份）
- 会话日志来源：`$DSH_HOME/sessions/**`（只读）与 `$DSH_HOME/sessions-archive/**`（若存在）
- 表：`projects` / `requirements` / `work_logs` / `activity` / `scanned_sessions`（schema 见 `lib/schema.js`）

## 设计文档

- [DESIGN.md](DESIGN.md) §1–§8：已实现的形态（数据模型 / 扫描 / API / 工具面 / 面板）
- [DESIGN.md](DESIGN.md) **§9 需求冲突预判与变更对账（方案设计，未实现）**：解决「新需求评审时看不出与
  既有实现的冲突」与「需求变更没回写到文档」两个痛点 —— 需求↔代码影响索引、文档漂移三方对账、
  一键评审影响报告、变更待办，含数据模型、采集命令、验收口径与分期顺序。

## 面板（右侧边栏页签）

客户端半边（`lib/client.js`）在宿主右侧边栏注册一个页签 **项目管理**，内含**三个互相独立的 tab**：

| Tab | 内容 |
| --- | --- |
| **需求台账** | 只放需求：搜索 / 项目 / 归档筛选 + 需求卡片（各类链接可点多条、按类显示条数）+ 新建 / **编辑**需求（表单里四类链接各有「＋ 添加一条」，每行左侧 ↗ 可点开） |
| **开发日志** | 只放记录：日期区间 / 类型 / 项目筛选 + 记录列表（日期·类型·标题·需求·项目·耗时·来源）+ 新增 / **编辑** / 归档 |
| **会话扫描** | 只放扫描：上次扫描 / 周期 / 错误 / 会话文件·变更·跳过·活动·记录·天数 统计 + 「立即增量扫描」「预览（dryRun）」+ 按天活动报表（哪天开发了哪些项目的哪些需求，可一键跳到日志 tab 按那天过滤） |

链接展示克制：卡片每类只给**一颗可点胶囊**（点开该类第 1 条，多条显示条数），详情里逐条显示「类别 + 标题」——
不铺全量 URL，点标题即跳转，每条后跟 **⧉ 复制** 按钮（表单每一行也有 ⧉）。
数据全部走下面的宿主路由，同源 fetch，零构建（手写 `window.__ModuleLoader__.load` CJS 信封）。

## Agent 工具面

| 工具 | 用途 |
| --- | --- |
| `ph_save_requirement` | 保存/更新需求（id/no/project/title/docUrl/wbsUrl/designUrl/**uiUrl**/status/tags，**links 可多条**） |
| `ph_link` | 链接增删查：`add` / `remove` / `list`（doc 需求文档 · wbs · design 后端设计 · ui UI 设计，每类可多条） |
| `ph_brief` | 把一条需求渲染成可直接使用的**简报/提示词**（含全部链接与最近开发记录），面板「开新会话」用的就是同一份文本 |
| `ph_get_requirement` | 读一条需求 + 它的开发记录 + 按天活动 |
| `ph_list_requirements` | 列需求（项目 / 关键词 / 状态 / 归档三态） |
| `ph_list_projects` | 列台账项目 + 候选项目（工作区 / 注册表 / 会话） |
| `ph_log_work` | 新增**或编辑**一条开发记录（传 `id` 即编辑；kind=dev/bug/doc/review/meeting/release/other） |
| `ph_search` | 跨需求 / 记录 / 按天活动检索 |
| `ph_scan_sessions` | 扫描会话（**只做增量**：mtime+size 未变的会话跳过；`dryRun` 只报告） |
| `ph_report` | 开发报表（每天 × 项目 × 需求） |
| `ph_archive` | 归档 / 恢复需求、记录、项目 |
| `ph_doc_title` | 单独读一个文档的标题 |

## CLI（`dsh-ph`）

```bash
node bin/ph.js status                        # 台账概览
node bin/ph.js scan [--limit 300]            # 增量扫会话（没变过的会话自动跳过）
node bin/ph.js report [--from 2026-09-01 --to 2026-09-30] [--project spms]
node bin/ph.js search 看板 --project spms --from 2026-09-01
node bin/ph.js req save --no 5921 --project spms --title 房态看板 \
  --link doc=https://…需求文档 --link doc=https://…需求补充 \
  --link wbs=https://… --link design=https://… --link ui=https://figma… --link ui=https://mastergo…
node bin/ph.js req link add --id SPMS-5921 --kind ui --url https://lanhu.example/v2
node bin/ph.js req link list --id SPMS-5921
node bin/ph.js req link remove --id SPMS-5921 --link-id 7
node bin/ph.js req get SPMS-5921
node bin/ph.js req list --archived only
node bin/ph.js req archive SPMS-5921          # 恢复用 req restore
node bin/ph.js log add --title "修复 55036 分页越界" --kind bug --requirement 55036 --minutes 45
node bin/ph.js log list --from 2026-09-01 --kind bug
node bin/ph.js projects
node bin/ph.js title https://example.com/doc
```

加 `--json` 输出原始 JSON。

## HTTP 路由（面板/脚本用）

前缀 `/project-hub/api`：`GET /status`、`GET /projects`、`POST /projects/add|/projects/archive`、
`GET /requirements`、`GET /requirements/get`、`POST /requirements/save|/requirements/link/add|/requirements/link/remove|/requirements/archive|/requirements/delete`、
`GET /logs`、`POST /logs/add|/logs/archive|/logs/delete`、`GET /search`、`GET /report`、
`POST /scan`、`POST /doc-title`、`GET /brief`、`POST /open-session`、`GET /export`。完整字段见 `DESIGN.md` §6。

## 实现要点（踩过的坑）

1. **多帧 zstd**：会话日志是**逐帧追加**的 `session.v<N>.jsonl.zstd`，一次 `zstdDecompressSync` 只能拿到第一帧
   （本机 120 个 v3 会话会只剩表头）。本插件自带帧边界解析（`lib/session-scan.js`），逐帧解压。
2. **文件名要通配**：`session.jsonl.zstd`(v0) / `session.v3.jsonl.zstd` / `session.v4.jsonl.zstd` 三种都要匹配。
3. **cwd 只认明文**：项目来自会话首行的 `header.cwd`；目录名的 mangled 形态有损，只作兜底。
4. **扫描幂等**：`activity` 用替换语义、`work_logs` 靠部分唯一索引
   `(date, project_id, requirement_id, session_id) WHERE source='session-scan'`，重复扫描不会翻倍。
5. **需求 id 前缀自拼**：`<项目显示名大写>-<需求号>`（`spms` → `SPMS-5921`）。扫描时对未登记的需求也用同一公式生成临时 id，
   等真正保存该需求时 id 天然对齐，历史开发记录自动挂上去；用显示名（而非目录 slug）是为了让
   同产品的多个仓库（`work/spms` 与 `work/spms-ui/spms`）共用一条需求台账。
6. **定时器**：`ctx.effect` + 原生 `setInterval`（60s 心跳）+ `unref`，节拍用 DB 里的 `last_scan_at` 比对，
   重启不丢拍；**不能**直接 `ctx.setInterval`（未 inject `timer` 服务会抛，整条 entry 加载失败）。
7. **扫描只做增量**：水位是 `scanned_sessions.mtime+bytes`。activity 替换语义 + work_logs 部分唯一索引，
   保证「重扫同一会话不会翻倍」；提取规则改了要重新派生时用 schema 迁移清水位（v2 就是这么修 NaN 假 id 的）。
8. **链接是多条模型（v4）**：`requirement_links` 是事实源（`(requirement_id, kind, url)` 唯一），
   `requirements` 的旧列只是各类第一条的镜像，老接口/老面板不受影响；单值字段是「替换主链接」、
   `links + replaceLinks` 才是整份状态保存（面板就是这么用的）。
9. **迁移必须可重放**：SQLite 没有 `ALTER TABLE … ADD COLUMN IF NOT EXISTS`，所以 v4 写成
   `run(db)` 函数式迁移（先查 `PRAGMA table_info`）；把 `schema_version` 退回旧版再重开的场景下也不会炸。

## 开发

```bash
node --test test/       # 测试（Node ≥ 22.19 / ≥ 24）
```

免构建：`lib/` 即源码（host ESM）+ 手写 CJS 信封的客户端面板。

## License

MIT
