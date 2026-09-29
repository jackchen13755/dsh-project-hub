/**
 * 宿主侧测试共用夹具（零外部依赖）。
 *
 * 约定：
 *   - 临时目录一律建在**工作区内**的 `.scratch/`（沙箱只允许写工作区），每个测试文件
 *     自己在 tearDown 里 `rmSync(dir, { recursive:true, force:true })`；
 *   - 每个用到 Store 的测试用 `useTempHome()` 把 `DSH_HOME` 指到临时目录，
 *     顺便把 `DSH_PROJECT_ROOTS` 指到临时工作根，让 `projectIdFromCwd` 的结果可预期；
 *   - 会话日志按真实形态造：**每段一个独立 zstd 帧再 concat**（多帧追加）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { installApi } from '../lib/api.js'
import { Store } from '../lib/store.js'

export const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
export const WORKSPACE_DIR = dirname(PLUGIN_DIR)
export const SCRATCH_BASE = join(WORKSPACE_DIR, '.scratch')

/** 建一个工作区内的随机临时目录。 */
export function makeScratch(prefix = 'ph-test') {
  mkdirSync(SCRATCH_BASE, { recursive: true })
  return mkdtempSync(join(SCRATCH_BASE, `${prefix}-`))
}

export function cleanupScratch(dir) {
  if (!dir) return
  rmSync(dir, { recursive: true, force: true })
}

export function writeFixture(dir, name, content) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, content)
  return file
}

/**
 * 临时 `DSH_HOME` + 临时工作根。返回的 `restore()` 还原环境变量并删掉整棵临时目录。
 * 必须在 `afterEach` / `t.after` 里调用。
 */
export function useTempHome({ workRootName = 'work' } = {}) {
  const dir = makeScratch('ph-test')
  const home = join(dir, 'dsh-home')
  const workRoot = join(dir, workRootName)
  mkdirSync(home, { recursive: true })
  mkdirSync(workRoot, { recursive: true })
  const prevHome = process.env.DSH_HOME
  const prevRoots = process.env.DSH_PROJECT_ROOTS
  process.env.DSH_HOME = home
  process.env.DSH_PROJECT_ROOTS = workRoot
  return {
    dir,
    home,
    workRoot,
    sessionsRoot: join(home, 'sessions'),
    path: (...parts) => join(home, ...parts),
    /** 建一个工作根下的项目目录并返回绝对路径。 */
    projectCwd(rel) {
      const abs = join(workRoot, rel)
      mkdirSync(abs, { recursive: true })
      return abs
    },
    restore() {
      if (prevHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prevHome
      if (prevRoots === undefined) delete process.env.DSH_PROJECT_ROOTS
      else process.env.DSH_PROJECT_ROOTS = prevRoots
      cleanupScratch(dir)
    },
  }
}

/** 打开临时库（`DSH_HOME` 由 `useTempHome()` 指好）；打开失败直接失败，不静默。 */
export function openStore(config = {}) {
  const opened = Store.open({ tz: 'Asia/Shanghai', scan: { minDigits: 3, weakMinHits: 2 }, ...config })
  assert.equal(opened.error, undefined, `Store.open 失败：${opened.error}`)
  assert.ok(opened.store, 'Store.open 应该返回 store')
  return opened.store
}

// ── 会话日志合成 ──────────────────────────────────────────────────────────

/** 会话目录名（`--Users-demo-Desktop-work-spms--` 这种）。 */
export function mangleCwd(cwd) {
  return `-${String(cwd).replace(/^\/+/, '').replace(/[/.]+/g, '-')}-`
}

/**
 * 写一个多帧会话日志：`frames` 是「事件数组」的数组，**每段单独压缩成一个 zstd 帧再拼**。
 * @returns {{file:string, sessionDir:string, bytes:number, frames:number}}
 */
export function writeSessionFrames(sessionsRoot, { sessionId, mangled, frames, fileName = 'session.v4.jsonl.zstd' }) {
  const sessionDir = join(sessionsRoot, mangled ?? mangleCwd('unknown'), sessionId)
  mkdirSync(sessionDir, { recursive: true })
  const parts = frames.map((events) => zstdCompressSync(Buffer.from(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8')))
  const buf = Buffer.concat(parts)
  const file = join(sessionDir, fileName)
  writeFileSync(file, buf)
  return { file, sessionDir, bytes: buf.length, frames: parts.length }
}

/** ISO 字符串 → epoch ms（测试里用它把「哪一天」写清楚）。 */
export const at = (iso) => Date.parse(iso)

export const evHeader = ({ id, cwd, createdAt, agentPreset = 'default' }) => ({ type: 'session', id, createdAt, cwd, agentPreset })
export const evTitle = (title, time) => ({ type: 'session/title', time, data: { title } })
export const evUser = (text, time, extra = {}) => ({ type: 'user/message', time, data: { content: [{ type: 'text', text }], ...extra } })
export const evAssistant = (text, time) => ({ type: 'assistant/message', time, data: { message: { content: [{ type: 'text', text }] } } })
export const evToolCall = (name, time) => ({ type: 'tool/call', time, data: { name } })

// ── HTTP 桩 ──────────────────────────────────────────────────────────────

/** 假 req：`{method,url}` 的 async iterable（`readBody` 用 `for await`）。 */
export function stubReq({ method = 'GET', url = '/', body, rawBody } = {}) {
  const chunks = []
  if (rawBody !== undefined) chunks.push(Buffer.from(rawBody))
  else if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)))
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** 假 res：收集 writeHead / end。 */
export function stubRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) {
      res.statusCode = code
      res.headers = headers ?? null
      return res
    },
    end(chunk) {
      res.body = chunk === undefined ? '' : String(chunk)
      return res
    },
  }
  return res
}

