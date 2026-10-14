/**
 * 面板预览（开发/验收用，不进 npm 包）：
 *   把**真面板**（lib/client.js 的 Panel）在 Node 里跑起来，逐帧渲染成一张独立 HTML，用于人眼/UI 审计。
 *
 * 数据来源：默认从**本机正在跑的宿主**（http://127.0.0.1:19387）拉真数据（node 端 fetch，无 CORS 问题）；
 * 宿主没起时退回内置样例数据，照样能出图。
 *
 * 用法：node tools/panel-preview.mjs [输出文件]
 *   → 默认写 .scratch/panel-preview.html（用浏览器打开即可；也可交给 browser_* 工具截图）
 *   ⚠️ 产物含**真实台账数据**（内网 wiki 链接、本机路径）→ .scratch/ 已在 .gitignore 里，别提交。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFetchStub, mountPanel } from '../test/mini-react.js'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = process.argv[2] ?? join(here, '..', '.scratch', 'panel-preview.html')
const HOST = process.env.PROJECT_HUB_HOST ?? 'http://127.0.0.1:19387'

const SAMPLE = {
  '/status': { ok: true, counts: { requirements: 5, workLogs: 1022, scannedSessions: 633, archivedRequirements: 0 }, lastScanAt: Date.now() - 3600000, dbPath: '~/.dsh/project-hub/hub.db', lastScan: { changed: 12, skipped: 40, activities: 9, logs: 3, days: ['2026-10-14'], errors: 0 } },
  '/projects': { ok: true, candidates: [{ id: 'spms', name: 'spms' }, { id: 'hs-config', name: 'hs_config' }] },
  '/requirements/tags': { ok: true, tags: [{ tag: '历史导入', count: 3 }, { tag: '房态', count: 2 }] },
  '/requirements': {
    ok: true,
    total: 5,
    items: [
      { id: '5941', no: '5941', title: '【5941】团队分房', projectId: 'spms', projectName: 'spms', status: 'developing', priority: 'P1', tags: ['房态'], links: [{ id: 1, kind: 'doc', kindLabel: '需求文档', url: 'https://wiki.example/pages/viewpage.action?pageId=1', title: '需求说明书' }], projects: [{ projectId: 'spms', projectName: 'spms', platform: 'PC', primary: true }], lastWorkDate: '2026-10-13', workCount: 7 },
      { id: '5922', no: '5922', title: 'L&F Q3 Enhancements', projectId: 'hs-config', projectName: 'hs_config', status: 'testing', tags: [], links: [], projects: [], lastWorkDate: '2026-10-12', workCount: 3 },
    ],
  },
  '/logs': {
    ok: true,
    total: 1022,
    items: [
      { id: 1022, date: '2026-10-14', kind: 'bug', title: '修复 55036 分页越界', projectId: 'spms', projectName: 'spms', requirementId: '5941', minutes: 90, source: 'session-scan', detail: '列表第二页起 offset 算错' },
      { id: 1021, date: '2026-10-14', kind: 'dev', title: '项目管理插件：搜索/分页修复', projectId: 'dsh-github', projectName: 'dsh-github', source: 'manual' },
    ],
  },
  '/code/coverage': { ok: true, projects: [{ projectId: 'spms', indexed: true, coverage: 0.62 }] },
  '/discover': { ok: true, items: [], state: [], settings: { intervalMinutes: 1440 } },
  '/report': { ok: true, days: [{ date: '2026-10-14', msgs: 128, sessionCount: 3, logCount: 2, projects: [{ projectId: 'spms', projectName: 'spms', requirements: [{ id: '5941', title: '团队分房', msgs: 42 }] }] }], totals: { days: 38 } },
  '/drift': { ok: true, items: [{ id: '5941', verdict: 'work-since-doc', docAt: Date.now() - 86400000, workAt: Date.now() - 3600000 }] },
}

/** 真宿主优先，拿不到就退回样例（这样离线也能出图）。 */
function makeFetch() {
  const cache = new Map()
  let live = null
  const stub = async (url) => {
    const route = url.split('?')[0]
    if (live !== false) {
      if (live === null) {
        try {
          const probe = await fetch(`${HOST}/project-hub/api/status`)
          live = probe.ok
        } catch {
          live = false
        }
      }
      if (live) {
        const full = `${HOST}${url}`
        let payload
        if (cache.has(full)) payload = cache.get(full)
        else {
          payload = await (await fetch(full)).json()
          cache.set(full, payload)
        }
        return { json: async () => payload }
      }
    }
    return { json: async () => SAMPLE[route] ?? { ok: true, items: [] } }
  }
  stub.source = () => (live ? `live(${HOST})` : 'sample')
  return stub
}

