/**
 * P1：把「需求号 → 改了哪些文件」从 git 历史里索引出来（DESIGN.md §9.2）。
 *
 * 为什么这一步最关键：冲突发生在**实现**里，而需求文档之间永远比不出冲突。
 * 代码是唯一不会说谎的那条线 —— 谁在什么时候动过哪些文件，git 里写得明明白白。
 *
 * 只读：`git log` 而已，不 fetch、不 write、不改用户仓库。
 * 唯一的输入约束是**提交信息/分支名里要带需求号**，所以扫描结果里必须暴露「带号覆盖率」。
 */
import { execFileSync } from 'node:child_process'

/** 默认回溯窗口（天）。太大扫得慢，太小漏历史。 */
export const DEFAULT_SINCE_DAYS = 365
/** 单次扫描最多解析多少提交（防止首次扫大仓库卡住）。 */
export const DEFAULT_MAX_COMMITS = 4000
/** 超过这个长度的路径不进索引（多半是构建产物/资源文件）。 */
const MAX_PATH = 260
/** 这些路径不进索引：不是人写的代码。 */
const IGNORE_PATH = /(^|\/)(node_modules|dist|build|\.next|coverage|\.dev\/.*\/dist)\//i

/**
 * 从提交主题 / 分支名里抽需求号。本机两个仓库实测的写法都覆盖：
 *   `feat(bill-log): … （#5829）`、`fix(5823+5824): 跑case…`、`feat: 5693 lf 搜索日期范围调整`、
 *   `feature/20260922-log-lock-5829`、`【5922】L&F Q3 …`
 * 注意：本团队需求号是 4–6 位且都 ≥5000，所以把 1900–2099 的 4 位数当成年份排除是安全的。
 */
