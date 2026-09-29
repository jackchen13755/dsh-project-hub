#!/usr/bin/env node
/**
 * `dsh-ph` —— project-hub 台账的命令行入口。
 *
 * 与插件共用同一个 SQLite（`$DSH_HOME/project-hub/hub.db`），所以终端里做的事和面板里看到的一致。
 * 无浏览器验证（以及脚本化补录）全靠它。
 */
import { Store } from '../lib/store.js'
import { resolveDocTitle } from '../lib/doc-title.js'
import { dbPath } from '../lib/paths.js'

const argv = process.argv.slice(2)

function parseArgs(list) {
  const flags = {}
  const positional = []
  for (let i = 0; i < list.length; i += 1) {
    const token = list[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = list[i + 1]
      const value = next === undefined || next.startsWith('--') ? true : next
      if (next !== undefined && !next.startsWith('--')) i += 1
      // 同一个 flag 出现多次 → 收集成数组（`--link doc=A --link ui=B`）
      if (flags[key] === undefined) flags[key] = value
      else if (Array.isArray(flags[key])) flags[key].push(value)
      else flags[key] = [flags[key], value]
    } else positional.push(token)
  }
  return { flags, positional }
}

/** `--link kind=url`（或 `--link url`，默认 doc）→ [{kind,url}]。 */
function parseLinkFlags(value) {
  const list = value === undefined ? [] : Array.isArray(value) ? value : [value]
  return list
    .map((entry) => {
      const text = String(entry)
      const eq = text.indexOf('=')
      if (eq === -1) return { kind: 'doc', url: text }
      return { kind: text.slice(0, eq).trim(), url: text.slice(eq + 1).trim() }
    })
    .filter((link) => link.url)
}

const { flags, positional } = parseArgs(argv)
const cmd = positional[0] ?? 'status'
const sub = positional[1]

const opened = Store.open({ tz: process.env.PH_TZ ?? 'Asia/Shanghai' }, process.env)
if (!opened.store) {
  console.error(`台账库打不开：${opened.error}`)
  process.exit(1)
}
const store = opened.store

function out(value, text) {
  if (flags.json) console.log(JSON.stringify(value, null, 2))
  else console.log(text)
}

const n = (v, d) => (v === undefined ? d : Number(v))

