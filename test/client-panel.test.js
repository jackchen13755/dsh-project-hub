/**
 * 客户端面板契约测试（**不装浏览器**也要能验，技法同 dsh-zentao-workbench / dsh-memory-core）。
 *
 * 验三件事，任何一件退化都会让面板「静默不出现」：
 *   ① 交付信封：`window.__ModuleLoader__.load({ id, factory })`，id 与包名一致；
 *   ② 侧边栏注册全链：`sidebarRightTabs.register({id,kind,title,guide})` +
 *      `slots.register('sidebar.right.pane.tab', key=TYPE_ID)` + 标题座位；
 *   ③ 渲染路径可跑：用假 React 调一次 seat 的 render(props)，不能抛。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(here, '..', 'lib', 'client.js')

/** 假 React：只要够跑通面板的结构（createElement + 四个 hook）。
 *  ⚠️ children 必须像真 React 一样放进 `props.children`：组件（Btn/Pill/Field…）内部
 *  读的就是 `props.children`，桩里不放就会「按钮渲染不出文字」这类假阴性。 */
function fakeReact() {
  const calls = []
  return {
    calls,
    createElement: (type, props, ...children) => {
      const merged = { ...(props ?? {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      calls.push({ type, props: merged, children })
      return { type, props: merged, children: merged.children }
    },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  }
}

/** 递归展开函数组件，收集真正的宿主元素（用来断言 <a>/<button> 这类）。 */
function collectElements(node, out = [], depth = 0) {
  if (node === null || node === undefined || depth > 20) return out
  if (Array.isArray(node)) {
    for (const item of node) collectElements(item, out, depth + 1)
    return out
  }
  if (typeof node === 'object') {
    if (typeof node.type === 'function') {
      collectElements(node.type(node.props ?? {}), out, depth + 1)
      return out
    }
    out.push(node)
    if (node.children) collectElements(node.children, out, depth + 1)
  }
  return out
}

/** 递归收集渲染树里的所有字符串；函数组件要真的调用一次才会展开（假 React 不做这件事）。 */
function collectStrings(node, out = [], depth = 0) {
  if (node === null || node === undefined || depth > 20) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out, depth + 1)
    return out
  }
  if (typeof node === 'object') {
    if (typeof node.type === 'function') {
      collectStrings(node.type(node.props ?? {}), out, depth + 1)
      return out
    }
    if (node.children) collectStrings(node.children, out, depth + 1)
    if (node.props && node.props.children) collectStrings(node.props.children, out, depth + 1)
  }
  return out
}

function loadClient() {  const code = readFileSync(CLIENT, 'utf8')
  let captured = null
  const appended = []
  const windowStub = {
    __ModuleLoader__: { load: (def) => { captured = def } },
    setInterval: () => 0,
    clearInterval: () => {},
  }
  const documentStub = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: (el) => appended.push(el) },
  }
  const sandbox = { window: windowStub, document: documentStub, console, URL, URLSearchParams, Date, JSON, Math, Number, String, Object, Array, Error, Boolean, Promise, setTimeout }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'lib/client.js' })
  return { def: captured, appended }
}

test('客户端号识别镜像：章节页编号不许被当成需求号（与宿主同结果）', () => {
  const { def } = loadClient()
  const mod = def.factory(() => fakeReact())
  const fn = mod.__test.extractNoFromTitle
  assert.equal(fn('【5922】L&F Q3 Enhancements'), '5922')
  assert.equal(fn('SPMS-5921 房态看板'), '5921')
  assert.equal(fn('11  Housekeeping'), null)
  assert.equal(fn('01-Service360需求文档'), null)
  assert.equal(fn('32 CEPT'), null)
  assert.equal(fn('5921 房态看板改造'), '5921')
})

test('客户端信封：id 与 factory 形态符合宿主约定', () => {
  const { def } = loadClient()
  assert.ok(def, 'window.__ModuleLoader__.load 没有被调用')
  assert.equal(def.id, 'dsh-project-hub')
  assert.equal(typeof def.factory, 'function')
  const React = fakeReact()
  const mod = def.factory(() => React)
  // 跨 vm realm 的数组不能直接 deepEqual（原型不同），按值比
  assert.equal(mod.inject.length, 1)
  assert.equal(mod.inject[0], 'slots')
  assert.equal(typeof mod.apply, 'function')
  assert.ok(mod.__test, '应导出 __test 便于契约测试')
  assert.equal(mod.__test.TYPE_ID, 'dsh-project-hub:panel')
})