/**
 * 装上 `installApi` 并通过假 ctx 抓到 handler（不起 HTTP 服务）。
 * handler 的签名是 `(req, res) => Promise`。
 */
export function captureApi(store, deps = {}) {
  let spec = null
  const ctx = {
    inject(_names, cb) {
      return cb({
        webServer: {
          register(registered) {
            spec = registered
            return () => {}
          },
        },
      })
    },
  }
  const installed = installApi(ctx, { store, config: {}, version: '0.0.0-test', scanIntervalMinutes: 30, ...deps })
  return { installed, spec, handler: spec?.handler ?? null }
}

/** 直接调 handler，返回 { statusCode, headers, body, json }。 */
export async function callApi(handler, { method = 'GET', url = '/project-hub/api/status', body, rawBody } = {}) {
  const res = stubRes()
  await handler(stubReq({ method, url, body, rawBody }), res)
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    json = null
  }
  return { statusCode: res.statusCode, headers: res.headers, body: res.body, json }
}

/** 按 `output.schema.required` 校验工具返回值（含类型）。 */
export function assertSchemaRequired(value, schema, label = 'value') {
  assert.ok(schema && typeof schema === 'object', `${label}: 缺少 output.schema`)
  assert.equal(schema.type, 'object', `${label}: output.schema.type 应为 object`)
  assert.ok(Array.isArray(schema.required), `${label}: output.schema.required 应为数组`)
  for (const key of schema.required) {
    assert.ok(Object.hasOwn(value, key), `${label}: 缺少 required 字段 ${key}`)
    const type = schema.properties?.[key]?.type
    if (type === 'number') assert.equal(typeof value[key], 'number', `${label}.${key} 应为 number`)
    else if (type === 'array') assert.ok(Array.isArray(value[key]), `${label}.${key} 应为 array`)
    else if (type === 'boolean') assert.equal(typeof value[key], 'boolean', `${label}.${key} 应为 boolean`)
    else if (type === 'string') assert.equal(typeof value[key], 'string', `${label}.${key} 应为 string`)
  }
  return value
}