async function main() {
  if (cmd === 'status') {
    const s = store.status({ version: 'cli' })
    return out(
      s,
      [
        `台账库：${dbPath()}`,
        `计数：项目 ${s.counts.projects} / 需求 ${s.counts.requirements}（归档 ${s.counts.archivedRequirements}）/ 记录 ${s.counts.workLogs}（归档 ${s.counts.archivedLogs}）`,
        `活动行 ${s.counts.activity} / 已扫会话 ${s.counts.scannedSessions} / 有记录的天数 ${s.counts.activeDays}`,
        `上次扫描：${s.lastScanAt ? new Date(s.lastScanAt).toLocaleString('zh-CN') : '（从未）'}`,
      ].join('\n'),
    )
  }

  if (cmd === 'scan') {
    const res = await store.scanSessions({ dryRun: flags['dry-run'] === true, limit: n(flags.limit, 400) })
    return out(
      res.sessions ? { ...res, days: res.days } : res,
      [
        `会话文件 ${res.files} 个 → 实扫 ${res.changed}，跳过 ${res.skipped}${flags['dry-run'] ? '（dry-run）' : ''}`,
        `写入活动 ${res.activities} 条 / 开发记录 ${res.logs} 条；覆盖 ${res.days.length} 天：${res.days.join(', ')}`,
        res.errors.length ? `错误 ${res.errors.length}：${res.errors.slice(0, 3).map((e) => e.error).join(' | ')}` : '',
        ...res.sessions.slice(0, 25).map((s) => `  · ${s.cwd ?? '?'} → ${s.projectId ?? '?'}  ${s.msgs} 条  ${s.days.join(' ')}  「${s.title ?? ''}」`),
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }

  if (cmd === 'projects') {
    const list = store.listProjects({ cwd: flags.cwd ?? process.cwd() })
    const cands = store.candidateProjects(flags.cwd ?? process.cwd())
    return out(
      { projects: list, candidates: cands },
      [
        `台账项目 ${list.length} 个：`,
        ...list.map((p) => `  · ${p.name}（${p.id}）需求 ${p.requirementCount ?? 0} 条${p.lastWorkedDate ? ` / 最近 ${p.lastWorkedDate}` : ''}${p.root ? `  ${p.root}` : ''}`),
        `候选（含工作区/注册表/会话缓存）${cands.length} 个：`,
        ...cands.slice(0, 25).map((c) => `  · ${c.name}（${c.id}）[${c.source}]${c.root ? `  ${c.root}` : ''}`),
      ].join('\n'),
    )
  }

  if (cmd === 'req') {
    if (sub === 'save') {
      const res = await store.saveRequirement({
        id: typeof flags.id === 'string' ? flags.id : undefined,
        no: typeof flags.no === 'string' ? flags.no : undefined,
        project: typeof flags.project === 'string' ? flags.project : flags.cwd ?? process.cwd(),
        title: typeof flags.title === 'string' ? flags.title : undefined,
        docUrl: typeof flags.doc === 'string' ? flags.doc : undefined,
        wbsUrl: typeof flags.wbs === 'string' ? flags.wbs : undefined,
        wbsNote: typeof flags['wbs-note'] === 'string' ? flags['wbs-note'] : undefined,
        designUrl: typeof flags.design === 'string' ? flags.design : undefined,
        designNote: typeof flags['design-note'] === 'string' ? flags['design-note'] : undefined,
        uiUrl: typeof flags.ui === 'string' ? flags.ui : undefined,
        uiNote: typeof flags['ui-note'] === 'string' ? flags['ui-note'] : undefined,
        links: parseLinkFlags(flags.link),
        replaceLinks: flags['replace-links'] === true,
        status: typeof flags.status === 'string' ? flags.status : undefined,
        priority: typeof flags.priority === 'string' ? flags.priority : undefined,
        tags: typeof flags.tags === 'string' ? flags.tags.split(',') : undefined,
        readTitle: flags['no-title-read'] !== true,
      })
      const r = res.requirement
      return out(
        res,
        `${res.created ? '已新建' : '已更新'}需求 ${r.id}${r.title ? ` · ${r.title}` : ''}（项目 ${r.projectName ?? r.projectId}，状态 ${r.status}）` +
          `\n链接 ${(r.links ?? []).length} 条：` +
          (r.links ?? []).map((l) => `\n  · [${l.kindLabel}] ${l.url}${l.title ? `  《${l.title}》` : ''}${l.note ? `（${l.note}）` : ''}`).join('') +
          (res.titleRead && !res.titleRead.ok ? `\n（标题未读到：${res.titleRead.error}）` : ''),
      )
    }
    if (sub === 'get') {
      const id = positional[2]
      const row = store.getRequirement(id, { project: flags.project })
      if (!row) {
        console.error(`没找到需求 ${id}`)
        process.exit(2)
      }
      const req = store.attachLinksOne(store.requirementDetail(row.id))
      const logs = store.listLogs({ requirement: row.id, archived: 'include', limit: 50 })
      const days = store.timeline({ requirement: row.id, limit: 30 })
      return out(
        { requirement: req, logs: logs.items, days },
        [
          `${req.id}${req.title ? ` · ${req.title}` : ''}`,
          `项目 ${req.projectName ?? req.projectId} / 状态 ${req.status}${req.archivedAt ? ' / 已归档' : ''}`,
          `链接 ${(req.links ?? []).length} 条：`,
          ...(req.links ?? []).map((l) => `  · [${l.kindLabel}] ${l.url}${l.title ? `  《${l.title}》` : ''}${l.note ? `（${l.note}）` : ''}`),
          `开发记录 ${logs.total} 条：`,
          ...logs.items.slice(0, 20).map((l) => `  ${l.date} [${l.kind}] ${l.title ?? ''}${l.source === 'session-scan' ? '（扫描）' : ''}`),
          `按天活动 ${days.length} 天：`,
          ...days.map((d) => `  ${d.date}  ${d.projects.map((p) => `${p.projectName ?? p.projectId}(${p.requirements.map((r) => `${r.id}×${r.msgs}`).join(',')})`).join(' ')}`),
        ]
          .filter(Boolean)
          .join('\n'),
      )
    }
    // 链接子命令：`req link add --id SPMS-5921 --kind ui --url …` / `list` / `remove --link-id N`
    if (sub === 'link') {
      const action = positional[2] ?? 'list'
      const id = typeof flags.id === 'string' ? flags.id : positional[3]
      const row = id ? store.getRequirement(id, { project: flags.project }) : null
      if (!row) {
        console.error(`没找到需求 ${id ?? '(缺少 --id)'}`)
        process.exit(2)
      }
      if (action === 'add') {
        if (typeof flags.url !== 'string') {
          console.error('add 需要 --url')
          process.exit(2)
        }
        let title = typeof flags.title === 'string' ? flags.title : null
        if (!title && (!flags.kind || String(flags.kind).toLowerCase() === 'doc') && flags['no-title-read'] !== true) {
          const res = await resolveDocTitle(flags.url)
          if (res.ok) title = res.title
        }
        const link = store.upsertLink(row.id, { kind: flags.kind ?? 'doc', url: flags.url, title, note: typeof flags.note === 'string' ? flags.note : null })
        store.syncPrimaryMirrors(row.id)
        return out({ link, links: store.listLinks(row.id) }, `已添加 [${link.kindLabel}] ${link.url}${link.title ? `  《${link.title}》` : ''}`)
      }
      if (action === 'remove') {
        const removed = store.removeLink({
          id: flags['link-id'] !== undefined ? Number(flags['link-id']) : null,
          requirementId: row.id,
          kind: typeof flags.kind === 'string' ? flags.kind : null,
          url: typeof flags.url === 'string' ? flags.url : null,
        })
        store.syncPrimaryMirrors(row.id)
        return out({ removed, links: store.listLinks(row.id) }, removed ? `已删除 ${removed} 条链接` : '没找到要删的链接（用 req link list 看 id）')
      }
      const links = store.listLinks(row.id)
      return out({ links }, [`${row.id} 的链接 ${links.length} 条：`, ...links.map((l) => `  #${l.id} [${l.kindLabel}] ${l.url}${l.title ? `  《${l.title}》` : ''}${l.note ? `（${l.note}）` : ''}`)].join('\n'))
    }
    if (sub === 'list' || sub === undefined) {
      const res = store.listRequirements({
        project: flags.project,
        q: flags.q,
        status: flags.status,
        archived: flags.archived ?? 'exclude',
        limit: n(flags.limit, 50),
      })
      return out(
        res,
        [`共 ${res.total} 条：`, ...res.items.map((r) => `  · ${r.id}${r.title ? ` · ${r.title}` : ''} [${r.projectName ?? r.projectId}/${r.status}]${r.archivedAt ? ' 已归档' : ''}${r.lastWorkDate ? ` 最近 ${r.lastWorkDate}` : ''}`)].join('\n'),
      )
    }
    if (sub === 'archive' || sub === 'restore') {
      const id = positional[2]
      const res = store.archiveRequirement(id, sub === 'archive')
      return out(res, res.changed ? `已${sub === 'archive' ? '归档' : '恢复'}需求 ${id}` : `没找到需求 ${id}`)
    }
    // 只改状态（卡片下拉 / 开新会话自动置「开发中」同款语义）
    if (sub === 'status') {
      const id = positional[2] ?? flags.id
      const next = flags.set ?? positional[3]
      if (!id || !next) {
        console.error('用法：dsh-ph req status <需求ID> --set developing（可用 draft/planning/developing/testing/released/paused/dropped）')
        return 2
      }
      const res2 = store.setRequirementStatus(id, next)
      if (!res2.ok) {
        console.error(res2.error)
        return 1
      }
      return out(res2, `需求 ${id} 状态 → ${res2.requirement.status}`)
    }

    // 彻底删除（不可恢复；归档视图里用得着）
    if (sub === 'delete') {
      const id = positional[2]
      const deleted = store.deleteRequirement(id)
      return out({ deleted }, deleted ? `已彻底删除需求 ${id}（不可恢复）` : `没找到需求 ${id}`)
    }
  }

  if (cmd === 'log') {
    if (sub === 'add') {
      const log = store.addLog({
        title: flags.title,
        date: flags.date,
        project: flags.project ?? flags.cwd ?? process.cwd(),
        requirement: flags.requirement,
        kind: flags.kind ?? 'dev',
        detail: flags.detail,
        minutes: flags.minutes !== undefined ? Number(flags.minutes) : undefined,
        source: 'manual',
      })
      return out(log, `已记录 #${log.id}：${log.date} [${log.kind}] ${log.title}（${log.projectName ?? log.projectId}${log.requirementId ? ` / ${log.requirementId}` : ''}）`)
    }
    // 编辑：`log update --id 1320 --title 新标题 --kind review ...`（只改传了的字段）
    if (sub === 'update' || sub === 'edit') {
      if (flags.id === undefined) {
        console.error('update 需要 --id')
        process.exit(2)
      }
      const updated = store.updateLog(Number(flags.id), {
        date: typeof flags.date === 'string' ? flags.date : undefined,
        project: typeof flags.project === 'string' ? flags.project : undefined,
        requirement: typeof flags.requirement === 'string' ? flags.requirement : undefined,
        kind: typeof flags.kind === 'string' ? flags.kind : undefined,
        title: typeof flags.title === 'string' ? flags.title : undefined,
        detail: typeof flags.detail === 'string' ? flags.detail : undefined,
        minutes: flags.minutes !== undefined ? Number(flags.minutes) : undefined,
      })
      if (!updated) {
        console.error(`没找到记录 #${flags.id}`)
        process.exit(2)
      }
      return out(updated, `已更新 #${updated.id}：${updated.date} [${updated.kind}] ${updated.title}（${updated.projectName ?? updated.projectId}${updated.requirementId ? ` / ${updated.requirementId}` : ''}）`)
    }
    if (sub === 'list' || sub === undefined) {
      const res = store.listLogs({
        project: flags.project,
        requirement: flags.requirement,
        from: flags.from,
        to: flags.to,
        kind: flags.kind,
        q: flags.q,
        archived: flags.archived ?? 'exclude',
        limit: n(flags.limit, 60),
      })
      return out(
        res,
        [`共 ${res.total} 条：`, ...res.items.map((l) => `  #${l.id} ${l.date} [${l.kind}] ${l.title ?? ''}${l.requirementId ? ` (${l.requirementId})` : ''} — ${l.projectName ?? l.projectId}${l.source === 'session-scan' ? '（扫描）' : ''}`)].join('\n'),
      )
    }
    if (sub === 'archive' || sub === 'restore') {
      const res = store.archiveLog(Number(positional[2]), sub === 'archive')
      return out(res, res.changed ? `已${sub === 'archive' ? '归档' : '恢复'}记录 #${positional[2]}` : `没找到记录 #${positional[2]}`)
    }
    if (sub === 'delete') {
      const deleted = store.deleteLog(Number(positional[2]))
      return out({ deleted }, deleted ? `已彻底删除记录 #${positional[2]}（不可恢复）` : `没找到记录 #${positional[2]}`)
    }
  }

  if (cmd === 'search') {
    const res = store.search({
      q: flags.q ?? positional[1] ?? null,
      project: flags.project,
      requirement: flags.requirement,
      from: flags.from,
      to: flags.to,
      kind: flags.kind,
      archived: flags.archived ?? 'exclude',
      limit: n(flags.limit, 40),
    })
    return out(
      res,
      [
        `需求 ${res.requirementTotal} 条 / 记录 ${res.logTotal} 条 / 有活动 ${res.days.length} 天`,
        '',
        ...res.requirements.map((r) => `[需求] ${r.id}${r.title ? ` · ${r.title}` : ''}  (${r.projectName ?? r.projectId})`),
        ...res.logs.slice(0, 30).map((l) => `[记录] ${l.date} [${l.kind}] ${l.title ?? ''}${l.requirementId ? ` (${l.requirementId})` : ''}`),
        ...res.days.map(
          (d) => `[活动] ${d.date} ${d.msgs} 条消息：${d.projects.map((p) => `${p.projectName ?? p.projectId}(${p.requirements.map((r) => `${r.id}×${r.msgs}`).join(',') || '无需求号'})`).join(' ')}`,
        ),
      ].join('\n'),
    )
  }

  if (cmd === 'report') {
    const res = store.report({ from: flags.from, to: flags.to, project: flags.project, limit: n(flags.limit, 30) })
    return out(
      res,
      [
        `${res.totals.days} 天 / ${res.totals.projectCount} 项目 / ${res.totals.requirementCount} 需求 / ${res.totals.logCount} 条记录`,
        '',
        ...res.days.flatMap((d) => [
          `${d.date}（${d.msgs} 条消息 / ${d.sessionCount} 会话 / ${d.logCount} 条记录）`,
          ...d.projects.map((p) => `    ${(p.projectName ?? p.projectId) || '未指定'}：${p.requirements.map((r) => `${r.id}${r.title ? `(${r.title})` : ''}×${r.msgs}`).join('、') || '（无需求号）'}`),
        ]),
      ].join('\n'),
    )
  }

  if (cmd === 'title') {
    const res = await resolveDocTitle(positional[1] ?? flags.url)
    return out(res, res.ok ? `${res.title}（${res.source}）` : `没读到：${res.error}`)
  }

  if (cmd === 'export') {
    const payload = {
      exportedAt: new Date().toISOString(),
      counts: store.counts(),
      projects: store.listProjects({ archived: 'include' }),
      requirements: store.listRequirements({ archived: 'include', limit: 1000 }).items,
      logs: store.listLogs({ archived: 'include', limit: 1000 }).items,
    }
    if (flags.json) return out(payload, '')
    return console.log(JSON.stringify(payload, null, 2))
  }

  console.error(`未知命令：${argv.join(' ')}\n用法见 README.md（status | scan | projects | req | log | search | report | title | export）`)
  process.exit(2)
}

main()
  .then((code) => {
    // 子命令可以直接 `return 1/2` 表达失败（退出码让脚本能判）
    if (typeof code === 'number' && code !== 0) process.exitCode = code
  })
  .catch((error) => {
    console.error(`执行失败：${error?.stack ?? error}`)
    process.exitCode = 1
  })
  .finally(() => store.close())
