/**
 * 取页（带登录态）—— 照搬 dsh-zentao-workbench 的策略链，因为内部文档站（禅道 / Confluence…）
 * 直接 fetch 只会拿到**登录页**，读回来的标题就成了「登录」。
 *
 * 策略顺序（与禅道插件一致，全部能力探测、失败逐级降级）：
 *   ① **bridge**  —— 本机浏览器中继（dsh-fetch-page 的守护进程 `127.0.0.1:9317`）：
 *      `POST /forward` 把请求交给用户真实浏览器执行，扩展自动带上登录 Cookie；
 *   ② **cookie-jar** —— Netscape 格式的 Chrome 导出 jar（禅道插件默认路径 + 本插件可配路径），
 *      按 host 取 Cookie 头自己发请求（不需要扩展，但会话 Cookie 会过期）；
 *   ③ **plain** —— 裸 fetch（公开页面足够；内部站点会落到登录页，会被识别出来）。
 *
 * 判定「登录页」是这条链路的收口：拿到登录页时**不写标题**，而是如实报 `needsLogin`，
 * 免得把「登录」两个字当需求标题存进台账。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 与 dsh-zentao-workbench / dsh-fetch-page 保持一致的中继地址。 */
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:9317'
export const DEFAULT_TIMEOUT_MS = 12000
export const DEFAULT_MAX_BYTES = 256 * 1024

export function bridgeUrlOf(env = process.env) {
  return env.DSH_BRIDGE_URL ?? env.DAEMON_URL ?? DEFAULT_BRIDGE_URL
}

/** 可能存着导出的 Chrome cookie jar 的地方（禅道插件同款 + 本插件专用）。 */
export function defaultJarPaths(env = process.env) {
  const paths = []
  if (env.DSH_COOKIE_JAR) paths.push(env.DSH_COOKIE_JAR)
  paths.push(join(homedir(), '.config', 'zentao', 'cookies.txt'))
  paths.push(join(homedir(), '.dsh', 'storages', 'dsh-zentao-workbench', 'cookies.txt'))
  return paths
}

/**
 * 解析 Netscape cookie jar 里匹配某 host 的 cookie。
 * 只看 domain 是否后缀匹配 + 是否已过期（`0` = 会话 cookie，仍在浏览器里活着）。
 */
export function parseJarCookies(text, host, now = Date.now()) {
  const want = String(host ?? '').toLowerCase().replace(/^\./, '')
  const out = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split('\t')
    if (parts.length < 7) continue
    const [domain, , , secure, expires, name, value] = parts
    const dom = String(domain).toLowerCase().replace(/^\./, '')
    if (want && dom && !(want === dom || want.endsWith(`.${dom}`))) continue
    const exp = Number(expires)
    if (Number.isFinite(exp) && exp > 0 && exp * 1000 < now) continue // 过期
    if (!name) continue
    out.push({ domain: dom, name, value, secure: secure === 'TRUE' })
  }
  return out
}

/** 找一份可用的 jar 并拼出 Cookie 头；找不到返回 null。 */
export function cookieHeaderFor(url, { env = process.env, paths = null, now = Date.now() } = {}) {
  return jarLookup(url, { env, paths, now }).hit
}

/**
 * jar 查找的完整结果：除了命中项，还回传**扫过的 jar 里都有哪些 host**。
 * host 对不上是最常见的静默失败 —— 说清「jar 里只有 zen.example.com」比「没有可用的 jar」有用得多。
 */