// ── 元素树 → HTML（内联 style；只求视觉还原，不求交互）
const UNITLESS = new Set(['flex', 'flexGrow', 'flexShrink', 'opacity', 'zIndex', 'fontWeight', 'lineHeight', 'order'])
const VOID_TAGS = new Set(['input', 'br', 'img', 'hr'])
const css = (style) =>
  Object.entries(style ?? {})
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${typeof value === 'number' && !UNITLESS.has(key) ? `${value}px` : value}`)
    .join(';')
const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function toHtml(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (Array.isArray(node)) return node.map(toHtml).join('')
  const { type, props } = node
  if (typeof type === 'function') return '' // 已经展开过，不该出现
  const attrs = []
  if (props.className) attrs.push(`class="${esc(props.className)}"`)
  if (props.style) attrs.push(`style="${esc(css(props.style))}"`)
  if (props.title) attrs.push(`title="${esc(props.title)}"`)
  if (type === 'a') {
    attrs.push(`href="${esc(props.href ?? '#')}"`)
    if (props.target) attrs.push(`target="${esc(props.target)}"`)
  }
  if (type === 'input') {
    if (props.type) attrs.push(`type="${esc(props.type)}"`)
    if (props.placeholder) attrs.push(`placeholder="${esc(props.placeholder)}"`)
    if (props.value !== undefined && props.value !== null) attrs.push(`value="${esc(props.value)}"`)
    if (props.checked) attrs.push('checked')
    if (props.disabled) attrs.push('disabled')
    return `<input ${attrs.join(' ')}>`
  }
  if (props.disabled) attrs.push('disabled')
  const inner = toHtml(props.children)
  if (VOID_TAGS.has(type)) return `<${type} ${attrs.join(' ')}>`
  return `<${type} ${attrs.join(' ')}>${inner}</${type}>`
}

/** 跑一个场景：驱动交互后把当前帧渲染成 HTML 片段。 */
async function frame(stub, steps, label, options = {}) {
  const { mini, renderPanel, injectedStyles } = mountPanel(stub)
  const root = () => renderPanel({ sessionId: 'preview' })
  const settle = options.quietMs ?? 600
  await mini.act(root, null, { quietMs: settle })
  for (const step of steps ?? []) await mini.act(root, () => step(mini), { quietMs: settle })
  return {
    label,
    html: toHtml(mini.getTree()),
    styles: injectedStyles,
    texts: mini.texts(),
  }
}

/**
 * 让某个路由永远不返回（截「加载中」那一帧）。
 * ⚠️ 面板请求的 url 是 `/project-hub/api/...`，要比就比**去掉前缀和查询串**之后的路径。
 */
function withHang(stub, route) {
  return (url) => (url.replace('/project-hub/api', '').split('?')[0] === route ? new Promise(() => {}) : stub(url))
}

const stub = makeFetch()
const frames = []
frames.push(await frame(stub, [], '① 需求台账（默认：条件 + 查询 + 共 N 条 + 翻页）'))
frames.push(
  await frame(
    stub,
    [
      (mini) => mini.findButton('开发日志').props.onClick(),
      (mini) => mini.findInput('搜索记录').props.onChange({ target: { value: '分页' } }),
    ],
    '② 开发日志（关键词只进了输入框，还没点查询）',
  ),
)
frames.push(
  await frame(
    stub,
    [(mini) => mini.findButton('变更对账').props.onClick()],
    '③ 变更对账（/drift 不接受搜索条件 → 不再摆搜索框）',
  ),
)
frames.push(
  await frame(
    stub,
    [(mini) => mini.findButton('会话扫描').props.onClick()],
    '④ 会话扫描（条件即改即查，无「查询」按钮）',
  ),
)

frames.push(
  await frame(withHang(stub, '/logs'), [(mini) => mini.findButton('开发日志').props.onClick()], '⑤ 开发日志（请求挂起中：loading 文案 + 按钮变「加载中…」）', { quietMs: 120 }),
)

const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-project-hub 面板预览</title>
<style>
  body { margin: 0; padding: 18px; background: #101014; color: #e6e6e6; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  h2 { font-size: 13px; font-weight: 600; margin: 0 0 8px; opacity: .85; }
  .grid { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start; }
  .frame { width: 420px; }
  /* 侧边栏座位：宽 ~420px、高 ~760px，和宿主右侧边栏同量级 */
  /* 座位：宽 ~420 / 高 ~760，与宿主右侧边栏同量级；并给出宿主「浅色主题」的设计令牌，
     否则面板里 color:inherit 的文本会继承本页的浅色 → 白底浅字（那是预览页的问题，不是面板的）。 */
  .seat { width: 420px; height: 760px; display: flex; overflow: hidden; border-radius: 10px; border: 1px solid #2a2a2e;
    color: #1f1f23;
    --dsw-alias-text-1: #1f1f23; --dsw-alias-text-3: #6b6b73; --dsw-alias-text-4: #8b8b93;
    --dsw-alias-border-l1: #e4e4e8; --dsw-alias-border-l2: #d0d0d5;
    --dsw-alias-bg-1: rgba(0,0,0,.03); --dsw-alias-bg-2: rgba(0,0,0,.06); --dsw-alias-bg-layer-1: #ffffff;
    --dsw-alias-brand-1: #0071e3; --dsw-alias-brand-primary: #0071e3;
    --dsw-alias-success-1: #1a7f37; --dsw-alias-warning-1: #9a6700; --dsw-alias-danger-1: #cf222e; }
  .meta { font-size: 11px; opacity: .5; margin-top: 6px; }
  .rule { margin: 22px 0 10px; font-size: 11px; opacity: .5; }
</style>
<style>${frames[0].styles}</style>
</head><body>
<h1 style="font-size:15px;margin:0 0 4px">dsh-project-hub · 面板预览（数据源：${esc(stub.source())}）</h1>
<div class="meta">同一份 lib/client.js 真面板，在 Node 里用极简 hooks 运行时渲染；像素级位置以真实宿主为准，本页用于核对控件与文案。生成时间 ${new Date().toISOString()}</div>
<div class="grid">
${frames
  .map(
    (f) => `  <div class="frame"><h2>${esc(f.label)}</h2><div class="seat">${f.html}</div><div class="meta">${esc(f.texts.replaceAll('|', ' · ').slice(0, 200))}</div></div>`,
  )
  .join('\n')}
</div>
</body></html>`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, page)
console.log(`面板预览已生成：${OUT}`)
console.log(`数据源：${stub.source()}`)
for (const f of frames) console.log(`  - ${f.label}`)
