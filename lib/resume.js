/**
 * 「上次做到哪」——按需求号把散落的状态聚合出来，供 `ph_brief` 的续做段使用。
 *
 * 为什么按需求号：**分支名里已经嵌了需求号**（`feature/20260713-some-feature-5802` → 5802），
 * 这是现成的 join key。实测本机账本里约两成 taskBrief 也带需求号。
 *
 * 三路数据：
 *   ① git 分支（按需求号匹配）——是否已 checkout、领先/落后主干多少、最后一条提交
 *   ② completion-ledger —— taskBrief 含该需求号的账本里「没证据且没标 done/dropped」的条目
 *   ③ （开发记录由 brief.js 自己渲染，这里不重复）
 *
 * 两条铁律：
 *   - **fail-soft**：目录不存在、不是 git 仓库、git 超时，一律降级为空，绝不让 ph_brief 报错
 *   - **没数据就不出段**：首次做的需求不能出现一个空段落污染提示词
 *
 * @module project-hub/resume
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { readdirSync, readFileSync, statSync } from 'node:fs'

const execFileAsync = promisify(execFile)

/** 犯了太多次的教训：异常一律吞掉返回 null，调用方据此降级。 */
async function git(cwd, args, timeoutMs = 8000) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    })
    return { ok: true, out: String(stdout).trim() }
  } catch {
    return { ok: false }
  }
}

/**
 * 需求号匹配（用户确认的三种形态）：
 *   - 分支名末尾的数字段：`...-5802`
 *   - 账本文本里的 `需求 6051` / `需求6051` / `需求 #6051`
 *   - 账本文本里的 `Bug 55992` / `#55992`
 * 统一转成小写比较，返回纯数字串。
 */