export function jarLookup(url, { env = process.env, paths = null, now = Date.now() } = {}) {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return { hit: null, host: '', scanned: [] }
  }
  const scanned = []
  for (const path of paths ?? defaultJarPaths(env)) {
    if (!path || !existsSync(path)) continue
    let text = ''
    let mtimeMs = 0
    try {
      text = readFileSync(path, 'utf8')
      mtimeMs = statSync(path).mtimeMs
    } catch {
      continue
    }
    const hosts = [
      ...new Set(
        text
          .split(/\r?\n/)
          .filter((line) => line && !line.startsWith('#'))
          .map((line) => line.split('\t')[0])
          .filter(Boolean),
      ),
    ]
    const cookies = parseJarCookies(text, host, now)
    scanned.push({ path, hosts, matched: cookies.length, mtimeMs })
    if (cookies.length === 0) continue
    return {
      host,
      scanned,
      hit: {
        path,
        mtimeMs,
        count: cookies.length,
        names: cookies.map((c) => c.name),
        /** @type {string} */
        header: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      },
    }
  }
  return { hit: null, host, scanned }
}

/** 没命中时给一句人看得懂的原因（含 jar 里有那些 host）。 */
export function jarMissReason(lookup) {
  if (!lookup || lookup.hit) return null
  const withHosts = (lookup.scanned ?? []).filter((item) => item.hosts?.length)
  if (withHosts.length === 0) return '没找到可用的 cookie jar'
  const detail = withHosts.map((item) => `${item.hosts.join('/')}`).join('；')
  return `jar 里没有 ${lookup.host} 的 Cookie（现存的 jar 只有：${detail}）`
}

async function readBounded(res, maxBytes) {
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
    return Buffer.concat(chunks).toString('utf8')
  }
  return String(await res.text()).slice(0, maxBytes)
}

/** 中继守护进程状态（`{ok, running, pid}`；扩展没连着时 running=false）。 */
export async function bridgeStatus({ bridgeUrl = bridgeUrlOf(), fetchImpl = globalThis.fetch, timeoutMs = 2500 } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, running: false, pid: null, error: '当前环境没有 fetch' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const res = await fetchImpl(`${bridgeUrl}/status`, { signal: controller.signal })
    const text = await res.text()
    let doc = null
    try {
      doc = JSON.parse(text)
    } catch {
      doc = null
    }
    if (!doc) return { ok: false, running: false, pid: null, error: `中继 /status 返回非 JSON：${text.slice(0, 120)}` }
    return { ok: true, running: Boolean(doc.running), pid: doc.pid ?? null, error: doc.error }
  } catch (error) {
    return { ok: false, running: false, pid: null, error: error?.message ?? String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** 经浏览器中继取页（自动带登录 Cookie）。 */
export async function fetchViaBridge(url, opts = {}) {
  const {
    bridgeUrl = bridgeUrlOf(),
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    mode = 'fetch',
    format = 'html',
    maxBytes = DEFAULT_MAX_BYTES,
  } = opts
  if (typeof fetchImpl !== 'function') return { ok: false, error: '当前环境没有 fetch' }
  const seconds = Math.max(5, Math.min(120, Math.round(timeoutMs / 1000) || 12))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), (seconds + 15) * 1000)
  timer.unref?.()
  try {
    const res = await fetchImpl(`${bridgeUrl}/forward`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url,
        method: 'GET',
        headers: {},
        body: null,
        mode,
        wait_for_selector: '',
        target_selector: '',
        timeout: seconds,
        scroll: 0,
        format,
      }),
      signal: controller.signal,
    })
    const text = await res.text()
    let doc = null
    try {
      doc = JSON.parse(text)
    } catch {
      return { ok: false, error: `中继返回非 JSON：${text.slice(0, 160)}` }
    }
    if (doc?.error) return { ok: false, error: String(doc.error) }
    const body = typeof doc?.body === 'string' ? doc.body.slice(0, maxBytes) : ''
    return { ok: true, status: doc?.status ?? 0, text: body, viaBridge: true }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** 裸 fetch（有界读取），可选带 Cookie 头。 */
