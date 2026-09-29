/**
 * 会话扫描（R5：定期扫描会话，记录哪天在开发哪些项目的哪些需求）。
 *
 * 会话日志格式（与 dsh 自身一致）：`$DSH_HOME/sessions/<mangled-cwd>/<session-id>/session.v<N>.jsonl.zstd`，
 * **多帧 zstd 追加** —— 一次 `zstdDecompressSync` 只能拿到第一帧，必须按帧边界逐帧解压
 * （帧头/块头解析见 RFC 8878 摘要；算法与 dsh-memory-core/lib/session-log.js 同源，
 * 这里有界重写并额外保留 `time`/`seq`，用于按天归集）。
 *
 * 事件形状（实测）：
 *   `{type:'session', id, createdAt, cwd, agentPreset, …}`            ← 第 1 条，**明文 cwd = 项目**
 *   `{type:'user/message'|'assistant/message', seq, time, data:{…}}`  ← `time` 是 epoch ms = 哪天
 *   `{type:'session/title', data:{title}}`                            ← 会话标题（LLM 生成）
 *   `{type:'tool/call'|'tool/result', …}`                             ← 只用于统计工具调用次数
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { dateInTz } from './paths.js'
import { decodeMangledCwd } from './projects.js'

const ZSTD_MAGIC = 0xfd2fb528
const SESSION_FILE_RE = /^session(\.v\d+)?\.jsonl\.zstd$/

/** 切出缓冲区里所有 zstd 帧（返回 [start, end) 区间）；遇到不认识的字节就停，坏文件不死循环。 */
export function frameRanges(buf) {
  const ranges = []
  let off = 0
  while (off + 4 <= buf.length) {
    if (buf.readUInt32LE(off) !== ZSTD_MAGIC) break
    const start = off
    off += 4
    const descriptor = buf.readUInt8(off)
    off += 1
    const fcsFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictFlag = descriptor & 3
    if (!singleSegment) off += 1
    off += dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4
    const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
    off += fcsSize
    for (;;) {
      if (off + 3 > buf.length) return ranges
      const header = buf.readUIntLE(off, 3)
      off += 3
      const last = header & 1
      const type = (header >> 1) & 3
      const size = header >> 3
      if (type === 1) off += 1
      else if (type === 2 || type === 0) off += size
      else return ranges
      if (last) break
    }
    if (checksum) off += 4
    if (off > buf.length) return ranges
    ranges.push([start, off])
  }
  return ranges
}

/** 逐帧解压；坏帧跳过（宽容）。 */
export function decompressMultiFrame(buf, { maxFrames = 200000 } = {}) {
  const ranges = frameRanges(buf)
  const parts = []
  let failed = 0
  for (const [start, end] of ranges.slice(0, maxFrames)) {
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)))
    } catch {
      failed += 1
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: ranges.length, failed }
}

/** 递归找出所有会话日志文件（有界）。 */
export function findSessionFiles(roots, { limit = 2000, maxDepth = 4 } = {}) {
  const out = []
  const walk = (dir, depth) => {
    if (out.length >= limit || depth > maxDepth) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit) return
      const full = join(dir, entry.name)
      if (entry.isFile() && SESSION_FILE_RE.test(entry.name)) {
        try {
          const st = statSync(full)
          // 会话 id 取**会话目录名**（`session-<uuid>` 或裸 uuid）；文件名叫 `session.v4.jsonl.zstd`
          // 这类固定串，拿它当 id 会让多个会话在 scanned_sessions 里互相覆盖。
          out.push({ file: full, sessionDir: dir, sessionId: dir.split('/').filter(Boolean).pop() ?? entry.name, mtime: st.mtimeMs, bytes: st.size })
        } catch {
          /* 忽略读不到的文件 */
        }
        continue
      }
      if (entry.isDirectory()) walk(full, depth + 1)
    }
  }
  for (const root of roots) {
    if (root && existsSync(root)) walk(root, 0)
  }
  return out
}

/** 从事件里取「给人看的文本」（只取 text 段，reasoning 不进）。 */
export function textOfMessage(type, data) {
  const raw = type === 'assistant/message' ? data?.message : data
  if (!raw || typeof raw !== 'object') return ''
  if (typeof raw.content === 'string') return raw.content
  if (Array.isArray(raw.content)) {
    return raw.content
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n')
  }
  return ''
}

