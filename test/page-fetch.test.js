/**
 * 带登录态取页（照搬禅道插件的策略链）：浏览器中继 → cookie jar → 裸 fetch，
 * 并且**认出登录页**（避免把「登录」当标题存进台账）。
 *
 * 这些断言是「读信息按禅道插件的方式」这句话的可验证形式：链路顺序、Cookie 头、
 * 每一跳失败原因、登录页判定、以及降级后仍拿得到标题的路径。
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import {
  cookieHeaderFor,
  defaultJarPaths,
  fetchPage,
  looksLikeLoginPage,
  parseJarCookies,
  bridgeUrlOf,
  DEFAULT_BRIDGE_URL,
} from '../lib/page-fetch.js'
import { resolveDocTitle } from '../lib/doc-title.js'
import { buildTools } from '../lib/tools.js'
import { openStore, useTempHome } from './helpers.js'

let tmp = null

beforeEach(() => {
  tmp = useTempHome()
})

afterEach(() => {
  tmp?.restore()
  tmp = null
})

/** 造一份 Netscape 格式的 cookie jar。 */
function writeJar(dir, host, cookies) {
  const lines = ['# Netscape HTTP Cookie File']
  for (const [name, value, expires = 0] of cookies) lines.push(`${host}\tTRUE\t/\tFALSE\t${expires}\t${name}\t${value}`)
  const path = join(dir, 'cookies.txt')
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

test('cookie jar：按 host 匹配、过期剔除、会话 cookie 保留', () => {
  const future = Math.floor(Date.now() / 1000) + 3600
  const past = Math.floor(Date.now() / 1000) - 3600
  const text = [
    '# Netscape HTTP Cookie File',
    `zen.example.com\tTRUE\t/\tFALSE\t${future}\tzentaosid\tabc123`,
    `zen.example.com\tTRUE\t/\tFALSE\t${past}\tstale\told`,
    `zen.example.com\tTRUE\t/\tFALSE\t0\tsession_only\tsess1`,
    `other.example.com\tTRUE\t/\tFALSE\t${future}\tother\tx`,
  ].join('\n')
  const cookies = parseJarCookies(text, 'zen.example.com')
  assert.deepEqual(cookies.map((c) => c.name).sort(), ['session_only', 'zentaosid'])
  assert.equal(parseJarCookies(text, 'sub.zen.example.com').length, 2, '子域应该匹配')
  assert.equal(parseJarCookies(text, 'other.example.com').length, 1)
  assert.equal(parseJarCookies(text, 'nope.example.com').length, 0)
})

test('cookie jar：cookieHeaderFor 找到可用 jar 并拼出 Cookie 头', () => {
  const jar = writeJar(tmp.dir, 'zen.example.com', [['zentaosid', 'abc123'], ['lang', 'zh-cn']])
  const hit = cookieHeaderFor('https://zen.example.com/index.php?m=doc', { env: { DSH_COOKIE_JAR: jar } })
  assert.ok(hit)
  assert.equal(hit.path, jar)
  assert.equal(hit.count, 2)
  assert.match(hit.header, /zentaosid=abc123/)
  assert.match(hit.header, /lang=zh-cn/)
  assert.equal(cookieHeaderFor('https://zen.example.com/x', { env: { DSH_COOKIE_JAR: join(tmp.dir, 'missing.txt') } }), null)
  assert.ok(defaultJarPaths({}).length >= 2, '至少要有禅道插件的两个默认路径')
})

test('登录页识别：禅道风格登录页为真，普通文档页为假', () => {
  assert.equal(looksLikeLoginPage('<html><head><title>登录 - 禅道</title></head><body><form><input name="account"><input name="password"></form></body></html>'), true)
  assert.equal(looksLikeLoginPage('<title>Login</title><body>please sign in</body>'), true)
  assert.equal(looksLikeLoginPage('<div>请先登录后查看该文档</div>'), true)
  assert.equal(looksLikeLoginPage('<html><head><title>房态看板改造需求说明书 - 禅道</title></head><body><h1>房态看板改造</h1></body></html>'), false)
  assert.equal(looksLikeLoginPage(''), false)
})

test('取页链路：中继不可达 → 用 cookie jar（带 Cookie 头）→ 命中就返回', async () => {
  const jar = writeJar(tmp.dir, 'zen.example.com', [['zentaosid', 'abc123']])
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers ?? {} })
    if (String(url).endsWith('/status')) throw new Error('ECONNREFUSED')
    return {
      ok: true,
      status: 200,
      text: async () => '<html><head><title>需求说明书 - 禅道</title></head></html>',
      body: null,
    }
  }
  const res = await fetchPage('https://zen.example.com/index.php?m=doc&f=view&id=1', { fetchImpl, env: { DSH_COOKIE_JAR: jar } })
  assert.equal(res.ok, true)
  assert.equal(res.strategy, 'cookie-jar')
  assert.match(res.text, /需求说明书/)
  const docCall = seen.find((c) => c.url.includes('index.php'))
  assert.equal(docCall.headers.cookie, 'zentaosid=abc123', '必须带上登录 Cookie')
  assert.ok(res.attempts.some((a) => a.startsWith('bridge:')), '失败原因要留痕')
})