export async function fetchPlain(url, opts = {}) {
  const { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, cookie = null } = opts
  if (typeof fetchImpl !== 'function') return { ok: false, error: '当前环境没有 fetch' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        ...(cookie ? { cookie } : {}),
      },
    })
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
    return { ok: true, status: res.status, text: await readBounded(res, maxBytes) }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 抽出「JS/HTML 跳转」的目标地址。
 *
 * 禅道这类站点在会话失效时返回的不是登录表单，而是一个**跳转壳**：
 *   `<script>self.location='/index.php?m=user&f=login&referer=…';</script>`
 * 它既没有 `<title>` 也没有表单，所以必须单独识别 + 跟一跳，才能判明「到底是登录页还是正常页」。
 */
export function extractRedirectTarget(html, baseUrl = null) {
  const body = String(html ?? '')
  const patterns = [
    /(?:self|window|top|document)\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i,
    /location\.replace\(\s*['"]([^'"]+)['"]\s*\)/i,
    /<meta[^>]+http-equiv=['"]?refresh['"]?[^>]*content=['"][^'"]*url=([^'">]+)/i,
  ]
  for (const re of patterns) {
    const m = body.match(re)
    if (!m) continue
    const raw = m[1].trim()
    if (!raw) continue
    try {
      return baseUrl ? new URL(raw, baseUrl).toString() : raw
    } catch {
      return raw
    }
  }
  return null
}

/** 页面像不像登录页（禅道/常见后台的登录页特征，含「JS 跳到登录」的壳）。 */
export function looksLikeLoginPage(text, { url = null } = {}) {
  const body = String(text ?? '')
  if (!body) return false
  const title = (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim()
  // ⚠️ 不要写 `(登录)\b`：`\b` 只在「词字符与非词字符」交界成立，而中文不是 \w，
  // 于是 `登录 - 禅道` 永远匹配不上（本插件实测踩过：登录页被判成正常页）。
  if (/^(登录|登陆|login|sign\s?in)/i.test(title)) return true
  if (/name=["']?(account|password|pwd)["']?/i.test(body) && /(登录|登陆|login)/i.test(body)) return true
  if (/请先登录|登录后(才能)?查看|not\s+logged\s+in|please\s+(log|sign)\s?in/i.test(body)) return true
  // 极小的跳转壳且目标是登录地址 → 也是「要登录」
  const redirect = extractRedirectTarget(body, url)
  if (redirect && /(^|[/?&])(m=user&f=login|f=login|login|signin|sign_in)([/?&=]|$)/i.test(redirect)) return true
  if (body.length < 600 && /location\s*=|http-equiv=['"]?refresh/i.test(body) && /login|登录|登陆/i.test(body)) return true
  return false
}

/**
 * 取页主入口：bridge → cookie-jar → plain。
 *
 * @returns {Promise<{ ok:boolean, text:string, strategy:'bridge'|'cookie-jar'|'plain'|'none', status?:number,
 *   needsLogin:boolean, error?:string, bridge?:object, jar?:object }>}
 */
export async function fetchPage(url, opts = {}) {
  const { env = process.env, fetchImpl = globalThis.fetch, withBridge = true, withJar = true, maxRedirects = 2 } = opts
  const attempts = []
  let text = ''
  let status
  let strategy = 'none'
  let bridgeInfo = null
  let jarInfo = null
  let usedJar = false
  /** jar 没命中时的原因（含 jar 里现有哪些 host），会在 error 里带出去。 */
  let jarMiss = null

  if (withBridge) {
    bridgeInfo = await bridgeStatus({ bridgeUrl: bridgeUrlOf(env), fetchImpl })
    // ⚠️ 只要守护进程可达就**实测转发**，不看 `/status` 的 `running` 标志：
    // 本机实测 running:false 时 POST /forward 依然 200 拿到页面（禅道插件注释里也记了这条）。
    // 早先信了这个标志 → 中继整跳被跳过 → 掉到裸 fetch → 内部站点只剩登录页。
    if (bridgeInfo.ok) {
      const viaBridge = await fetchViaBridge(url, { ...opts, fetchImpl, bridgeUrl: bridgeUrlOf(env) })
      attempts.push(`bridge:${viaBridge.ok ? 'ok' : viaBridge.error}`)
      if (viaBridge.ok && viaBridge.text) {
        text = viaBridge.text
        status = viaBridge.status
        strategy = 'bridge'
      }
    } else {
      attempts.push(`bridge:${bridgeInfo.error ?? '守护进程不可达'}`)
    }
  }

  if (!text && withJar) {
    const lookup = jarLookup(url, { env })
    jarInfo = lookup.hit
    if (jarInfo) {
      const withCookie = await fetchPlain(url, { ...opts, fetchImpl, cookie: jarInfo.header })
      attempts.push(`cookie-jar:${withCookie.ok ? 'ok' : withCookie.error}`)
      if (withCookie.ok && withCookie.text) {
        text = withCookie.text
        status = withCookie.status
        strategy = 'cookie-jar'
        usedJar = true
      }
    } else {
      const reason = jarMissReason(lookup) ?? '没有可用的 jar'
      attempts.push(`cookie-jar:${reason}`)
      jarMiss = reason
    }
  }

  if (!text) {
    const plain = await fetchPlain(url, { ...opts, fetchImpl })
    attempts.push(`plain:${plain.ok ? 'ok' : plain.error}`)
    if (plain.ok && plain.text) {
      text = plain.text
      status = plain.status
      strategy = 'plain'
    } else if (!status) {
      status = plain.status
    }
  }

  // 跟随「JS/meta 跳转壳」：会话失效时服务端给的就是这种壳（没有 title 也没有表单），
  // 不跟一跳就只会得到一句没用的「页面里没有 title/h1」。
  let hops = 0
  while (text && hops < Math.max(0, maxRedirects)) {
    const target = extractRedirectTarget(text, url)
    if (!target) break
    const looksLikeShell = text.length < 1200 && !/<title/i.test(text) && !/<h1/i.test(text)
    const toLogin = /(^|[/?&])(m=user&f=login|f=login|login|signin|sign_in)([/?&=]|$)/i.test(target)
    if (!looksLikeShell && !toLogin) break
    hops += 1
    attempts.push(`redirect#${hops}:${toLogin ? '登录' : '跟随'} ${target.slice(0, 80)}`)
    const next = await fetchPlain(target, { ...opts, fetchImpl, cookie: usedJar && jarInfo ? jarInfo.header : null })
    if (!next.ok || !next.text) {
      attempts.push(`redirect#${hops}:失败 ${next.error}`)
      break
    }
    text = next.text
    status = next.status
    if (toLogin) break // 已经确认跳到登录页，不必再跟
  }

  const needsLogin = text ? looksLikeLoginPage(text, { url }) : false
  const staleJar = usedJar && needsLogin
  return {
    ok: Boolean(text) && !needsLogin,
    text,
    strategy,
    status,
    needsLogin,
    staleJar,
    hops,
    bridge: bridgeInfo,
    jar: jarInfo ? { path: jarInfo.path, count: jarInfo.count, names: jarInfo.names, mtimeMs: jarInfo.mtimeMs } : null,
    attempts,
    error: !text
      ? `三次取页都失败：${attempts.join('；')}`
      : needsLogin
        ? staleJar
          ? `cookie jar 里的会话已过期（服务端把请求跳到了登录页）：重新导出 jar（~/.local/bin/zentao-export-cookies）或连上浏览器扩展后重试`
          : strategy === 'plain' && jarMiss
            ? `取到的是登录页，而且浏览器中继没给出页面、cookie jar 也用不上（${jarMiss}）：请在浏览器里登录后重试，或把该站点的 Cookie 导出成 jar`
            : `取到的是登录页（策略 ${strategy}）：${strategy === 'bridge' ? '浏览器里可能没登录' : '需要登录态，连上浏览器扩展或导出 cookie jar'}`
        : undefined,
    /** 每一跳的结果，出错时最有用的线索（面板/工具会显示）。 */
    attempts,
  }
}