/** 系统注入块不算「人在开发」。 */
export function isNoise(text) {
  const t = String(text ?? '').trimStart()
  return (
    t.startsWith('<system-reminder>') ||
    t.startsWith('【记忆（dsh-memory-core）】') ||
    t.startsWith('Current runtime context') ||
    t.startsWith('【本轮相关记忆') ||
    t.startsWith('<command-')
  )
}

/** 技术词前缀（`node-22`、`sha1-8` 这类不是需求号）。 */
const STOP_PREFIXES = new Set([
  'v', 'utf', 'sha', 'sha1', 'sha256', 'md5', 'base64', 'es', 'ecma', 'ipv', 'ipv4', 'ipv6', 'http', 'https', 'http2',
  'node', 'npm', 'pnpm', 'yarn', 'ts', 'tsx', 'js', 'jsx', 'css', 'html', 'json', 'yaml', 'toml', 'md', 'cjs', 'esm',
  'api', 'ui', 'ux', 'db', 'sql', 'id', 'no', 'pr', 'issue', 'port', 'p', 'step', 'phase', 'stage', 'v1', 'v2', 'v3',
  'iso', 'rfc', 'px', 'rem', 'em', 'ms', 'kb', 'mb', 'gb', 'tb', 'cpu', 'gpu', 'os', 'mac', 'win', 'ios', 'android',
])

