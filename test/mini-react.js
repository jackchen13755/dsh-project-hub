/**
 * 无浏览器跑真面板的**测试夹具**（行为测试与面板预览共用）：
 *   · `createMiniReact()` —— 极简 hooks 运行时（useState/useEffect/useCallback/useRef 真的会跑，
 *     setState 真的会重渲染，effect 按 deps 比较），够把 `lib/client.js` 的 Panel 跑起来；
 *   · `createFetchStub()` —— 假 fetch：记录调用序列、可指定某些路由挂起（验 loading / 乱序覆盖）；
 *   · `mountPanel()` —— 在 vm 沙箱里装载 client.js，注册上下文，返回面板的 render 函数。
 *
 * 为什么需要它：真 React 的桩（`test/client-panel.test.js` 里那套）把 hooks 全实现成空函数，
 * 「点查询不生效、切 tab 条件串了」这类 bug 在桩里永远不会暴露 —— 只有 effect/闭包真的跑起来才看得见。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
/** 被测客户端面板（真源码，不是编译产物 —— 本插件无构建步骤）。 */
export const CLIENT = join(here, '..', 'lib', 'client.js')

// ─────────────────────────────────────────────── 极简 hooks 运行时（够跑真面板）

export function createMiniReact() {
  /** 按组件路径保存 hooks：同一路径 = 同一个组件实例。 */
  const fibers = new Map()
  let current = null
  let dirty = false
  const effectQueue = []
  let pending = new Set()

  const react = {
    createElement: (type, props, ...children) => {
      const merged = { ...(props ?? {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged }
    },
    useState: (initial) => {
      const fiber = current
      const index = fiber.idx++
      if (!(index in fiber.hooks)) fiber.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      const hook = fiber.hooks[index]
      const setState = (next) => {
        const value = typeof next === 'function' ? next(hook.value) : next
        if (Object.is(value, hook.value)) return
        hook.value = value
        dirty = true
      }
      return [hook.value, setState]
    },
    useRef: (value) => {
      const fiber = current
      const index = fiber.idx++
      if (!(index in fiber.hooks)) fiber.hooks[index] = { current: value }
      return fiber.hooks[index]
    },
    useCallback: (fn, deps) => {
      const fiber = current
      const index = fiber.idx++
      const prev = fiber.hooks[index]
      if (prev && sameDeps(prev.deps, deps)) return prev.fn
      fiber.hooks[index] = { fn, deps }
      return fn
    },
    useEffect: (fn, deps) => {
      const fiber = current
      const index = fiber.idx++
      effectQueue.push({ fiber, index, fn, deps })
    },
    useMemo: (fn, deps) => {
      const fiber = current
      const index = fiber.idx++
      const prev = fiber.hooks[index]
      if (prev && sameDeps(prev.deps, deps)) return prev.value
      const value = fn()
      fiber.hooks[index] = { value, deps }
      return value
    },
  }

  function sameDeps(a, b) {
    if (!a || !b || a.length !== b.length) return false
    return a.every((item, i) => Object.is(item, b[i]))
  }

  /** 展开元素树：函数组件真的被调用（hooks 按路径归属），宿主元素原样留下。 */
  function expand(node, path) {
    if (node === null || node === undefined || typeof node === 'boolean') return node
    if (Array.isArray(node)) return node.map((item, i) => expand(item, `${path}.${i}`))
    if (typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      const fiber = fibers.get(path) ?? { hooks: [], idx: 0 }
      fiber.idx = 0
      fibers.set(path, fiber)
      const previous = current
      current = fiber
      let out
      try {
        out = node.type(node.props ?? {})
      } finally {
        current = previous
      }
      return expand(out, `${path}>`)
    }
    const props = { ...node.props }
    if ('children' in props) props.children = expand(props.children, `${path}.${typeof path === 'string' ? path.length : 0}`)
    return { type: node.type, props }
  }

  function runEffects() {
    const queue = effectQueue.splice(0, effectQueue.length)
    for (const item of queue) {
      const prev = item.fiber.hooks[item.index]
      if (prev && prev.deps && item.deps && sameDeps(prev.deps, item.deps)) continue
      if (prev && typeof prev.cleanup === 'function') prev.cleanup()
      const cleanup = item.fn()
      item.fiber.hooks[item.index] = { deps: item.deps, cleanup }
    }
  }

  let tree = null
  function pass(getRoot) {
    dirty = false
    tree = expand(getRoot(), 'root')
    runEffects()
  }

  /**
   * 驱动：跑渲染 + 效果，直到**安静下来**（连续 `quietMs` 没有任何 state 变化 / 挂起请求结算）。
   *
   * 为什么不能"固定跑 N 轮"：面板的请求是异步链（先 /requirements 再 /requirements/tags），
   * 真宿主（HTTP）比假 fetch 慢得多；固定轮数会在数据落地前就收工 → 截到空列表 + 一直转圈。
   *
   * @param options.quietMs 连续多静算"结算完成"（默认 12ms；跑真数据时给大一点）
   * @param options.maxMs   最长时间，免得挂起的请求把测试拖死（默认 5s）
   */
  async function act(getRoot, fn, options = {}) {
    const quietMs = options.quietMs ?? 12
    const maxMs = options.maxMs ?? 5000
    const started = Date.now()
    let lastActivity = Date.now()
    if (fn) fn()
    for (;;) {
      if (tree === null || dirty) {
        pass(getRoot)
        lastActivity = Date.now()
      }
      if (Date.now() - started > maxMs) break
      await new Promise((resolve) => setTimeout(resolve, 3))
      if (pending.size) {
        await Promise.allSettled([...pending])
        lastActivity = Date.now()
      }
      if (dirty) lastActivity = Date.now()
      if (Date.now() - lastActivity >= quietMs) break
    }
    if (dirty) pass(getRoot)
  }

  function registerPending(promise) {
    pending.add(promise)
    promise.finally(() => pending.delete(promise))
  }

  // ── 供断言的查询工具
  const walk = (node, out = []) => {
    if (node === null || node === undefined || typeof node === 'boolean') return out
    if (Array.isArray(node)) {
      for (const item of node) walk(item, out)
      return out
    }
    if (typeof node !== 'object') return out
    out.push(node)
    if (node.props && 'children' in node.props) walk(node.props.children, out)
    return out
  }
  const texts = () => {
    const out = []
    const visit = (node) => {
      if (node === null || node === undefined || typeof node === 'boolean') return
      if (typeof node === 'string' || typeof node === 'number') {
        out.push(String(node))
        return
      }
      if (Array.isArray(node)) {
        for (const item of node) visit(item)
        return
      }
      if (typeof node === 'object' && node.props && 'children' in node.props) visit(node.props.children)
    }
    visit(tree)
    return out.join('|')
  }
  const nodes = () => walk(tree)
  const buttons = () => nodes().filter((el) => el.type === 'button')
  const findButton = (label) => buttons().find((el) => String(el.props.children ?? '').includes(label))
  const findButtons = (label) => buttons().filter((el) => String(el.props.children ?? '').includes(label))
  const inputs = () => nodes().filter((el) => el.type === 'input')
  const findInput = (placeholderPart) => inputs().find((el) => String(el.props.placeholder ?? '').includes(placeholderPart))

  return { react, act, texts, nodes, buttons, findButton, findButtons, inputs, findInput, registerPending, getTree: () => tree }
}

// ─────────────────────────────────────────────── 假 fetch（记录调用序列）

export function createFetchStub(options = {}) {
  const calls = []
  const hangRoutes = new Map()
  const waiting = []
  let reqCall = 0
  const fetchStub = (url) => {
    calls.push(url)
    const path = url.replace('/project-hub/api', '')
    const route = path.split('?')[0]
    let payload
    // 每次调用可以给不同的 total（用来验「慢的旧响应不许覆盖新结果」）
    const totals = options.totalsByCall
    if (route === '/status') payload = { ok: true, counts: { requirements: 5, workLogs: 3 }, lastScanAt: null }
    else if (route === '/projects') payload = { ok: true, candidates: [{ id: 'spms', name: 'spms' }] }
    else if (route === '/requirements/tags') payload = { ok: true, tags: [{ tag: '历史导入', count: 2 }] }
    else if (route === '/requirements') {
      const total = totals ? (totals[reqCall] ?? totals.at(-1)) : options.total ?? 5
      reqCall += 1
      payload = {
        ok: true,
        total,
        items: total === 0 ? [] : [{ id: '5941', no: '5941', title: '房态看板', projectId: 'spms', projectName: 'spms', status: 'developing', links: [], tags: [], projects: [] }],
      }
    } else if (route === '/logs') {
      payload = { ok: true, total: 42, items: [{ id: 1, date: '2026-10-01', kind: 'dev', title: '一条记录', projectId: 'spms', projectName: 'spms' }] }
    } else if (route === '/code/coverage') payload = { ok: true, projects: [] }
    else if (route === '/discover') payload = { ok: true, items: [], state: [], settings: { intervalMinutes: 0 } }
    else if (route === '/report') payload = { ok: true, days: [], totals: null }
    else if (route === '/drift') payload = { ok: true, items: [] }
    else if (route === '/drift/todos') payload = { ok: true, enabled: false, items: [] }
    else payload = { ok: true, items: [] }
    const respond = () => ({ json: async () => payload })
    // 需要挂起（验 loading / 乱序）的路由：先不结算，等测试调用 release()
    if ((hangRoutes.get(route) ?? 0) > 0) {
      hangRoutes.set(route, hangRoutes.get(route) - 1)
      return new Promise((resolve) => {
        waiting.push(() => resolve(respond()))
      })
    }
    return Promise.resolve(respond())
  }
  fetchStub.calls = calls
  fetchStub.hang = (route, times = 1) => {
    hangRoutes.set(route, times)
    return fetchStub
  }
  /** 放开挂起的请求（可以只放一个：验乱序覆盖）。 */
  fetchStub.release = (count = Infinity) => {
    const list = waiting.splice(0, count)
    for (const fn of list) fn()
    return list.length
  }
  fetchStub.callsTo = (route) => calls.filter((url) => url.replace('/project-hub/api', '').split('?')[0] === route)
  return fetchStub
}

// ─────────────────────────────────────────────── 装载面板

function mountPanel$(fetchStub) {
  const code = readFileSync(CLIENT, 'utf8')
  let def = null
  // 定时器做成**可手动 tick** 的：轮询路径（无 sessionId 时每 60 秒）才能被测到
  const timers = []
  const windowStub = {
    __ModuleLoader__: { load: (d) => { def = d } },
    setInterval: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearInterval: (id) => {
      if (id) timers[id - 1] = null
    },
  }
  const injected = []
  const documentStub = {
    getElementById: () => null,
    createElement: () => {
      const el = { id: '', textContent: '' }
      injected.push(el)
      return el
    },
    head: { appendChild: () => {} },
  }
  const sandbox = {
    window: windowStub,
    document: documentStub,
    fetch: fetchStub,
    console,
    URL,
    URLSearchParams,
    Date,
    JSON,
    Math,
    Number,
    String,
    Object,
    Array,
    Error,
    Boolean,
    Promise,
    setTimeout,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'lib/client.js' })

  const mini = createMiniReact()
  const mod = def.factory(() => mini.react)
  const slotRegistrations = []
  const ctx = {
    inject: (deps, cb) => {
      if (deps.includes('sidebarRightTabs')) cb({ sidebarRightTabs: { register: () => () => {} } })
      if (deps.includes('sidebarRight')) cb({ sidebarRight: { openTab: () => {} } })
      return () => {}
    },
    slots: { inject: (name, cb) => { cb(); return () => {} }, register: (payload, render) => { slotRegistrations.push({ payload, render }); return () => {} } },
    effect: (fn) => {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') dispose() }
    },
  }
  mod.apply(ctx)
  const renderPanel = slotRegistrations.find((r) => r.payload.name === 'sidebar.right.pane.tab').render
  return {
    mini,
    renderPanel,
    fetchStub,
    injectedStyles: injected.map((el) => el.textContent).join('\n'),
    /** 触发一次宿主定时器（轮询）；返回触发了几次。 */
    tickTimers: () => {
      const live = timers.filter(Boolean)
      for (const fn of live) fn()
      return live.length
    },
  }
}
export { mountPanel$ as mountPanel }

export const queryOf = (url) => new URLSearchParams(url.slice(url.indexOf('?') + 1))