export function numbersInText(text) {
  const found = new Set()
  const source = String(text ?? '')
  // 前置分隔符要包含 `/`：`backup/6031-premerge` 这种分支名里 6031 前面是斜杠
  for (const m of source.matchAll(/[-\s/]([0-9]{3,6})\b/g)) found.add(m[1])
  for (const m of source.matchAll(/(?:需求|bug|缺陷)\s*#?\s*([0-9]{3,6})/gi)) found.add(m[1])
  for (const m of source.matchAll(/#([0-9]{3,6})\b/g)) found.add(m[1])
  return found
}

/** 分支名是否对应这个需求号：以 `-<no>` 结尾，或独立出现 `<no>` 段。 */
function branchMatches(branch, no) {
  if (!no) return false
  // 结尾数字段是最常见的写法（feature/YYYYMMDD-slug-5802）
  if (new RegExp(`-${no}$`).test(branch)) return true
  // 也认 backup/6031-premerge-20260930 这种把号放中间的
  return new RegExp(`(^|[/-])${no}([/-]|$)`).test(branch)
}

/**
 * 主干判定。**不能盲信 origin/HEAD，也不能只试 master**。
 *
 * 实测两个坑：
 *  - 某个仓库的 `master` 停在很早以前的 Initial commit（几乎空）；
 *  - 同一个仓库的 `origin/HEAD` 指向 `origin/main`，而 `origin/main` 也停在那次 Initial commit，
 *    真正活跃的是 `origin/develop` / `origin/master`。
 * 拿错的基准会算出「领先主干几千个提交」这种失真数字。
 *
 * 所以策略是：在常见集成分支候选里，**挑最后提交时间最新的那个**。
 */
async function mainlineOf(root) {
  const candidates = ['origin/develop', 'origin/master', 'origin/main', 'develop', 'master', 'main']
  let best = null
  for (const name of candidates) {
    const verify = await git(root, ['rev-parse', '--verify', name])
    if (!verify.ok) continue
    const when = await git(root, ['log', '-1', '--format=%ct', name])
    const ts = Number.parseInt(when.out || '0', 10) || 0
    if (ts <= 0) continue
    // 同一时间戳时，远端优先（本地分支常常落后）
    if (!best || ts > best.ts) best = { name, ts }
  }
  return best ? best.name : null
}

/**
 * 查一个目录里与该需求号相关的分支状态。
 * @returns {Promise<Array<{branch:string,current:boolean,ahead:number|null,behind:number|null,lastCommit:string}>>}
 */
export async function relatedBranches(root, no) {
  if (!root || !no || !existsSync(root)) return []
  const inside = await git(root, ['rev-parse', '--show-toplevel'])
  if (!inside.ok) return []

  const list = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  if (!list.ok) return []
  const branches = list.out.split('\n').map((s) => s.trim()).filter(Boolean)
  const matched = branches.filter((b) => branchMatches(b, no))
  if (matched.length === 0) return []

  const current = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const currentName = current.ok ? current.out : ''
  const mainline = await mainlineOf(root)

  const out = []
  for (const branch of matched.slice(0, 6)) {
    let ahead = null
    let behind = null
    if (mainline) {
      const count = await git(root, ['rev-list', '--left-right', '--count', `${mainline}...${branch}`])
      if (count.ok) {
        const [b, a] = count.out.split(/\s+/).map((n) => Number.parseInt(n, 10))
        if (Number.isFinite(a)) ahead = a
        if (Number.isFinite(b)) behind = b
      }
    }
    const last = await git(root, ['log', '-1', '--format=%h|%ad|%s', '--date=short', branch])
    out.push({
      branch,
      current: branch === currentName,
      ahead,
      behind,
      lastCommit: last.ok ? last.out : '',
    })
  }
  // 排序：当前 checkout 最前 → 工作分支（feature/fix/hotfix）→ 备份/其它
  const rank = (b) => {
    if (b.current) return 0
    if (/^(feature|featrue|fix|feat)\//i.test(b.branch)) return 1
    if (/^(hotfix|merge)\//i.test(b.branch)) return 2
    if (/^(backup|uatfix|release)\//i.test(b.branch)) return 3
    return 4
  }
  out.sort((a, b) => rank(a) - rank(b))
  return out
}

/** 账本条目「收了」的判定：有证据，或状态显式 done/dropped。与 orch 的探测器口径保持一致。 */
export function openItemsOf(ledger) {
  return (ledger.items ?? []).filter((item) => {
    const hasEvidence = Array.isArray(item.evidence) && item.evidence.length > 0
    const closed = item.status === 'done' || item.status === 'dropped'
    return !hasEvidence && !closed
  })
}

/**
 * 在账本里找与需求号相关、且有未收口条的账本。
 * 性能：只读最近 `lookbackDays` 内更新过的文件（按 mtime 先筛，再解析）。
 */
export function relatedLedgers(no, { lookbackDays = 30, limit = 5 } = {}) {
  if (!no) return []
  const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'completion-ledger')
  if (!existsSync(dir)) return []
  const cutoff = Date.now() - lookbackDays * 86400000
  let files = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const out = []
  for (const name of files) {
    const full = join(dir, name)
    let mtime = 0
    try {
      mtime = statSync(full).mtimeMs
    } catch {
      continue
    }
    if (mtime < cutoff) continue
    let ledger
    try {
      ledger = JSON.parse(readFileSync(full, 'utf8'))
    } catch {
      continue
    }
    const brief = String(ledger.taskBrief ?? '')
    if (!numbersInText(brief).has(no) && !numbersInText(String(ledger.id ?? '')).has(no)) continue
    const open = openItemsOf(ledger)
    if (open.length === 0) continue
    out.push({
      sessionId: String(ledger.sessionId ?? name.replace(/\.json$/, '')),
      taskBrief: brief.slice(0, 120),
      updatedAt: ledger.updatedAt ?? 0,
      open,
      total: (ledger.items ?? []).length,
    })
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out.slice(0, limit)
}

/**
 * 聚合「上次做到哪」。**没数据返回 null**，调用方据此不渲染该段。
 *
 * @param {object} p
 * @param {string} p.requirementNo 需求号（纯数字串）
 * @param {string|null} p.root     项目工作目录
 * @param {number} [p.lookbackDays] 账本回溯天数
 * @returns {Promise<null|{lines:string[], hasResume:boolean}>}
 */
export async function collectResume({ requirementNo, root, lookbackDays = 30 } = {}) {
  const no = String(requirementNo ?? '').replace(/[^0-9A-Za-z]/g, '')
  if (!no) return null

  const branches = await relatedBranches(root, no)
  const ledgers = relatedLedgers(no, { lookbackDays })
  if (branches.length === 0 && ledgers.length === 0) return null

  const lines = []

  if (branches.length > 0) {
    lines.push(`- 关联分支：`)
    for (const b of branches) {
      const bits = []
      if (b.current) bits.push('**当前已 checkout**')
      if (/^(backup|release|uatfix)\//i.test(b.branch)) bits.push('备份/发布分支，通常不是续做目标')
      if (b.ahead !== null) bits.push(`领先主干 ${b.ahead} 个提交`)
      if (b.behind !== null && b.behind > 0) bits.push(`落后 ${b.behind} 个`)
      const last = b.lastCommit ? b.lastCommit.split('|') : []
      const lastText = last.length >= 3 ? `最后提交 ${last[0]}（${last[1]}）${last[2]}` : ''
      lines.push(`  - \`${b.branch}\`${bits.length ? `　${bits.join('，')}` : ''}${lastText ? `　${lastText}` : ''}`)
    }
    if (branches.length > 1) {
      lines.push('  - 多个分支命中该需求号：确认这次续做的是哪一个，别开新的。')
    }
  }

  if (ledgers.length > 0) {
    const openTotal = ledgers.reduce((sum, l) => sum + l.open.length, 0)
    lines.push(`- 未收口：**${openTotal} 项**（来自 ${ledgers.length} 份账本，最近一次 ${formatDate(ledgers[0].updatedAt)}）`)
    for (const ledger of ledgers) {
      lines.push(`  - 会话 ${ledger.sessionId.slice(0, 8)}｜${ledger.taskBrief || '(无简报)'}`)
      for (const item of ledger.open.slice(0, 6)) {
        const text = String(item.text ?? '').slice(0, 160)
        lines.push(`    - [${item.id}] ${text}${item.status ? `（状态 ${item.status}）` : ''}`)
      }
      if (ledger.open.length > 6) lines.push(`    - …还有 ${ledger.open.length - 6} 项`)
    }
    lines.push('- **续做时先逐条确认上面的未收口项**：能收的收掉并给证据，该丢的说明为什么，不要重新从零开始做。')
  }

  return { lines, hasResume: lines.length > 0 }
}

function formatDate(ms) {
  if (!ms) return '未知'
  try {
    return new Date(ms).toISOString().slice(0, 10)
  } catch {
    return '未知'
  }
}

/**
 * 给 brief 调用方用的一步到位入口：自己解析需求号与项目 root，再聚合。
 *
 * 调用方（工具 / HTTP 路由）只需 `await resumeForBrief(store, id)`，不用重复实现
 * 「从 requirement_projects 找主项目再取 root」这套逻辑。
 *
 * @returns {Promise<null|{lines:string[], hasResume:boolean}>} 没数据返回 null
 */
export async function resumeForBrief(store, idOrNo, { project = null, lookbackDays = 30 } = {}) {
  let row = null
  try {
    row = store.getRequirement(idOrNo, project ? { project } : undefined)
  } catch {
    return null
  }
  if (!row) return null

  // 需求号：优先 no 列，否则从需求 id 尾巴取数字（与 branch.js 的 requirementNumber 同口径）
  let no = String(row.no ?? '').trim().replace(/[^0-9A-Za-z]/g, '')
  if (!no) {
    const tail = String(row.id ?? '').match(/(\d{2,8})\s*$/)
    no = tail ? tail[1] : ''
  }
  if (!no) return null

  // 项目 root：传入 project 优先，否则主项目（is_primary=1），否则第一个
  let root = null
  try {
    const wanted = project ? String(project) : null
    const rows = store.db
      .prepare(
        `SELECT p.root AS root, rp.is_primary AS isPrimary, p.name AS name, p.id AS id
           FROM requirement_projects rp JOIN projects p ON p.id = rp.project_id
          WHERE rp.requirement_id = ?
          ORDER BY rp.is_primary DESC, rp.sort ASC`,
      )
      .all(row.id)
    const picked = wanted
      ? rows.find((r) => String(r.id).toLowerCase() === wanted.toLowerCase() || String(r.name).toLowerCase() === wanted.toLowerCase())
      : null
    root = (picked ?? rows[0])?.root ?? null
  } catch {
    return null
  }

  try {
    return await collectResume({ requirementNo: no, root, lookbackDays })
  } catch {
    return null // fail-soft：聚合失败绝不影响 brief 本身
  }
}