const STRONG_PATTERNS = [
  { re: /【\s*(\d{2,6})\s*】/g, kind: null },
  { re: /(?:bug|缺陷|故障)\s*(?:id|no|号)?\s*[-_#:：]?\s*(\d{3,6})(?!\d)/gi, kind: 'bug' },
  { re: /(?:req|需求|story|任务|task)\s*(?:id|no|号)?\s*[-_#:：]?\s*(\d{2,6})(?!\d)/gi, kind: 'dev' },
  { re: /单号\s*[-_#:：]?\s*(\d{2,6})(?!\d)/g, kind: 'dev' },
]

const WEAK_PATTERNS = [
  { re: /#\s*(\d{3,6})(?!\d)/g, kind: 'dev', prefix: null, group: 1 },
  { re: /(?:^|[^A-Za-z0-9])([A-Za-z]{2,8})[-_](\d{3,6})(?!\d)/g, kind: 'dev', prefix: '$1', group: 2 },
]

/**
 * 从文本里抽需求号。
 * @returns {Map<string, { digits:string, kind:'bug'|'dev', hits:number, strong:boolean }>}
 */
export function extractRequirementTokens(text, { minDigits = 3 } = {}) {
  const found = new Map()
  const body = String(text ?? '')
  if (!body) return found
  const bump = (digits, kind, strong) => {
    if (!digits || digits.length < minDigits) {
      // 显式前缀的数字要求可以短一些，但不能是 1 位
      if (!(strong && digits && digits.length >= 2)) return
    }
    const key = String(Number(digits)) // 去前导零（009753 → 9753）
    const prev = found.get(key)
    if (prev) {
      prev.hits += 1
      prev.strong = prev.strong || strong
      if (kind === 'bug') prev.kind = 'bug'
      return
    }
    found.set(key, { digits: key, kind: kind ?? 'dev', hits: 1, strong })
  }
  for (const p of STRONG_PATTERNS) {
    p.re.lastIndex = 0
    for (const m of body.matchAll(p.re)) bump(m[1], p.kind, true)
  }
  for (const p of WEAK_PATTERNS) {
    p.re.lastIndex = 0
    for (const m of body.matchAll(p.re)) {
      if (p.prefix === '$1') {
        const prefix = String(m[1] ?? '').toLowerCase()
        if (STOP_PREFIXES.has(prefix)) continue
      }
      // ⚠️ 取号必须按 group 索引：前缀式模式里 m[1] 是字母前缀、m[2] 才是数字
      //（曾把 "SPMS" 当号 → Number("SPMS") = NaN → 需求 id 变成 `SPMS-NaN`）
      bump(m[p.group ?? 1], p.kind, false)
    }
  }
  return found
}

function compact(text, max = 220) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * 解析单个会话日志 → 按天 + 按需求归集的摘要（纯函数，不落库）。
 *
 * @param {string} file
 * @param {{ tz?:string, minDigits?:number, maxBytes?:number, maxFrames?:number, weakMinHits?:number, knownNos?:Set<string>, sampleChars?:number }} [opts]
 */
export function summarizeSession(file, opts = {}) {
  const {
    tz = 'Asia/Shanghai',
    minDigits = 3,
    maxBytes = 160 * 1024 * 1024,
    maxFrames = 200000,
    weakMinHits = 2,
    knownNos = new Set(),
    sampleChars = 220,
  } = opts
  const st = statSync(file)
  let buf = readFileSync(file)
  if (buf.length > maxBytes) buf = buf.subarray(buf.length - maxBytes)

  const { text, frames, failed } = decompressMultiFrame(buf, { maxFrames })
  const events = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* 半截行（追加写入）忽略 */
    }
  }

  const header = events.find((e) => e.type === 'session') ?? null
  const titles = events.filter((e) => e.type === 'session/title').map((e) => e.data?.title).filter((t) => typeof t === 'string' && t.trim())
  const dirName = file.split('/').slice(-2, -1)[0] ?? ''
  const cwd = header?.cwd ?? decodeMangledCwd(dirName)
  const sessionId = header?.id ?? dirName

  const days = new Map()
  let msgs = 0
  let toolCalls = 0
  let firstTime = null
  let lastTime = null
  let firstUserSample = null

  const dayOf = (ms) => {
    const date = dateInTz(ms ?? header?.createdAt ?? st.mtimeMs, tz)
    if (!days.has(date)) {
      days.set(date, { date, msgs: 0, toolCalls: 0, firstTime: null, lastTime: null, sample: null, reqs: new Map() })
    }
    return days.get(date)
  }

  for (const e of events) {
    const t = Number(e.time) || null
    if (t) {
      firstTime = firstTime === null ? t : Math.min(firstTime, t)
      lastTime = lastTime === null ? t : Math.max(lastTime, t)
    }
    if (e.type === 'tool/call') {
      toolCalls += 1
      const d = dayOf(t)
      d.toolCalls += 1
      d.firstTime = d.firstTime === null ? t : Math.min(d.firstTime, t ?? d.firstTime)
      d.lastTime = d.lastTime === null ? t : Math.max(d.lastTime, t ?? d.lastTime)
      continue
    }
    if (e.type !== 'user/message' && e.type !== 'assistant/message') continue
    if (e.data?.source?.kind === 'plugin') continue
    const raw = textOfMessage(e.type, e.data)
    if (!raw || isNoise(raw)) continue
    msgs += 1
    const d = dayOf(t)
    d.msgs += 1
    d.firstTime = d.firstTime === null ? t : Math.min(d.firstTime, t ?? d.firstTime)
    d.lastTime = d.lastTime === null ? t : Math.max(d.lastTime, t ?? d.lastTime)
    const snippet = compact(raw, sampleChars)
    if (!d.sample) d.sample = snippet
    if (e.type === 'user/message' && !firstUserSample) firstUserSample = compact(raw, sampleChars)
    for (const token of extractRequirementTokens(raw, { minDigits }).values()) {
      const prev = d.reqs.get(token.digits)
      if (prev) {
        prev.hits += token.hits
        prev.strong = prev.strong || token.strong
        if (token.kind === 'bug') prev.kind = 'bug'
        if (e.type === 'user/message' && !prev.sample) prev.sample = snippet
      } else {
        d.reqs.set(token.digits, { ...token, sample: e.type === 'user/message' ? snippet : null, lastTime: t })
      }
      const row = d.reqs.get(token.digits)
      row.lastTime = t ?? row.lastTime
    }
  }

  // 弱信号过滤：强前缀/【】留着；弱信号要「至少出现 2 次」或「库里已有这个需求号」
  const dayList = [...days.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((d) => ({
      date: d.date,
      msgs: d.msgs,
      toolCalls: d.toolCalls,
      firstTime: d.firstTime,
      lastTime: d.lastTime,
      sample: d.sample,
      requirements: [...d.reqs.values()]
        .filter((r) => r.strong || r.hits >= weakMinHits || knownNos.has(r.digits))
        .sort((a, b) => b.hits - a.hits)
        .map((r) => ({
          digits: r.digits,
          kind: r.kind,
          hits: r.hits,
          strong: Boolean(r.strong),
          sample: r.sample ?? d.sample ?? null,
          lastTime: r.lastTime ?? d.lastTime ?? null,
        })),
    }))
    .filter((d) => d.msgs > 0 || d.requirements.length > 0)

  return {
    sessionId,
    path: file,
    cwd,
    createdAt: header?.createdAt ?? null,
    agentPreset: header?.agentPreset ?? null,
    title: titles[titles.length - 1] ?? titles[0] ?? firstUserSample ?? null,
    events: events.length,
    msgs,
    toolCalls,
    frames,
    failedFrames: failed,
    firstTime,
    lastTime,
    mtime: st.mtimeMs,
    bytes: st.size,
    days: dayList,
  }
}
