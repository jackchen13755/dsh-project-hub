# dsh-project-hub

> DeepSeek Harness 的**项目管理台账**插件：按需求 ID 存需求文档 / WBS / 后端设计文档 / 所属项目，
> 定期扫描 DSH 会话自动记下「哪天在开发哪个项目的哪个需求」，也能手动补录（例如当天解决的 bug），
> 然后按**项目 / 需求 / 日期**检索。事实源是一张 SQLite 库（做法对齐 `dsh-memory-core`）。

仓库：<https://github.com/jackchen13755/dsh-project-hub>（公开；**数据不出本机**，只存 `~/.dsh/project-hub/hub.db`）

## 它能做什么

| 能力 | 说明 |
| --- | --- |
| 需求台账 | 按需求 ID 一条记录：需求文档、WBS、后端设计文档、所属项目、状态、优先级、标签 |
| 自动读标题 | 保存需求文档时把文档标题读回来（本地 md 的 front-matter / `# H1`、网页的 `<title>` / `<h1>`） |
| 项目候选 | 项目从「当前工作区已有项目」里选：宿主工作区注册表 + 工作目录扫描 + 历史会话 cwd |
| 会话扫描 | 定期解压 `$DSH_HOME/sessions/**/session*.jsonl.zstd`（多帧 zstd），按天 × 项目 × 需求归集，落成开发记录 |
| 手动补录 | 「今天解决了 bug 55036」这类记录随手加，可关联需求、填耗时 |
| 检索 | 按项目 / 需求 / 日期区间 / 类型 / 关键词搜索，另有按天开发报表 |
| 归档 | 需求、开发记录、项目都能归档与恢复；默认列表只显示未归档（`archived=exclude\|only\|include`） |

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

## 面板（右侧边栏页签）

客户端半边（`lib/client.js`）在宿主右侧边栏注册一个页签 **项目管理**：
工具栏（搜索 + 项目下拉 + 日期区间 + 类型 + 「显示已归档」+ 扫描按钮 + 状态行）、需求台账卡片视图
（点开看该需求的开发记录与按天时间线）、开发日志视图、两个折叠表单（加需求 / 加记录）。
数据全部走下面的宿主路由，同源 fetch，零构建（手写 `window.__ModuleLoader__.load` CJS 信封）。

## Agent 工具面

| 工具 | 用途 |
| --- | --- |
| `ph_save_requirement` | 保存/更新需求（id/no/project/title/docUrl/wbsUrl/designUrl/status/tags） |
| `ph_get_requirement` | 读一条需求 + 它的开发记录 + 按天活动 |
| `ph_list_requirements` | 列需求（项目 / 关键词 / 状态 / 归档三态） |
| `ph_list_projects` | 列台账项目 + 候选项目（工作区 / 注册表 / 会话） |
| `ph_log_work` | 手动加一条开发记录（kind=dev/bug/doc/review/meeting/release/other） |
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
node bin/ph.js req save --no 5921 --project spms --doc https://… --wbs https://… --design https://…
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
`GET /requirements`、`GET /requirements/get`、`POST /requirements/save|/requirements/archive|/requirements/delete`、
`GET /logs`、`POST /logs/add|/logs/archive|/logs/delete`、`GET /search`、`GET /report`、
`POST /scan`、`POST /doc-title`、`GET /export`。完整字段见 `DESIGN.md` §6。

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

## 开发

```bash
node --test test/       # 测试（Node ≥ 22.19 / ≥ 24）
```

免构建：`lib/` 即源码（host ESM）+ 手写 CJS 信封的客户端面板。

## License

MIT