test('侧边栏全链注册：页签类型 + 主体座位 + 标题座位 + 打开入口', () => {
  const { def } = loadClient()
  const React = fakeReact()
  const mod = def.factory(() => React)

  const tabRegistrations = []
  const slotRegistrations = []
  const openCalls = []
  const effects = []

  const ctx = {
    inject: (deps, cb) => {
      if (deps.includes('sidebarRightTabs')) {
        cb({ sidebarRightTabs: { register: (payload) => { tabRegistrations.push(payload); return () => {} } } })
      }
      if (deps.includes('sidebarRight')) {
        cb({ sidebarRight: { openTab: (kind, opts) => openCalls.push({ kind, opts }) } })
      }
      return () => {}
    },
    slots: {
      inject: (name, cb) => {
        cb()
        return () => {}
      },
      register: (payload, render) => {
        slotRegistrations.push({ payload, render })
        return () => {}
      },
    },
    effect: (fn, label) => {
      effects.push(label ?? '(unlabeled)')
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
  }

  const handle = mod.apply(ctx)

  // ① 页签类型
  assert.equal(tabRegistrations.length, 1, '必须注册且只注册一次侧边栏页签类型')
  const tab = tabRegistrations[0]
  assert.equal(tab.id, mod.__test.TYPE_ID)
  assert.equal(tab.kind, mod.__test.KIND)
  assert.equal(typeof tab.title, 'function')
  assert.equal(tab.title(), '项目管理')
  assert.ok(Array.isArray(tab.guide) && tab.guide.length === 1, '要有 guide 入口项')
  assert.equal(typeof tab.guide[0].title, 'function')

  // ② 主体 + 标题座位
  const body = slotRegistrations.find((r) => r.payload.name === 'sidebar.right.pane.tab')
  const title = slotRegistrations.find((r) => r.payload.name === 'sidebar.right.pane.tab.title')
  assert.ok(body, '缺少 sidebar.right.pane.tab 主体座位')
  assert.ok(title, '缺少 sidebar.right.pane.tab.title 标题座位')
  assert.equal(body.payload.key, mod.__test.TYPE_ID)
  assert.equal(title.payload.key, mod.__test.TYPE_ID)
  assert.equal(typeof body.render, 'function')
  assert.equal(typeof title.render, 'function')

  // ③ 渲染路径（假 React 下不能抛）：页面头、三个 tab、工具栏都要出现，且 tab 内容互不混
  const tree = body.render({ sessionId: 'session-test' })
  assert.ok(tree, 'render 必须返回元素')
  const texts = collectStrings(tree).join('|')
  for (const expected of ['项目管理', '刷新', '需求台账', '开发日志', '会话扫描', '＋ 需求', '只看已归档']) {
    assert.ok(texts.includes(expected), `面板文案缺少「${expected}」（实际渲染到：${texts.slice(0, 300)}）`)
  }
  assert.deepEqual([...mod.__test.TABS.map(([k]) => k)], ['req', 'history', 'logs', 'drift', 'scan'], '五个 tab：需求 / 历史需求 / 日志 / 变更对账 / 扫描，历史与在做的分开')
  assert.ok(!texts.includes('＋ 记录'), '默认在需求 tab，不该出现日志 tab 的「＋ 记录」按钮')
  assert.ok(!texts.includes('按天活动'), '需求 tab 不该出现会话扫描的按天活动')
  const titleEl = title.render()
  assert.ok(titleEl)

  // ④ 打开入口：没有它页签注册了也没人看得见
  assert.equal(typeof handle.openPanel, 'function')
  assert.equal(handle.openPanel(), true)
  assert.equal(openCalls.length, 1)
  assert.equal(openCalls[0].kind, mod.__test.KIND)

  // ⑤ 侧边栏入口按钮（用户明确要求「入口加在侧边栏里」）
  const footer = slotRegistrations.find((r) => r.payload.name === 'sidebar.footer.action')
  assert.ok(footer, '缺少 sidebar.footer.action 侧边栏入口座位')
  assert.equal(footer.payload.id, 'project-hub')
  assert.equal(footer.payload.order, 36)
  const entryTree = footer.render({})
  assert.ok(entryTree, '入口按钮必须渲染出元素')
  assert.ok(collectStrings(entryTree).join('|').includes('项目管理'), '入口按钮文案应为「项目管理」')
  // 点入口 → 打开右侧边栏页签（__test 走的是同一个 openPanelRef）
  assert.equal(mod.__test.openSidebar(), true)
  assert.equal(openCalls.length, 2)
})

test('纯函数：查询串拼装 / 日期 / 字典', () => {
  const { def } = loadClient()
  const mod = def.factory(() => fakeReact())
  const { scopeQuery, today, fmtTime, KIND_LABEL } = mod.__test
  assert.equal(scopeQuery({ q: '看板', project: '', limit: null }, null), '?q=%E7%9C%8B%E6%9D%BF')
  assert.equal(scopeQuery({ q: 'x' }, 'session-1'), '?q=x&sessionId=session-1')
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(fmtTime(null), '-')
  assert.equal(KIND_LABEL.bug, '缺陷')
})

test('多链接：四类链接字典 + 卡片链接渲染（UI 设计可多条）', () => {
  const { def } = loadClient()
  const mod = def.factory(() => fakeReact())
  const { LINK_LABEL, LINK_FORM_KINDS, renderLinkChips } = mod.__test

  assert.deepEqual([...LINK_FORM_KINDS], ['doc', 'wbs', 'design', 'ui'])
  assert.equal(LINK_LABEL.ui, 'UI 设计')
  assert.equal(LINK_LABEL.design, '后端设计')

  const links = [
    { id: 1, kind: 'doc', kindLabel: '需求文档', url: 'https://doc.example/a', title: '需求说明书' },
    { id: 2, kind: 'doc', kindLabel: '需求文档', url: 'https://doc.example/b', title: '需求补充' },
    { id: 3, kind: 'ui', kindLabel: 'UI 设计', url: 'https://figma.example/x', title: '看板稿' },
    { id: 4, kind: 'ui', kindLabel: 'UI 设计', url: 'https://mastergo.example/y', title: '移动端稿' },
    { id: 5, kind: 'wbs', kindLabel: 'WBS', url: 'https://wbs.example/a', title: null },
  ]
  const chips = renderLinkChips(links, null)
  const texts = collectStrings(chips).join('|')
  assert.ok(texts.includes('需求文档 2'), `类别要显示条数：${texts}`)
  assert.ok(texts.includes('UI 设计 2'))
  // 卡片不再铺全量链接/URL：只有类别胶囊（点开 = 该类第 1 条），逐条查看与复制在详情里
  assert.ok(!texts.includes('https://'), `卡片不该出现 URL 文本：${texts}`)
  const anchors = collectElements(chips)
    .filter((el) => el.type === 'a')
    .map((el) => el.props.href)
  assert.equal(anchors.length, 3, '每类只需一颗可点胶囊（doc / wbs / ui）')
  assert.equal(anchors.join('|'), 'https://doc.example/a|https://wbs.example/a|https://figma.example/x')
  // 单条的那类顺手给个复制按钮；多条的留给详情
  const copies = collectElements(chips).filter((el) => el.type === 'button')
  assert.equal(copies.length, 1, '只有单条类别（WBS）出现复制按钮')
  assert.ok(String(copies[0].props.title).includes('https://wbs.example/a'))

  // 短链接标签：不铺全量 URL
  const { shortUrlLabel } = mod.__test
  assert.equal(shortUrlLabel('https://zen.example.com/index.php?m=doc&f=view&id=12'), 'zen.example.com/…/index.php')
  assert.equal(shortUrlLabel('https://figma.example/file/abc123/Board'), 'figma.example/…/Board')
  assert.ok(shortUrlLabel('not a url').length <= 44)

  // 老数据回落：links 为空时用单值列渲染（各自单条 → 2 颗胶囊 + 2 个复制按钮）
  const legacy = renderLinkChips([], { docUrl: 'https://doc.example/old', docTitle: '老文档', uiUrl: 'https://figma.example/old' })
  const legacyHrefs = collectElements(legacy)
    .filter((el) => el.type === 'a')
    .map((el) => el.props.href)
  // 跨 vm realm 的数组不能直接 deepEqual，按值比
  assert.equal(legacyHrefs.join('|'), 'https://doc.example/old|https://figma.example/old')
  assert.equal(collectElements(legacy).filter((el) => el.type === 'button').length, 2, '单条类别各给一个复制按钮')

  // 面板级：需求表单里四类都有「＋ 添加一条」
  const calls = []
  const React = fakeReact()
  const mod2 = loadClient().def.factory(() => React)
  const body = (() => {
    const slotRegistrations = []
    const ctx = {
      inject: (deps, cb) => {
        if (deps.includes('sidebarRightTabs')) cb({ sidebarRightTabs: { register: (p) => { calls.push(p); return () => {} } } })
        if (deps.includes('sidebarRight')) cb({ sidebarRight: { openTab: () => {} } })
        return () => {}
      },
      slots: { inject: (name, cb) => { cb(); return () => {} }, register: (p, render) => { slotRegistrations.push({ p, render }); return () => {} } },
      effect: (fn) => fn(),
    }
    mod2.apply(ctx)
    return slotRegistrations.find((r) => r.p.name === 'sidebar.right.pane.tab').render({ sessionId: null })
  })()
  assert.ok(body)
  assert.equal(mod2.__test.LINK_FORM_KINDS.length, 4)
})

test('项目配色：同一项目恒定同色，不同项目基本不同色（浅深主题都可读的色板）', () => {
  const { def } = loadClient()
  const mod = def.factory(() => fakeReact())
  const { projectColor } = mod.__test

  // 稳定性：同一个项目多次取色必须一致（跨渲染/跨会话都靠这个）
  assert.equal(projectColor('spms'), projectColor('spms'))
  assert.equal(projectColor('hs-config'), projectColor('hs-config'))
  assert.match(projectColor('spms'), /^#[0-9a-f]{6}$/)
  assert.equal(projectColor(''), 'inherit', '没有项目时不上色，跟随主题')

  // 一组真实项目里至少要有多种颜色（否则「按项目区分」就白做了）
  const ids = ['spms', 'spms-ui-spms', 'hs-config', 's360-mobile', 'ars-genesis', 'fo-portal', 'great-mobile', 'dsh-github']
  const colors = new Set(ids.map((id) => projectColor(id)))
  assert.ok(colors.size >= 4, `8 个项目至少 4 种颜色，实际 ${colors.size}`)
})

test('面板底色：四处内联不透明底色（样式表被 CSP 拦掉也照样不透明）', () => {
  const { def, appended } = loadClient()
  const mod = def.factory(() => fakeReact())

  const slotRegistrations = []
  const ctx = {
    inject: (deps, cb) => {
      if (deps.includes('sidebarRightTabs')) cb({ sidebarRightTabs: { register: () => () => {} } })
      if (deps.includes('sidebarRight')) cb({ sidebarRight: { openTab: () => {} } })
      return () => {}
    },
    slots: {
      inject: (name, cb) => {
        cb()
        return () => {}
      },
      register: (payload, render) => {
        slotRegistrations.push({ payload, render })
        return () => {}
      },
    },
    effect: (fn) => {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
  mod.apply(ctx)

  // ① 底色必须内联：桌面外壳可能拦掉注入的 <style>（CSP 只放行 style-src-attr），
  //    写在表里的底色会静默失效 —— 那正是「面板还是透明」的成因。
  const css = appended.map((el) => el.textContent).join('\n')
  assert.ok(!/dsh-ph-surface/.test(css), '底色不该再放样式表')
  assert.ok(!/bg-layer-1/.test(css), '样式表里不该出现面板底色令牌（表不生效时会丢）')
  assert.ok(/dsh-ph-tab:hover/.test(css), '页签 hover 这类点缀留在表里')

  // ② 面板本体 + 头部 + 页签条 + 吸顶工具栏四处：同一份内联底色，且**不透明**
  const body = slotRegistrations.find((r) => r.payload.name === 'sidebar.right.pane.tab')
  const tree = body.render({ sessionId: 'session-preview' })
  const surfaces = collectElements(tree).filter((el) => el.props && el.props.style && 'backgroundColor' in el.props.style)
  assert.equal(surfaces.length, 4, `面板本体 + 头部 + 页签条 + 工具栏都该有底色，实际 ${surfaces.length} 处`)
  for (const el of surfaces) {
    const { backgroundColor, backgroundImage } = el.props.style
    assert.match(backgroundColor, /^var\(--dsw-alias-bg-layer-1/, '底色要用宿主的 bg-layer-1（不透明面板色）')
    assert.ok(!/transparent|rgba\(/.test(backgroundColor), `面板底色不许带透明度：${backgroundColor}`)
    assert.match(backgroundImage, /^linear-gradient\(color-mix\(in srgb, var\(--dsw-alias-brand-primary/, '淡染层 = 主题色纯色渐变')
    assert.ok(!/transparent\)/.test(backgroundImage.replace(/, transparent\)/g, '')), '淡染层只能是同一个颜色叠两次')
  }
  const same = new Set(surfaces.map((el) => JSON.stringify([el.props.style.backgroundColor, el.props.style.backgroundImage])))
  assert.equal(same.size, 1, '四处必须是同一份底色（否则吸顶工具栏会和内容区对不上）')
  assert.ok(
    surfaces.some((el) => el.props.style.flexDirection === 'column' && el.props.style.height === '100%'),
    '撑满座位的面板根节点也要有底色',
  )

  // ③ 页签形状/颜色也内联（不在表里）：5 个页签、当前页签高亮走 accent
  const tabs = collectElements(tree).filter((el) => el.props && el.props.className === 'dsh-ph-tab')
  assert.equal(tabs.length, 5, `五个页签都要有内联样式，实际 ${tabs.length}`)
  for (const tab of tabs) {
    assert.ok(tab.props.style && tab.props.style.borderBottom, '页签下边框（选中态那条 accent 线）必须内联')
    assert.ok(!('opacity' in tab.props.style), '页签不许用 opacity 调淡（半透明文字 = 看不清）')
  }
  assert.ok(
    tabs.some((el) => String(el.props.style.borderBottom).includes('state-business-primary')),
    '选中的页签要用 accent 下划线',
  )
})

test('删除按钮：两段确认的文案状态机（只在归档视图出现）', () => {
  const { def } = loadClient()
  const mod = def.factory(() => fakeReact())
  const { deleteButtonLabel } = mod.__test

  assert.equal(deleteButtonLabel(null, 'requirement', 'SPMS-1'), '删除')
  assert.equal(deleteButtonLabel({ kind: 'requirement', id: 'SPMS-1' }, 'requirement', 'SPMS-1'), '确认删除？')
  assert.equal(deleteButtonLabel({ kind: 'requirement', id: 'SPMS-1' }, 'requirement', 'SPMS-2'), '删除', '别的项不受影响')
  assert.equal(deleteButtonLabel({ kind: 'log', id: 7 }, 'requirement', 7), '删除', '类型不同也不误触发')
  assert.equal(deleteButtonLabel({ kind: 'log', id: 7 }, 'log', 7), '确认删除？')
})

test('候选箱不再被截断（原先 slice(0,8) 只剩 8 条 —— 用户实测反馈"展示不全"）', () => {
  const { def } = loadClient()
  const src = String(def.factory.toString())
  const markup = String(def.factory(() => fakeReact()).__test.renderPanel ?? '')
  const body = `${src}${markup}`
  assert.ok(!/discover\.items\.slice\(0, 8\)/.test(body), '不许再只渲染前 8 条')
  assert.ok(/只看有重复信号/.test(body), '要有"只看有重复信号"的筛选')
})

test('需求表单在两个 tab 都能看到（在历史需求 tab 点新建也要能填写）', () => {
  const { def } = loadClient()
  const body = String(def.factory.toString())
  assert.ok(/view === 'req' \|\| view === 'history'/.test(body), '表单渲染条件要含历史需求 tab')
  assert.ok(/const openReqForm = /.test(body), '打开表单时要切到需求台账 tab（双保险）')
})
