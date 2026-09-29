/**
 * 需求文档标题读取（R4：保存需求文档时把标题一并读回来）。
 *
 * 支持三种来源：
 *   - 本地 Markdown/文本：YAML front-matter 的 `title:` → 首个 `# H1` → 文件名；
 *   - 本地 HTML：`<title>` → 首个 `<h1>`；
 *   - http(s)：抓正文前若干 KB（默认 256KB、12s 超时），`<title>` → 首个 `<h1>`。
 *
 * 返回里同时给 `title`（洗过的）与 `rawTitle`（原始），站点后缀只按**已知站点**剥离，
 * 不做通用 ` - ` 切分 —— 需求标题本身就常带破折号，切错了比不切更糟。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { fetchPage } from './page-fetch.js'

export const DEFAULT_TIMEOUT_MS = 12000
export const DEFAULT_MAX_BYTES = 256 * 1024

/** 已知站点后缀（`<title>需求名 - 禅道</title>` 这类）。 */
const SITE_SUFFIXES = [
  '禅道',
  'zentao',
  'confluence',
  'atlassian',
  '语雀',
  'yuque',
  '飞书',
  'lark',
  '腾讯文档',
  'docs.qq.com',
  '石墨文档',
  'shimo',
  '金山文档',
  'wps',
  'notion',
  'github',
  'gitlab',
  'gitee',
  'showdoc',
  'apifox',
  'mastergo',
  'figma',
  'processon',
  'xmind',
  'wiki',
]

export function isUrl(ref) {
  return /^https?:\/\//i.test(String(ref ?? '').trim())
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
}

export function stripTags(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
}