export function extractNosFromText(text) {
  const src = String(text ?? '')
  const out = new Set()
  const push = (value) => {
    const n = String(value)
    if (!/^\d{3,6}$/.test(n)) return
    if (n.length === 4 && Number(n) >= 1900 && Number(n) <= 2099) return // 年份，不是需求号
    out.add(n)
  }
  for (const m of src.matchAll(/[#＃](\d{3,6})\b/g)) push(m[1])
  for (const m of src.matchAll(/[【\[](\d{3,6})[】\]]/g)) push(m[1])
  for (const m of src.matchAll(/[（(](\d{3,6})[)）]/g)) push(m[1])
  // 分支名/标签式：log-lock-5829、room-queue-5626、spms-p2p3 这种不长这样（p2p3 不是纯数字段）
  for (const m of src.matchAll(/[-_/]([5-9]\d{3})\b/g)) push(m[1])
  // 裸号：`feat: 5693 lf …`、`5823+5824`
  for (const m of src.matchAll(/(?:^|[\s:：,，+(（])([5-9]\d{3})(?=[\s+，,、)）:：]|$)/g)) push(m[1])
  return [...out]
}

/**
 * 从**分支名**里取需求号：只认**结尾**的 4–6 位数字段。
 *
 * 本机实测（spms，近 365 天）：
 *   · 非 merge 提交 5288 个，提交信息里带号的只有 **20 个（0.4%）** —— 提交纪律不靠 message；
 *   · 需求号写在**分支名**上：`feature/20260922-log-lock-5829`、`uatfix/20260922-payment-method-55716`；
 *   · 分支名里还有 8 位日期（`20260922`）。用宽松的 `[0-9]{4,5}` 会把它切成 `20260` 这种假号
 *     （实测踩到），所以这里**锚定结尾**：日期是 8 位，永远不可能出现在结尾的 `[-_/](\d{4,6})$`。
 */
export function branchRequirementNo(text) {
  const src = String(text ?? '')
  const matches = [...src.matchAll(/[-_/]([0-9]{4,6})(?![0-9])/g)]
  if (matches.length === 0) return null
  const tail = matches[matches.length - 1][1]
  if (tail.length === 4 && Number(tail) >= 1900 && Number(tail) <= 2099) return null // 年份
  // `YYYYMM`（如 feature/202606-cycle）也是日期戳，不是需求号 —— 实测踩到，会造出假号 202606
  if (tail.length === 6 && /^(19|20)\d{2}(0[1-9]|1[0-2])$/.test(tail)) return null
  // `HHMMSS` 时间戳：实测 `Merge tag 'tags/uf-20260922-173930-zhangju'` 里的 173930 被当成了需求号
  if (tail.length === 6 && /^([01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]$/.test(tail)) return null
  // 本团队的需求号都是 5xxx / 6xxx / 55xxx 这种（首位 5–9）；其它首位多半是日期片段/序号
  if (!/^[5-9]/.test(tail)) return null
  return tail
}

/**
 * 文件路径 → 模块：**去掉文件名**后取前 3 段目录。
 * `src/queue/list.tsx` → `src/queue`（不是 `src/queue/list.tsx`：文件名不该进模块名）；
 * 根目录下的文件（没有目录）退化成文件名本身。
 */
export function moduleOf(path) {
  const parts = String(path ?? '')
    .split('/')
    .filter(Boolean)
  if (parts.length === 0) return ''
  const dirs = parts.slice(0, -1)
  if (dirs.length === 0) return parts[0]
  return dirs.slice(0, 3).join('/')
}

/** 一个提交值不值得进索引。 */
export function usefulPath(path) {
  const p = String(path ?? '')
  if (!p || p.length > MAX_PATH) return false
  if (IGNORE_PATH.test(`/${p}`)) return false
  return true
}

/** 单次「特性合并」最多认多少文件（超过就当成发布线同步，不做文件归属）。 */
export const MAX_LANDING_FILES = 400

/** 跑一次 `git log`（只读）。返回 null 表示这个目录不是 git 仓库。 */
export function readGitLog(root, { sinceDays = DEFAULT_SINCE_DAYS, maxCommits = DEFAULT_MAX_COMMITS, exec = execFileSync } = {}) {
  const args = [
    '-C',
    String(root),
    'log',
    '--no-merges',
    `--since=${Number(sinceDays)} days ago`,
    '--date=short',
    `--max-count=${Number(maxCommits)}`,
    '--pretty=format:\u0001%H|%ad|%s|%D',
    '--name-only',
  ]
  try {
    return exec('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/**
 * 「特性合并」采集：对每个**合并提交**，用 `git diff <merge>^1 <merge>` 取出它落地时带进来的文件。
 *
 * 为什么不用 `merge-base + origin/main`：实测那会把整条发布线算进来（3000–4000 个文件），
 * 而归属于"这个需求改了哪些文件"毫无意义；反过来 `merge^1..merge` 实测是 3–23 个文件（真正的特性改动集）。
 * 113/120 个合并都属这种落地合并，剩下 ~6% 是 `release-wl`/`uatfix` 这类发布线同步 → 按体积（>400 文件）跳过。
 */
export function readMergeLandings(root, { sinceDays = DEFAULT_SINCE_DAYS, maxMerges = 500, maxFiles = MAX_LANDING_FILES, exec = execFileSync } = {}) {
  let list = ''
  try {
    list = exec(
      'git',
      ['-C', String(root), 'log', '--merges', `--since=${Number(sinceDays)} days ago`, '--date=short', `--max-count=${Number(maxMerges)}`, '--pretty=format:%H|%ad|%s'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    )
  } catch {
    return { ok: false, landings: [], skippedHuge: 0, withoutNo: 0 }
  }
  const landings = []
  let skippedHuge = 0
  let withoutNo = 0
  for (const line of String(list).split('\n')) {
    const [sha, date, subject] = line.split('|')
    if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha.trim())) continue
    const no = branchRequirementNo(subject)
    if (!no) {
      withoutNo += 1
      continue
    }
    let files = []
    try {
      files = exec('git', ['-C', String(root), 'diff', '--name-only', `${sha}^1`, sha], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n')
        .map((line) => line.trim())
        .filter(usefulPath)
    } catch {
      continue
    }
    if (files.length > maxFiles) {
      skippedHuge += 1
      continue
    }
    landings.push({ sha: sha.trim(), date: date ?? null, subject: subject ?? '', no, files })
  }
  return { ok: true, landings, skippedHuge, withoutNo }
}

/** 当前 HEAD（增量判断用；拿不到就 null）。 */
export function gitHead(root, { exec = execFileSync } = {}) {
  try {
    return exec('git', ['-C', String(root), 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/**
 * 解析 `git log` 输出（`\u0001` 分隔每个提交，第二行起是文件清单）。
 * @returns {{ commits: Array<{sha, date, subject, refs, files, nos}>, numbered:number, head:null }}
 */
export function parseGitLog(raw) {
  const commits = []
  let numbered = 0
  for (const block of String(raw ?? '').split('\u0001')) {
    const lines = block.split('\n').filter((line) => line.trim() !== '')
    if (lines.length === 0) continue
    const [sha, date, subject, refs] = lines[0].split('|')
    if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha.trim())) continue
    const files = lines.slice(1).map((line) => line.trim()).filter(usefulPath)
    const nos = extractNosFromText(`${subject ?? ''} ${refs ?? ''}`)
    if (nos.length > 0) numbered += 1
    commits.push({ sha: sha.trim(), date: date ?? null, subject: subject ?? '', refs: refs ?? '', files, nos })
  }
  return { commits, numbered }
}

/**
 * 扫描一个仓库 → 汇总成落库用的结构。
 * @returns {{ ok:boolean, error?:string, head:string|null, commits:number, numbered:number, coverage:number,
 *   touches: Array<{requirementId,path,module,commits,firstSeen,lastSeen,sample}>,
 *   recent: Array<{path,module,commits,lastSeen,sample}> }}
 */
export function scanGitRepo(root, options = {}) {
  const raw = readGitLog(root, options)
  if (raw === null) return { ok: false, error: '不是 git 仓库或 git 不可用', commits: 0, numbered: 0, coverage: 0, touches: [], recent: [], head: null }
  const { commits, numbered } = parseGitLog(raw)
  // 特性合并（需求号在分支名上）—— 本仓库里这是需求号的主要来源
  const mergePass = readMergeLandings(root, options)
  const touches = new Map() // `${no}|${path}` → row
  const recent = new Map() // path → row
  for (const commit of commits) {
    for (const path of commit.files) {
      if (!recent.has(path)) recent.set(path, { path, module: moduleOf(path), commits: 0, lastSeen: commit.date, sample: commit.subject })
      const rec = recent.get(path)
      rec.commits += 1
      if ((commit.date ?? '') > (rec.lastSeen ?? '')) rec.lastSeen = commit.date
      for (const no of commit.nos) {
        const key = `${no}|${path}`
        if (!touches.has(key)) touches.set(key, { requirementId: no, path, module: moduleOf(path), commits: 0, firstSeen: commit.date, lastSeen: commit.date, sample: commit.subject })
        const row = touches.get(key)
        row.commits += 1
        if ((commit.date ?? '') < (row.firstSeen ?? '9999')) row.firstSeen = commit.date
        if ((commit.date ?? '') > (row.lastSeen ?? '')) row.lastSeen = commit.date
      }
    }
  }
  // 把「特性合并」的改动集并进同一套索引：一个合并 = 一次提交量级的归属
  for (const landing of mergePass.landings ?? []) {
    for (const path of landing.files) {
      if (!recent.has(path)) recent.set(path, { path, module: moduleOf(path), commits: 0, lastSeen: landing.date, sample: landing.subject })
      const rec = recent.get(path)
      rec.commits += 1
      if ((landing.date ?? '') > (rec.lastSeen ?? '')) rec.lastSeen = landing.date
      const key = `${landing.no}|${path}`
      if (!touches.has(key)) {
        touches.set(key, { requirementId: landing.no, path, module: moduleOf(path), commits: 0, firstSeen: landing.date, lastSeen: landing.date, sample: landing.subject, source: 'merge' })
      }
      const row = touches.get(key)
      row.commits += 1
      // 合并的样本更可读（带需求名），优先留它
      if (landing.subject && (!row.sample || row.source !== 'merge')) row.sample = landing.subject
      if ((landing.date ?? '') < (row.firstSeen ?? '9999')) row.firstSeen = landing.date
      if ((landing.date ?? '') > (row.lastSeen ?? '')) row.lastSeen = landing.date
    }
  }
  const landings = mergePass.landings?.length ?? 0
  const totalSignals = numbered + landings
  return {
    ok: true,
    head: options.head ?? null,
    commits: commits.length,
    numbered,
    coverage: commits.length === 0 ? 0 : Number((numbered / commits.length).toFixed(4)),
    /** 特性合并（分支名带号）——本仓库里需求号的主要来源 */
    merges: mergePass.ok ? mergePass.landings.length + (mergePass.skippedHuge ?? 0) + (mergePass.withoutNo ?? 0) : 0,
    mergeNumbered: landings,
    skippedHugeMerges: mergePass.skippedHuge ?? 0,
    /** 两种信号合计（提交信息 + 分支名） */
    signals: totalSignals,
    touches: [...touches.values()],
    recent: [...recent.values()],
  }
}

/** 需求号 → 模块聚合（面板/工具一行一条，比逐文件好读）。 */
export function groupTouchesByModule(touches, { limit = 8 } = {}) {
  const byModule = new Map()
  for (const row of touches ?? []) {
    // ⚠️ 入库行是 snake_case（last_seen/first_seen），内存里的行是驼峰 —— 两种都认，
    //    否则聚合出来 lastSeen 会是 undefined（实测踩到：接口返回里字段凭空消失）。
    const lastSeen = row.lastSeen ?? row.last_seen ?? null
    const key = row.module ?? moduleOf(row.path)
    if (!byModule.has(key)) byModule.set(key, { module: key, files: 0, commits: 0, lastSeen, sample: row.sample })
    const item = byModule.get(key)
    item.files += 1
    item.commits += Number(row.commits ?? 0)
    if ((lastSeen ?? '') > (item.lastSeen ?? '')) item.lastSeen = lastSeen
    if (!item.sample && row.sample) item.sample = row.sample
  }
  return [...byModule.values()].sort((a, b) => b.commits - a.commits || (b.lastSeen > a.lastSeen ? 1 : -1)).slice(0, limit)
}