test('取页链路：中继在线但返回登录页 → needsLogin（不落库）', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/status')) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, running: true, pid: 42 }), body: null }
    if (String(url).endsWith('/forward')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 200, body: '<html><head><title>登录 - 禅道</title></head><body>password</body></html>' }), body: null }
    }
    return { ok: false, status: 500, text: async () => '', body: null }
  }
  const res = await fetchPage('https://zen.example.com/x', { fetchImpl, env: { DSH_COOKIE_JAR: join(tmp.dir, 'none.txt') } })
  assert.equal(res.strategy, 'bridge')
  assert.equal(res.needsLogin, true)
  assert.equal(res.ok, false)
  assert.match(res.error, /登录页/)
  assert.equal(res.bridge.running, true)
})

test('取页链路：三跳全失败 → ok=false 且 attempts 列出每跳原因', async () => {
  const fetchImpl = async () => {
    throw new Error('boom')
  }
  const res = await fetchPage('https://zen.example.com/x', { fetchImpl, env: { DSH_COOKIE_JAR: join(tmp.dir, 'none.txt') } })
  assert.equal(res.ok, false)
  assert.equal(res.text, '')
  assert.equal(res.attempts.length, 3)
  assert.match(res.error, /三次取页都失败/)
})

test('resolveDocTitle：走带登录态链路（fetchText 注入登录页会如实报 needs-login）', async () => {
  const needsLogin = await resolveDocTitle('https://zen.example.com/doc/1', {
    fetchText: async () => ({ ok: false, needsLogin: true, strategy: 'plain', error: '取到的是登录页' }),
  })
  assert.equal(needsLogin.ok, false)
  assert.equal(needsLogin.source, 'needs-login')
  assert.equal(needsLogin.needsLogin, true)

  const viaBridge = await resolveDocTitle('https://zen.example.com/doc/2', {
    fetchText: async () => ({ ok: true, text: '<title>需求说明书 - 禅道</title>', strategy: 'bridge', status: 200 }),
  })
  assert.equal(viaBridge.ok, true)
  assert.equal(viaBridge.title, '需求说明书')
  assert.equal(viaBridge.strategy, 'bridge')
  assert.equal(viaBridge.viaSession, true)
})

test('登录页场景：标题不落库，原因是可读的中文（含每一跳的线索）', async () => {
  const store = openStore()
  try {
    // 直接走 resolveDocTitle 的取页注入点，模拟「链路最后一步拿回登录页」
    const result = await resolveDocTitle('https://zen.example.com/index.php?m=doc&f=view&id=1', {
      fetchText: async () => ({
        ok: false,
        needsLogin: true,
        strategy: 'plain',
        status: 200,
        error: '取到的是登录页（策略 plain）：cookie jar 可能已过期或浏览器桥没连上',
        attempts: ['bridge:扩展未连接', 'cookie-jar:没有可用的 jar', 'plain:ok'],
      }),
    })
    assert.equal(result.ok, false)
    assert.equal(result.title, null, '绝不能把「登录」当标题')
    assert.equal(result.source, 'needs-login')
    assert.equal(result.needsLogin, true)
    assert.match(result.error, /取到的是登录页/)
    assert.match(result.error, /cookie jar|浏览器桥/)

    // 工具面同样如实转述（ph_doc_title 的输出就是 resolveDocTitle 的结果）
    const tools = new Map(buildTools({ store, config: {}, version: 't' }).map((t) => [t.name, t]))
    assert.ok(tools.get('ph_doc_title').description.includes('title'))
  } finally {
    store.close()
  }
})

test('bridgeUrlOf：环境变量优先，默认 127.0.0.1:9317', () => {
  assert.equal(bridgeUrlOf({}), DEFAULT_BRIDGE_URL)
  assert.equal(bridgeUrlOf({ DAEMON_URL: 'http://127.0.0.1:9999' }), 'http://127.0.0.1:9999')
  assert.equal(bridgeUrlOf({ DSH_BRIDGE_URL: 'http://127.0.0.1:1234', DAEMON_URL: 'http://127.0.0.1:9999' }), 'http://127.0.0.1:1234')
})