function collapse(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 只剥离**已知站点**的尾缀；其余原样保留。 */
export function stripSiteSuffix(title) {
  let out = collapse(title)
  for (let i = 0; i < 2; i += 1) {
    const m = out.match(/^(.*\S)\s*[-–—_|·:：]\s*([^-–—_|·:：]{1,24})$/)
    if (!m) break
    const tail = m[2].toLowerCase().trim()
    if (!SITE_SUFFIXES.some((s) => tail === s || tail.endsWith(s))) break
    out = m[1].trim()
  }
  return out
}

export function titleFromHtml(html, fallback = null) {
  const raw = String(html ?? '')
  const t = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const h1 = raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  const candidates = [
    t ? { text: collapse(stripTags(t[1])), source: 'html-title' } : null,
    h1 ? { text: collapse(stripTags(h1[1])), source: 'html-h1' } : null,
  ].filter((c) => c && c.text)
  if (candidates.length === 0) return fallback ? { title: fallback, rawTitle: fallback, source: 'filename' } : null
  const picked = candidates[0]
  return { title: stripSiteSuffix(picked.text) || picked.text, rawTitle: picked.text, source: picked.source }
}

export function titleFromText(text, fallback = null) {
  const body = String(text ?? '').replace(/^\uFEFF/, '')
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (fm) {
    const m = fm[1].match(/^\s*title\s*:\s*(.+)$/im)
    if (m) {
      const value = collapse(m[1].replace(/^["']|["']$/g, ''))
      if (value) return { title: value, rawTitle: value, source: 'markdown-frontmatter' }
    }
  }
  const h1 = body.match(/^\s{0,3}#\s+(.+)$/m)
  if (h1) {
    const value = collapse(h1[1].replace(/\s*#+\s*$/, ''))
    if (value) return { title: value, rawTitle: value, source: 'markdown-h1' }
  }
  const html = /<html|<!doctype html|<title|<h1/i.test(body)
  if (html) {
    const fromHtml = titleFromHtml(body, fallback)
    if (fromHtml) return fromHtml
  }
  return fallback ? { title: fallback, rawTitle: fallback, source: 'filename' } : null
}

function fallbackName(path) {
  const base = basename(String(path))
  const ext = extname(base)
  return ext ? base.slice(0, -ext.length) : base
}

async function fetchLimited(url, { fetchImpl, timeoutMs, maxBytes }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
    })
    const status = res.status
    if (!res.ok) return { status, ok: false, text: '' }
    // 有界读取：别把几 MB 的页面整个吞进内存
    let text = ''
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader()
      const chunks = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value?.length ?? 0
        chunks.push(Buffer.from(value))
        if (total >= maxBytes) {
          try {
            await reader.cancel()
          } catch {
            /* 忽略 */
          }
          break
        }
      }
      text = Buffer.concat(chunks).toString('utf8')
    } else {
      text = String(await res.text()).slice(0, maxBytes)
    }
    return { status, ok: true, text }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 读标题。
 *
 * URL 的取页顺序（**默认走带登录态的链路**，与禅道插件同款）：
 *   浏览器中继（自动带 Cookie）→ cookie jar → 裸 fetch；拿到登录页时如实报 `needsLogin`，
 *   绝不把「登录」当标题存下来。测试可以注入 `fetchImpl`（裸 HTTP 桩）或 `fetchText`
 *   （自定义取页器）来替换整条链路。
 *
 * @param {string} ref 文档 URL / 本地路径
 * @returns {Promise<{ ok:boolean, title:string|null, rawTitle?:string|null, source:string, ref:string,
 *   status?:number, strategy?:string, needsLogin?:boolean, error?:string }>}
 */
export async function resolveDocTitle(ref, opts = {}) {
  const {
    fetchImpl = null,
    fetchText = null,
    env = process.env,
    timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES,
  } = opts
  const target = String(ref ?? '').trim()
  if (!target) return { ok: false, title: null, source: 'empty', ref: target, error: '空的文档地址' }

  if (isUrl(target)) {
    let fetched
    if (typeof fetchText === 'function') {
      fetched = await fetchText(target)
    } else if (typeof fetchImpl === 'function') {
      // 注入了 fetch 桩（测试路径）：只做裸请求，不碰中继/jar
      try {
        const res = await fetchLimited(target, { fetchImpl, timeoutMs, maxBytes })
        fetched = res.ok
          ? { ok: true, text: res.text, status: res.status, strategy: 'injected' }
          : { ok: false, text: '', status: res.status, strategy: 'injected', error: `HTTP ${res.status}` }
      } catch (error) {
        fetched = { ok: false, text: '', strategy: 'injected', error: error?.message ?? String(error) }
      }
    } else {
      fetched = await fetchPage(target, { env, timeoutMs, maxBytes })
    }

    if (!fetched.ok) {
      return {
        ok: false,
        title: null,
        source: fetched.needsLogin ? 'needs-login' : fetched.status ? 'http-error' : 'fetch-failed',
        ref: target,
        status: fetched.status,
        strategy: fetched.strategy,
        needsLogin: Boolean(fetched.needsLogin),
        staleJar: Boolean(fetched.staleJar),
        hops: fetched.hops ?? 0,
        bridge: fetched.bridge ?? null,
        jar: fetched.jar ?? null,
        error: fetched.error ?? '取页失败',
      }
    }
    const parsed = titleFromText(fetched.text, null) ?? titleFromHtml(fetched.text, null)
    if (!parsed) {
      return { ok: false, title: null, source: 'no-title', ref: target, status: fetched.status, strategy: fetched.strategy, error: '页面里没有 title/h1' }
    }
    return {
      ok: true,
      ...parsed,
      ref: target,
      status: fetched.status,
      strategy: fetched.strategy,
      /** 是否走了带登录态的通道（面板/工具据此提示「标题是登录态页面里读的」） */
      viaSession: fetched.strategy === 'bridge' || fetched.strategy === 'cookie-jar',
    }
  }

  const path = target.startsWith('file://') ? decodeURIComponent(target.slice('file://'.length)) : target
  if (!existsSync(path)) return { ok: false, title: null, source: 'missing', ref: target, error: `本地文件不存在：${path}` }
  try {
    const size = statSync(path).size
    const buf = readFileSync(path)
    const text = buf.subarray(0, Math.min(size, maxBytes)).toString('utf8')
    const parsed = titleFromText(text, fallbackName(path))
    if (!parsed) return { ok: false, title: null, source: 'no-title', ref: target, error: '文件里没有可识别的标题' }
    return { ok: true, ...parsed, ref: target, strategy: 'local' }
  } catch (error) {
    return { ok: false, title: null, source: 'read-failed', ref: target, error: error?.message ?? String(error) }
  }
}
