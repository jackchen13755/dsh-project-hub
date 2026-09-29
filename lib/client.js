/**
 * dsh-project-hub —— 客户端面板（Web UI 半边）。
 *
 * 交付形态与 DSH 约定一致（**无需构建**：手写 CJS 信封 + `require` 白名单模块）：
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 *
 * 座位：宿主**右侧边栏页签**（与 dsh-source-control / dsh-zentao-workbench 同款全链）：
 *   ① `ctx.inject(['sidebarRightTabs'])` → `tabs.register({ id, kind, title, guide })` 注册页签类型；
 *   ② `ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', …))` 注册页签主体；
 *   ③ `sidebar.right.pane.tab.title` 注册页签标题；
 *   ④ `sidebar.footer.action` 挂侧边栏底部入口按钮（点它把右侧边栏切到本插件）。
 * 三条纪律：`id`/`kind` 必须全局唯一（抢别人的 kind 会抛且带走同一轮后续注册）；
 * 读服务必须**按属性读**（`scoped.sidebarRightTabs`，`ctx.get` 对未 inject 的服务会抛）；
 * 只 register 不 `openTab` 时「页签在但没人看见」。
 *
 * 信息架构（**三个 tab 严格分开，不混在一起**）：
 *   · 需求台账 —— 只放需求：搜索/项目/归档筛选 + 需求卡片（各类链接可点多条）+ 新建/编辑需求
 *   · 开发日志 —— 只放记录：日期/类型/项目筛选 + 记录列表 + 新增/编辑/归档记录
 *   · 会话扫描 —— 只放扫描：扫描状态/按钮（增量、预览）+ 按天活动报表（哪天开发了哪些项目的哪些需求）
 *
 * 链接一律可点：卡片上的类别标签与每条链接、详情里的每条链接、表单里每一行 URL，
 * 都是可点开的 `<a target="_blank">`（表单行的 URL 输入框旁另给一个「↗」）。
 *
 * 样式走 `--dsw-alias-*` 设计令牌 + 一次性注入的 CSS 类（hover/过渡/焦点），深浅色自适应；
 * 内联（侧边栏）渲染约束：根节点 `flex:1 1 auto` 撑满座位、滚动区 `min-height:0`。
 */
window.__ModuleLoader__.load({
  id: 'dsh-project-hub',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/project-hub/api'
    const TYPE_ID = 'dsh-project-hub:panel'
    const KIND = 'dsh-project-hub:project'
    const STYLE_ID = 'dsh-project-hub-styles'
    const POLL_MS = 60000

    const TOKEN = {
      text: 'var(--dsw-alias-text-1, #e6e6e6)',
      dim: 'var(--dsw-alias-text-3, #9a9a9a)',
      faint: 'var(--dsw-alias-text-4, #7d7d7d)',
      border: 'var(--dsw-alias-border-l2, #333)',
      borderSoft: 'var(--dsw-alias-border-l1, rgba(127,127,127,.25))',
      hover: 'var(--dsw-alias-bg-2, rgba(127,127,127,.12))',
      panel: 'var(--dsw-alias-bg-1, rgba(127,127,127,.06))',
      accent: 'var(--dsw-alias-brand-1, #4d6bfe)',
      ok: 'var(--dsw-alias-success-1, #3fb950)',
      warn: 'var(--dsw-alias-warning-1, #d29922)',
      danger: 'var(--dsw-alias-danger-1, #f85149)',
      ui: '#c678dd',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      // 兼容别名：文字一律继承主题，别再写死颜色（浅色主题下会看不清）
      text: 'inherit',
      dim: 'inherit',
      faint: 'inherit',
    }

    const KINDS = ['dev', 'bug', 'doc', 'review', 'meeting', 'release', 'other']
    const KIND_LABEL = { dev: '开发', bug: '缺陷', doc: '文档', review: '评审', meeting: '会议', release: '发布', other: '其它' }
    const KIND_COLOR = { dev: TOKEN.accent, bug: TOKEN.danger, doc: TOKEN.ok, review: TOKEN.warn, meeting: TOKEN.warn, release: TOKEN.ok, other: 'inherit' }
    const STATUS_LABEL = {
      draft: '草稿',
      planning: '规划中',
      developing: '开发中',
      testing: '测试中',
      released: '已完成',
      paused: '暂停',
      dropped: '废弃',
    }
    const STATUS_COLOR = { draft: 'inherit', planning: 'inherit', developing: TOKEN.accent, testing: TOKEN.warn, released: TOKEN.ok, paused: TOKEN.warn, dropped: 'inherit' }
    /** 链接类型（每类都可以有多条）与显示名/配色。 */
    const LINK_LABEL = { doc: '需求文档', wbs: 'WBS', design: '后端设计', ui: 'UI 设计', other: '其它' }
    const LINK_COLOR = { doc: TOKEN.accent, wbs: TOKEN.ok, design: TOKEN.warn, ui: TOKEN.ui, other: 'inherit' }
    const LINK_FORM_KINDS = ['doc', 'wbs', 'design', 'ui']
    const LINK_ORDER = ['doc', 'wbs', 'design', 'ui', 'other']
    /** 三个 tab：需求台账 / 开发日志 / 会话扫描 —— 各自独立，内容不混。 */
    const TABS = [
      ['req', '需求台账'],
      ['logs', '开发日志'],
      ['scan', '会话扫描'],
    ]

    /**
     * 项目配色：**同一个项目永远同一个颜色**（对 id 做稳定哈希取色），不同项目基本不同色。
     * 色板挑的是浅色/深色主题下都读得清的中间调。
     */
    const PROJECT_PALETTE = [
      '#3b82f6',
      '#8b5cf6',
      '#ec4899',
      '#f59e0b',
      '#10b981',
      '#06b6d4',
      '#ef4444',
      '#84cc16',
      '#f97316',
      '#14b8a6',
      '#a855f7',
      '#eab308',
    ]

    function projectColor(key) {
      const text = String(key ?? '')
      if (!text) return 'inherit'
      let hash = 0
      for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 1000003
      return PROJECT_PALETTE[hash % PROJECT_PALETTE.length]
    }

    /**
     * 从文档标题里认需求号（与宿主 `lib/req-no.js` 同一套规则，客户端 bundle 不能 import 宿主模块，
     * 所以这里是有意为之的镜像实现）。例：`【5922】L&F Q3 Enhancements/Queue数据记录` → `5922`。
     * 保守策略：纯数字只在首位且后面跟分隔符时才算，4 位落在 1900–2099 的当成年份不算。
     */
    function extractNoFromTitle(title) {
      const text = String(title ?? '').trim()
      if (!text) return null
      const yearLike = (v) => v.length === 4 && Number(v) >= 1900 && Number(v) <= 2099
      for (const re of [/【\s*(\d{1,8})\s*】/, /\[\s*(\d{1,8})\s*\]/, /（\s*(\d{1,8})\s*）/, /\(\s*(\d{1,8})\s*\)/]) {
        const m = text.match(re)
        if (m) return m[1]
      }
      const prefixed = text.match(/\b([A-Za-z][A-Za-z0-9_]{1,15})-(\d{1,8})\b/)
      if (prefixed) return prefixed[2]
      const hashed = text.match(/#\s*(\d{1,8})\b/)
      if (hashed && !yearLike(hashed[1])) return hashed[1]
      const leading = text.match(/^(\d{2,8})(?=\s|[-_.、,，:：]|$)/)
      if (leading && !yearLike(leading[1])) return leading[1]
      return null
    }

    /** 需求状态的正式取值顺序（下拉用；与宿主 store 的 REQ_STATUSES 对齐）。 */
    const REQ_STATUS_KEYS = ['draft', 'planning', 'developing', 'testing', 'released', 'paused', 'dropped']

    /** 开新会话时要不要自动置「开发中」：已经在开发中就不动，避免无意义的写。 */
    function shouldMarkDeveloping(current) {
      return String(current ?? '') !== 'developing'
    }

    /** 两段确认的删除按钮文案：pending 命中当前项 → 「确认删除？」，否则「删除」。 */
    function deleteButtonLabel(pending, kind, id) {
      return pending && pending.kind === kind && pending.id === id ? '确认删除？' : '删除'
    }

    // ── 标签：解析 / 追加 / 补全建议（纯函数，便于测试）────────────────────

    /** 输入框里的标签文本 → 数组（中英文逗号都认，去空去重）。 */
    function parseTagInput(text) {
      const out = []
      for (const raw of String(text ?? '').split(/[,，]/)) {
        const item = raw.trim()
        if (item && !out.includes(item)) out.push(item)
      }
      return out
    }

    /** 追加一个标签到输入框文本（已存在就原样返回，不重复）。 */
    function addTagToText(text, tag) {
      const value = String(tag ?? '').trim()
      if (!value) return String(text ?? '')
      const current = parseTagInput(text)
      if (current.includes(value)) return current.join(', ')
      return [...current, value].join(', ')
    }

    /**
     * 输入补全建议：排除已经打过的、排除看着像 URL 的
     * （实测有人会把设计稿链接贴进「标签」框），按使用次数降序，最多 limit 个。
     */
    function tagSuggestions(options, text, opts) {
      const limit = (opts && opts.limit) || 12
      const used = new Set(parseTagInput(text))
      return (options ?? [])
        .filter((item) => item && item.tag && !used.has(String(item.tag)))
        .filter((item) => {
          const tag = String(item.tag)
          return tag.length <= 32 && !tag.includes('://') && !/^https?:/i.test(tag)
        })
        .slice()
        .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || (String(a.tag) < String(b.tag) ? -1 : String(a.tag) > String(b.tag) ? 1 : 0))
        .slice(0, limit)
    }

    const S = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, flex: '1 1 auto', fontSize: 12, lineHeight: 1.6, color: TOKEN.text, background: 'transparent' },
      header: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px 6px', flexWrap: 'wrap' },
      tabs: { display: 'flex', gap: 4, padding: '0 10px', borderBottom: `1px solid ${TOKEN.borderSoft}` },
      toolbar: { display: 'flex', gap: 4, padding: '6px 10px', flexWrap: 'wrap', alignItems: 'center', position: 'sticky', top: 0, zIndex: 2, borderBottom: `1px solid ${TOKEN.borderSoft}` },
      body: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '8px 10px 18px' },
      card: { border: `1px solid ${TOKEN.borderSoft}`, borderRadius: 8, padding: '8px 10px', marginBottom: 6, background: TOKEN.panel },
      row: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      dim: { opacity: 0.75 },
      faint: { opacity: 0.55, fontSize: 11 },
      mono: { fontFamily: TOKEN.mono },
      input: { border: `1px solid ${TOKEN.border}`, background: 'transparent', color: TOKEN.text, borderRadius: 6, padding: '3px 7px', fontSize: 12, minWidth: 0, outline: 'none' },
      button: { border: `1px solid ${TOKEN.border}`, background: 'transparent', color: TOKEN.text, borderRadius: 6, padding: '2px 8px', fontSize: 12, cursor: 'pointer' },
      buttonPrimary: { border: `1px solid ${TOKEN.accent}`, background: 'transparent', color: TOKEN.accent, borderRadius: 6, padding: '2px 8px', fontSize: 12, cursor: 'pointer' },
      pre: { margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.75, fontSize: 11 },
      stat: { border: `1px solid ${TOKEN.borderSoft}`, borderRadius: 8, padding: '6px 8px', minWidth: 62, flex: '1 1 62px' },
      statValue: { fontSize: 15, fontWeight: 600 },
      empty: { border: `1px dashed ${TOKEN.borderSoft}`, borderRadius: 8, padding: '14px 10px', textAlign: 'center', opacity: 0.75 },
      section: { marginTop: 10, marginBottom: 4, opacity: 0.65, fontSize: 11, letterSpacing: '.03em' },
      link: { color: TOKEN.accent, textDecoration: 'none', cursor: 'pointer' },
    }

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = [
        `.dsh-ph-btn:hover:not(:disabled) { background: ${TOKEN.hover}; }`,
        '.dsh-ph-btn:disabled { opacity: .5; cursor: default; }',
        '.dsh-ph-card { transition: border-color .12s ease, box-shadow .12s ease; }',
        `.dsh-ph-card:hover { border-color: ${TOKEN.border}; box-shadow: 0 1px 6px rgba(0,0,0,.10); }`,
        `.dsh-ph-tab { border: 1px solid transparent; border-bottom: 2px solid transparent; border-radius: 6px 6px 0 0; background: transparent; color: inherit; opacity: .72; padding: 5px 10px; font-size: 12px; cursor: pointer; }`,
        `.dsh-ph-tab:hover { opacity: 1; background: ${TOKEN.hover}; }`,
        `.dsh-ph-tab-active { color: inherit; opacity: 1; border-bottom-color: ${TOKEN.accent}; font-weight: 600; }`,
        `.dsh-ph-input:focus { border-color: ${TOKEN.accent}; }`,
        '.dsh-ph-link:hover { text-decoration: underline; }',
        `.dsh-ph-scroll::-webkit-scrollbar { width: 8px; }`,
        `.dsh-ph-scroll::-webkit-scrollbar-thumb { background: ${TOKEN.border}; border-radius: 4px; }`,
        `.dsh-ph-pill { display: inline-flex; align-items: center; gap: 3px; border: 1px solid ${TOKEN.borderSoft}; border-radius: 999px; padding: 0 7px; font-size: 11px; line-height: 18px; color: inherit; opacity: .85; text-decoration: none; }`,
        `a.dsh-ph-pill:hover { background: ${TOKEN.hover}; }`,
      ].join('\n')
      const head = document.head ?? (typeof document.getElementsByTagName === 'function' ? document.getElementsByTagName('head')[0] : null)
      if (head && typeof head.appendChild === 'function') head.appendChild(style)
    }

    /** 同源请求；任何失败都抛出带可读信息的 Error（调用方负责显示）。 */
    async function api(path, options) {
      const opts = options ?? {}
      const res = await fetch(API + path, {
        method: opts.method ?? 'GET',
        headers: opts.body ? { 'content-type': 'application/json' } : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      })
      let payload = null
      try {
        payload = await res.json()
      } catch (e) {
        throw new Error(`路由返回的不是 JSON（HTTP ${res.status}）`)
      }
      if (!payload || payload.ok === false) throw new Error((payload && payload.error) || `请求失败（HTTP ${res.status}）`)
      return payload
    }

    function scopeQuery(extra, sessionId) {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(extra ?? {})) {
        if (value === null || value === undefined || value === '') continue
        params.set(key, String(value))
      }
      if (sessionId) params.set('sessionId', sessionId)
      const text = params.toString()
      return text ? `?${text}` : ''
    }

    function fmtTime(ms) {
      if (!ms) return '-'
      try {
        return new Date(Number(ms)).toLocaleString('zh-CN', { hour12: false })
      } catch (e) {
        return String(ms)
      }
    }

    function fmtRelative(ms) {
      if (!ms) return '从未'
      const diff = Date.now() - Number(ms)
      if (diff < 60000) return '刚刚'
      if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟前`
      if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`
      return `${Math.round(diff / 86400000)} 天前`
    }

    /** HH:MM:SS（页头「xx 更新」用） */
    function fmtClock(ts) {
      if (!ts) return ''
      const d = new Date(ts)
      const p2 = (v) => String(v).padStart(2, '0')
      return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
    }

    function today() {
      const d = new Date()
      const mm = String(d.getMonth() + 1).padStart(2, '0')
      const dd = String(d.getDate()).padStart(2, '0')
      return `${d.getFullYear()}-${mm}-${dd}`
    }

    const Pill = (props) => h('span', { className: 'dsh-ph-pill', style: props.color ? { color: props.color, borderColor: props.color } : null, title: props.title ?? undefined }, props.children)

    /** 可点的胶囊（整颗胶囊就是一个链接）——「链接都需要可点」的兜底做法。 */
    const LinkPill = (props) =>
      props.href
        ? h(
            'a',
            { className: 'dsh-ph-pill dsh-ph-link', style: props.color ? { color: props.color, borderColor: props.color } : null, href: props.href, target: '_blank', rel: 'noreferrer', title: props.title ?? props.href },
            props.children,
          )
        : h(Pill, { color: props.color, title: props.title }, props.children)

    const LinkText = (props) =>
      h(
        'a',
        { className: 'dsh-ph-link', style: { ...S.link, ...(props.style ?? {}) }, href: props.href, target: '_blank', rel: 'noreferrer', title: props.title ?? props.href },
        props.children,
      )

    function Field(props) {
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, opacity: 0.72, minWidth: 0 } },
        props.label,
        props.children,
      )
    }

    function Btn(props) {
      const style = { ...(props.primary ? S.buttonPrimary : S.button), ...(props.style ?? {}) }
      return h('button', { className: 'dsh-ph-btn', style, disabled: props.disabled, title: props.title ?? undefined, onClick: props.onClick }, props.children)
    }

    function Notice(props) {
      if (!props.notice) return null
      const color = props.notice.kind === 'error' ? TOKEN.danger : TOKEN.ok
      return h(
        'div',
        { style: { margin: '6px 10px 0', padding: '5px 8px', borderRadius: 6, fontSize: 12, border: `1px solid ${color}`, color, display: 'flex', gap: 8, alignItems: 'flex-start' } },
        h('span', { style: { flex: 1, wordBreak: 'break-word' } }, props.notice.text),
        h('button', { className: 'dsh-ph-btn', style: { ...S.button, border: 'none', padding: '0 4px' }, onClick: props.onClose }, '×'),
      )
    }

    function Empty(props) {
      return h('div', { style: S.empty }, h('div', null, props.text), props.hint ? h('div', { style: { ...S.faint, marginTop: 4 } }, props.hint) : null, props.action ?? null)
    }

    /** 面板级提示通道：深层组件（详情/表单）复制成功后也能弹提示。 */
    let notifyRef = () => {}

    /** 复制一段文本到剪贴板；返回是否成功（失败时由调用方把内容显示出来）。 */
    async function copyText(text) {
      try {
        const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null
        if (clipboard && typeof clipboard.writeText === 'function') {
          await clipboard.writeText(String(text))
          return true
        }
      } catch (e) {
        /* 下面还有兜底 */
      }
      return false
    }

    /** 链接的短标签：不铺全量 URL，只给「主机名/…/末段」。 */
    function shortUrlLabel(url) {
      const raw = String(url ?? '')
      try {
        const parsed = new URL(raw)
        const tail = parsed.pathname.split('/').filter(Boolean).slice(-1)[0] ?? ''
        const label = `${parsed.hostname}${tail ? `/…/${tail}` : ''}`
        return label.length > 44 ? `${label.slice(0, 43)}…` : label
      } catch (e) {
        return raw.length > 44 ? `${raw.slice(0, 43)}…` : raw
      }
    }

    /** 小小的「复制」按钮：复制成功弹一句提示，失败就把内容显示出来让用户自己拷。 */
    function CopyBtn(props) {
      const [done, setDone] = useState(false)
      const value = String(props.value ?? '')
      return h(
        'button',
        {
          className: 'dsh-ph-btn',
          style: { ...S.button, padding: '0 6px', ...(props.style ?? {}) },
          title: props.title ?? `复制：${value}`,
          disabled: props.disabled || !value,
          onClick: async () => {
            const okCopy = await copyText(value)
            if (okCopy) {
              setDone(true)
              setTimeout(() => setDone(false), 1200)
              notifyRef(props.doneText ?? '已复制到剪贴板')
            } else {
              notifyRef(`复制失败，链接是：${value}`)
            }
          },
        },
        done ? '已复制' : (props.label ?? '复制'),
      )
    }

    /**
     * 需求卡片上的链接：**每类只给一颗可点的胶囊**（点开该类第 1 条），
     * 不铺全量 URL/多条链接 —— 逐条查看与复制放到「详情」里。
     * 老数据（只有单值列、links 为空）回落到 docUrl/wbsUrl/designUrl/uiUrl。
     */
    function renderLinkChips(links, req) {
      const groups = new Map()
      for (const link of links ?? []) {
        if (!groups.has(link.kind)) groups.set(link.kind, [])
        groups.get(link.kind).push(link)
      }
      if (groups.size === 0 && req) {
        const legacy = [
          ['doc', req.docUrl, req.docTitle],
          ['wbs', req.wbsUrl, req.wbsNote],
          ['design', req.designUrl, req.designNote],
          ['ui', req.uiUrl, req.uiNote],
        ].filter(([, url]) => url)
        for (const [kind, url, title] of legacy) groups.set(kind, [{ kind, kindLabel: LINK_LABEL[kind], url, title }])
      }
      const out = []
      for (const kind of LINK_ORDER) {
        const rows = groups.get(kind)
        if (!rows || rows.length === 0) continue
        const color = LINK_COLOR[kind] ?? 'inherit'
        const label = rows[0].kindLabel ?? LINK_LABEL[kind]
        out.push(
          h(
            LinkPill,
            {
              key: `k-${kind}`,
              color,
              href: rows[0].url,
              title: rows.length > 1 ? `${label}共 ${rows.length} 条 —— 点开第 1 条；其余在「详情」里` : `${label}：${rows[0].url}`,
            },
            `${label}${rows.length > 1 ? ` ${rows.length}` : ''}`,
          ),
        )
        // 单条时顺手给个复制；多条时统一去详情里复制（避免卡片上按钮打架）
        if (rows.length === 1) {
          out.push(h(CopyBtn, { key: `c-${kind}`, value: rows[0].url, label: '⧉', style: { padding: '0 5px', marginRight: 6 }, doneText: `已复制${label}链接` }))
        }
      }
      return out
    }

    // ────────────────────────────────────────────────────────────── 主面板

    function Panel(props) {
      const sessionId = props.sessionId ?? null
      const [status, setStatus] = useState(null)
      const [candidates, setCandidates] = useState([])
      const [view, setView] = useState('req')
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)
      const [q, setQ] = useState('')
      const [project, setProject] = useState('')
      const [from, setFrom] = useState('')
      const [to, setTo] = useState('')
      const [kind, setKind] = useState('')
      const [showArchived, setShowArchived] = useState(false)
      /** 标签筛选（'' = 全部）：工具栏下拉选，或点卡片上的 #标签 直接筛。 */
      const [tag, setTag] = useState('')
      /** 台账里用过的标签 + 条数：下拉选项与表单输入补全共用同一份。 */
      const [tagOptions, setTagOptions] = useState([])
      const [result, setResult] = useState({ requirements: [], logs: [] })
      const [report, setReport] = useState({ days: [], totals: null })
      const [detail, setDetail] = useState(null)
      const [reqForm, setReqForm] = useState(null)
      const [logForm, setLogForm] = useState(null)
      /** 归档视图里的「删除」是两段确认：第一次点变成「确认删除？」，再点才真删（不可恢复）。 */
      const [pendingDelete, setPendingDelete] = useState(null)
      /** 最近一次成功刷新数据的时间（页头显示，让人看得出「刷新」真的生效了）。 */
      const [lastLoadedAt, setLastLoadedAt] = useState(null)
      /** 当前展开的详情 id（刷新时用它把详情也拉一遍，避免出现「列表新、详情旧」）。 */
      const detailRef = useRef(null)
      const alive = useRef(true)
      useEffect(() => {
        detailRef.current = detail?.id ?? null
      }, [detail])

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const reportError = useCallback((error) => setNotice({ kind: 'error', text: error && error.message ? error.message : String(error) }), [])
      const ok = useCallback((text) => setNotice({ kind: 'ok', text }), [])
      // 深层组件（详情/表单里的复制按钮）通过这个通道弹提示
      useEffect(() => {
        notifyRef = (text) => ok(text)
        return () => {
          notifyRef = () => {}
        }
      }, [ok])

      const loadStatus = useCallback(async () => {
        try {
          const payload = await api(`/status${scopeQuery({}, sessionId)}`)
          if (alive.current) setStatus(payload)
        } catch (error) {
          if (alive.current) reportError(error)
        }
      }, [sessionId, reportError])

      const loadProjects = useCallback(async () => {
        try {
          const payload = await api(`/projects${scopeQuery({}, sessionId)}`)
          if (alive.current) setCandidates(payload.candidates ?? [])
        } catch (error) {
          if (alive.current) reportError(error)
        }
      }, [sessionId, reportError])

      /** 需求台账 tab 只拉需求；开发日志 tab 只拉记录 —— 两个 tab 的数据不混。 */
      const loadTab = useCallback(async () => {
        try {
          if (view === 'scan') {
            const payload = await api(`/report${scopeQuery({ project, from, to, limit: 31 }, sessionId)}`)
            if (alive.current) setReport({ days: payload.days ?? [], totals: payload.totals ?? null })
            return
          }
          if (view === 'req') {
            const payload = await api(
              `/requirements${scopeQuery({ q, project, tag, archived: showArchived ? 'only' : 'exclude', limit: 60 }, sessionId)}`,
            )
            if (alive.current) setResult((prev) => ({ ...prev, requirements: payload.items ?? [] }))
            // 标签清单跟着同一套筛选口径走（归档视图里也能筛归档项的标签）
            try {
              const tagPayload = await api(`/requirements/tags${scopeQuery({ project, archived: showArchived ? 'only' : 'exclude' }, sessionId)}`)
              if (alive.current) setTagOptions(tagPayload.tags ?? [])
            } catch (error) {
              /* 标签清单拿不到不影响列表 */
            }
            return
          }
          const payload = await api(
            `/logs${scopeQuery({ q, project, from, to, kind, archived: showArchived ? 'only' : 'exclude', limit: 60 }, sessionId)}`,
          )
          if (alive.current) setResult((prev) => ({ ...prev, logs: payload.items ?? [] }))
        } catch (error) {
          if (alive.current) reportError(error)
        }
      }, [from, kind, project, q, sessionId, showArchived, view, reportError])

      useEffect(() => {
        void loadStatus()
        void loadProjects()
      }, [loadStatus, loadProjects])

      useEffect(() => {
        void loadTab()
      }, [loadTab])

      useEffect(() => {
        if (sessionId) return undefined
        const timer = window.setInterval(() => {
          void loadStatus()
          void loadTab()
        }, POLL_MS)
        return () => window.clearInterval(timer)
      }, [loadStatus, loadTab, sessionId])

      const run = useCallback(
        async (label, fn) => {
          setBusy(true)
          try {
            const text = await fn()
            if (text) ok(text)
          } catch (error) {
            reportError(error)
          } finally {
            if (alive.current) setBusy(false)
          }
        },
        [ok, reportError],
      )

      const reload = useCallback(
        async (text) => {
          await loadStatus()
          await loadProjects()
          await loadTab()
          // 打开中的详情也跟着刷新（否则卡片刷新了、展开的记录还是旧的）
          const openId = detailRef.current
          if (openId) {
            try {
              const payload = await api(`/requirements/get${scopeQuery({ id: openId }, sessionId)}`)
              if (alive.current && payload?.requirement) setDetail({ id: openId, requirement: payload.requirement, logs: payload.logs ?? [], days: payload.days ?? [] })
            } catch (error) {
              /* 详情拉不到不影响主列表 */
            }
          }
          if (alive.current) setLastLoadedAt(Date.now())
          return text ?? null
        },
        [loadProjects, loadStatus, loadTab, sessionId],
      )

      const scan = (dryRun) =>
        run('扫描会话', async () => {
          const payload = await api('/scan', { method: 'POST', body: { limit: 300, dryRun: Boolean(dryRun) } })
          await reload()
          const head = dryRun ? '扫描预览（未写库）' : '扫描完成'
          const verb = dryRun ? '将会写入' : '写入'
          return `${head}：${payload.changed} 个会话有变更，跳过 ${payload.skipped}，${verb}活动 ${payload.activities} 条 / 记录 ${payload.logs} 条，覆盖 ${(payload.days ?? []).length} 天`
        })

      const openDetail = (id) =>
        run('读取需求', async () => {
          const payload = await api(`/requirements/get${scopeQuery({ id }, sessionId)}`)
          if (alive.current) setDetail({ id, requirement: payload.requirement, logs: payload.logs ?? [], days: payload.days ?? [] })
          return null
        })

      const editRequirement = (id) =>
        run('载入需求', async () => {
          const payload = await api(`/requirements/get${scopeQuery({ id }, sessionId)}`)
          const req = payload.requirement ?? {}
          const grouped = { doc: [], wbs: [], design: [], ui: [] }
          for (const link of req.links ?? []) {
            const key = LINK_FORM_KINDS.includes(link.kind) ? link.kind : 'doc'
            grouped[key].push({ url: link.url, title: link.title ?? '', note: link.note ?? '' })
          }
          setReqForm({
            mode: 'edit',
            key: `edit-${id}-${Date.now()}`,
            initial: {
              id: req.id,
              no: req.no ?? '',
              title: req.title ?? '',
              project: req.projectId ?? '',
              status: req.status ?? 'developing',
              priority: req.priority ?? '',
              tags: (req.tags ?? []).join(','),
              links: grouped,
            },
          })
          setView('req')
          return `已把 ${req.id} 载入表单，改完点「保存修改」`
        })

      const archiveRequirement = (id, archived) =>
        run('归档需求', async () => {
          await api('/requirements/archive', { method: 'POST', body: { id, archived } })
          await reload()
          return `${archived ? '已归档' : '已恢复'}需求 ${id}`
        })

      /** 卡片上直接切状态（不动标题/链接，走轻量的 /requirements/status）。 */
      const applyStatus = (r, next) =>
        run('改状态', async () => {
          const payload = await api('/requirements/status', { method: 'POST', body: { id: r.id, status: next } })
          await reload()
          return `${r.id} 状态 → ${STATUS_LABEL[payload.requirement?.status ?? next] ?? next}`
        })

      /**
       * 开新会话：先把状态置为「开发中」（已在开发中就不动），再在项目工作区开会话并投喂需求简报。
       * 顺序有讲究：先改状态 —— 即便开会话失败，状态也已经是对的。
       */
      const openSession = (r) =>
        run('开新会话', async () => {
          let statusNote = ''
          if (shouldMarkDeveloping(r.status)) {
            const changed = await api('/requirements/status', { method: 'POST', body: { id: r.id, status: 'developing' } })
            statusNote = `；状态 → ${STATUS_LABEL[changed.requirement?.status ?? 'developing'] ?? '开发中'}`
          }
          const message = await openRequirementSession(r.id)
          await reload()
          return `${message}${statusNote}`
        })

      /**
       * 彻底删除（不可恢复）：归档视图里才给按钮。
       * 两段确认 —— 第一次点变成「确认删除？」，再点一次才真删；点了别处/换视图即作废。
       */
      const deleteFlowNext = (current, kind, id) => (current && current.kind === kind && current.id === id ? null : { kind, id })
      const askDelete = (kind, id) => {
        if (pendingDelete && pendingDelete.kind === kind && pendingDelete.id === id) {
          void doDelete(kind, id)
          return
        }
        setPendingDelete({ kind, id })
      }
      const doDelete = (kind, id) =>
        run('删除', async () => {
          const path = kind === 'requirement' ? '/requirements/delete' : '/logs/delete'
          await api(path, { method: 'POST', body: { id } })
          setPendingDelete(null)
          if (kind === 'requirement' && detail && detail.id === id) setDetail(null)
          await reload()
          return `已彻底删除${kind === 'requirement' ? '需求' : '记录'} ${kind === 'requirement' ? id : `#${id}`}（不可恢复）`
        })
      const deleteButton = (kind, id) => {
        const armed = Boolean(pendingDelete && pendingDelete.kind === kind && pendingDelete.id === id)
        return h(
          Btn,
          {
            disabled: busy,
            style: armed ? { borderColor: TOKEN.danger, color: TOKEN.danger, fontWeight: 600 } : { color: TOKEN.danger },
            title: armed ? '再点一次就彻底删除（不可恢复）' : '彻底删除（不可恢复）；归档项才显示这个按钮',
            onClick: () => askDelete(kind, id),
          },
          deleteButtonLabel(pendingDelete, kind, id),
        )
      }

      const archiveLog = (id, archived) =>
        run('归档记录', async () => {
          await api('/logs/archive', { method: 'POST', body: { id, archived } })
          await reload()
          return `${archived ? '已归档' : '已恢复'}记录 #${id}`
        })

      const projectOptions = candidates
      const counts = status?.counts ?? {}

      const header = h(
        'div',
        { style: S.header },
        h('strong', { style: { fontSize: 13 } }, '📋 项目管理'),
        status ? h(Pill, { title: '需求条数（含归档）' }, `需求 ${counts.requirements ?? 0}${counts.archivedRequirements ? ` +${counts.archivedRequirements}` : ''}`) : h('span', { style: S.dim }, '加载中…'),
        status ? h(Pill, { title: '开发记录条数' }, `记录 ${counts.workLogs ?? 0}`) : null,
        status ? h(Pill, { title: '已扫描的会话数' }, `会话 ${counts.scannedSessions ?? 0}`) : null,
        status ? h('span', { style: S.faint, title: status.dbPath }, `上次扫描 ${fmtRelative(status.lastScanAt)}`) : null,
        h('span', { style: { flex: 1 } }),
        h(
          Btn,
          {
            disabled: busy,
            primary: true,
            onClick: () => void run('刷新', () => reload('已刷新（状态 + 当前 tab + 展开的详情）')),
            title: lastLoadedAt ? `重新拉取最新数据（上次刷新 ${fmtClock(lastLoadedAt)}）` : '重新拉取最新数据',
          },
          busy ? '刷新中…' : '⟳ 刷新',
        ),
        lastLoadedAt ? h('span', { style: { ...S.faint, whiteSpace: 'nowrap' }, title: '数据刷新时间' }, `${fmtClock(lastLoadedAt)} 更新`) : null,
      )

      const tabs = h(
        'div',
        { style: S.tabs },
        ...TABS.map(([key, label]) =>
          h(
            'button',
            { key, className: `dsh-ph-tab${view === key ? ' dsh-ph-tab-active' : ''}`, onClick: () => setView(key) },
            key === 'req' ? `${label}${result.requirements.length ? ` ${result.requirements.length}` : ''}` : key === 'logs' ? `${label}${result.logs.length ? ` ${result.logs.length}` : ''}` : label,
          ),
        ),
      )

      const toolbar =
        view === 'scan'
          ? h(
              'div',
              { style: S.toolbar },
              h(
                'select',
                { className: 'dsh-ph-input', style: S.input, value: project, onChange: (e) => setProject(e.target.value) },
                h('option', { value: '' }, '全部项目'),
                ...projectOptions.map((p) => h('option', { key: p.id, value: p.id }, p.name ? `${p.name}（${p.id}）` : p.id)),
              ),
              h('input', { className: 'dsh-ph-input', type: 'date', style: S.input, value: from, onChange: (e) => setFrom(e.target.value), title: '起始日期' }),
              h('span', { style: S.dim }, '→'),
              h('input', { className: 'dsh-ph-input', type: 'date', style: S.input, value: to, onChange: (e) => setTo(e.target.value), title: '结束日期' }),
              h('span', { style: { flex: 1 } }),
              h(Btn, { primary: true, disabled: busy, onClick: () => void scan(false) }, '立即增量扫描'),
              h(Btn, { disabled: busy, onClick: () => void scan(true), title: '只报告会写入多少，不动库' }, '预览'),
              h(Btn, { disabled: busy, onClick: () => void loadTab() }, '刷新报表'),
            )
          : h(
              'div',
              { style: S.toolbar },
              h('input', {
                className: 'dsh-ph-input',
                style: { ...S.input, flex: '1 1 130px' },
                placeholder: view === 'logs' ? '搜索记录标题 / 详情 / 需求号…' : '搜索需求 ID / 标题 / 文档标题 / 标签…',
                value: q,
                onChange: (e) => setQ(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') void loadTab()
                },
              }),
              h(
                'select',
                { className: 'dsh-ph-input', style: S.input, value: project, onChange: (e) => setProject(e.target.value) },
                h('option', { value: '' }, '全部项目'),
                ...projectOptions.map((p) => h('option', { key: p.id, value: p.id }, p.name ? `${p.name}（${p.id}）` : p.id)),
              ),
              view === 'logs'
                ? h(
                    'span',
                    { style: { display: 'flex', gap: 4, alignItems: 'center' } },
                    h('input', { className: 'dsh-ph-input', type: 'date', style: S.input, value: from, onChange: (e) => setFrom(e.target.value), title: '起始日期' }),
                    h('span', { style: S.dim }, '→'),
                    h('input', { className: 'dsh-ph-input', type: 'date', style: S.input, value: to, onChange: (e) => setTo(e.target.value), title: '结束日期' }),
                    h(
                      'select',
                      { className: 'dsh-ph-input', style: S.input, value: kind, onChange: (e) => setKind(e.target.value) },
                      h('option', { value: '' }, '全部类型'),
                      ...KINDS.map((k) => h('option', { key: k, value: k }, KIND_LABEL[k] ?? k)),
                    ),
                  )
                : null,
              // 标签筛选（只对需求台账有意义）：选项来自 /requirements/tags，带条数
              view === 'req'
                ? h(
                    'select',
                    {
                      className: 'dsh-ph-input',
                      style: { ...S.input, maxWidth: 168 },
                      value: tag,
                      title: '按标签筛选：只看打了这个标签的需求',
                      onChange: (e) => setTag(e.target.value),
                    },
                    h('option', { value: '' }, tagOptions.length ? `全部标签（${tagOptions.length}）` : '全部标签'),
                    ...tagOptions.map((item) => h('option', { key: item.tag, value: item.tag }, `#${item.tag} (${item.count})`)),
                  )
                : null,
              tag
                ? h(
                    'button',
                    {
                      className: 'dsh-ph-btn',
                      style: { ...S.button, borderColor: TOKEN.accent, color: TOKEN.accent },
                      title: '清除标签筛选',
                      onClick: () => setTag(''),
                    },
                    `#${tag}　×`,
                  )
                : null,
              h(
                'label',
                { style: { ...S.dim, display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 } },
                h('input', { type: 'checkbox', checked: showArchived, onChange: (e) => setShowArchived(e.target.checked) }),
                '只看已归档',
              ),
              h(Btn, { disabled: busy, onClick: () => void loadTab() }, '查询'),
              h(
                Btn,
                {
                  disabled: busy,
                  onClick: () => {
                    setQ('')
                    setProject('')
                    setFrom('')
                    setTo('')
                    setKind('')
                    setShowArchived(false)
                  },
                },
                '重置',
              ),
              h('span', { style: { flex: 1 } }),
              view === 'req'
                ? h(Btn, { primary: true, disabled: busy, onClick: () => setReqForm({ mode: 'create', key: `new-${Date.now()}`, initial: null }) }, '＋ 需求')
                : h(Btn, { primary: true, disabled: busy, onClick: () => setLogForm({ mode: 'create', key: `new-log-${Date.now()}`, initial: null }) }, '＋ 记录'),
            )

      // ── 会话扫描 tab（只放扫描相关：状态 + 按钮 + 按天报表）
      const scanView = () => {
        const last = status?.lastScan ?? null
        const stats = [
          ['会话文件', last?.files ?? '-'],
          ['本次变更', last?.changed ?? '-'],
          ['跳过', last?.skipped ?? '-'],
          ['写入活动', last?.activities ?? '-'],
          ['新增记录', last?.logs ?? '-'],
          ['覆盖天数', (last?.days ?? []).length || '-'],
        ]
        return h(
          'div',
          null,
          h(
            'div',
            { className: 'dsh-ph-card', style: S.card },
            h('div', { style: S.row }, h('strong', null, '会话扫描'), h('span', { style: S.faint }, '只做增量：水位 = 上次扫描时的文件 mtime + 大小，没变过的会话直接跳过')),
            h(
              'div',
              { style: { ...S.row, marginTop: 6 } },
              ...[
                ['上次扫描', status?.lastScanAt ? fmtTime(status.lastScanAt) : '从未', status?.lastScanAt ? fmtRelative(status.lastScanAt) : '可点上方按钮立即扫'],
                ['自动周期', status ? `${status.scanIntervalMinutes} 分钟` : '-', '心跳 60 秒检查一次'],
                ['错误', last?.errors ? `${last.errors}` : '0', last?.errors ? '有文件读不动，见 errorDetails' : '一切正常'],
              ].map(([label, value, hint]) =>
                h('div', { key: label, style: S.stat }, h('div', { style: S.faint }, label), h('div', { style: S.statValue }, value), hint ? h('div', { style: S.faint }, hint) : null),
              ),
            ),
            h(
              'div',
              { style: { ...S.row, marginTop: 6 } },
              ...stats.map(([label, value]) => h('div', { key: label, style: S.stat }, h('div', { style: S.faint }, label), h('div', { style: S.statValue }, String(value)))),
            ),
          ),
          report.totals
            ? h(
                'div',
                { style: { ...S.row, marginTop: 4 } },
                h(Pill, null, `${report.totals.days} 天`),
                h(Pill, null, `${report.totals.projectCount} 个项目`),
                h(Pill, null, `${report.totals.requirementCount} 个需求`),
                h(Pill, null, `${report.totals.logCount} 条记录`),
              )
            : null,
          h('div', { style: S.section }, '按天活动 —— 哪天在开发哪些项目的哪些需求'),
          report.days.length === 0
            ? h(Empty, {
                text: '这段时间没有开发记录',
                hint: '点「立即增量扫描」把 DSH 会话日志扫一遍（只扫变更过的会话）',
                action: h('div', { style: { marginTop: 6 } }, h(Btn, { primary: true, disabled: busy, onClick: () => void scan(false) }, '立即增量扫描')),
              })
            : report.days.map((d) =>
                h(
                  'div',
                  { key: d.date, className: 'dsh-ph-card', style: S.card },
                  h(
                    'div',
                    { style: S.row },
                    h('strong', { style: S.mono }, d.date),
                    h('span', { style: S.faint }, `${d.msgs} 条消息`),
                    h('span', { style: S.faint }, `${d.sessionCount} 个会话`),
                    d.logCount ? h(Pill, { color: TOKEN.accent }, `${d.logCount} 条记录`) : null,
                    h('span', { style: { flex: 1 } }),
                    h(
                      'button',
                      {
                        className: 'dsh-ph-btn',
                        style: { ...S.button, border: 'none', padding: '0 4px', opacity: 0.7 },
                        title: '切到「开发日志」并按这天过滤',
                        onClick: () => {
                          setFrom(d.date)
                          setTo(d.date)
                          setView('logs')
                        },
                      },
                      '看日志 →',
                    ),
                  ),
                  ...d.projects.map((p) =>
                    h(
                      'div',
                      { key: `${d.date}-${p.projectId}`, style: { paddingLeft: 6, marginTop: 2 } },
                      h('span', { style: { color: projectColor(p.projectId ?? p.projectName), fontWeight: 500 } }, p.projectName ?? p.projectId ?? '未指定项目'),
                      h(
                        'span',
                        { style: S.dim },
                        p.requirements.length
                          ? `：${p.requirements.map((r) => `${r.id}${r.title ? `（${r.title}）` : ''} ×${r.msgs}`).join('、')}`
                          : '：（无需求号）',
                      ),
                    ),
                  ),
                ),
              ),
        )
      }

      // ── 需求台账 tab（只放需求）
      const requirementList = () =>
        result.requirements.length === 0
          ? h(Empty, {
              text: showArchived ? '没有已归档的需求' : '还没有需求记录',
              hint: '需求文档 / WBS / 后端设计 / UI 设计 都挂在同一个需求 ID 下，每类都可以多条',
              action: h('div', { style: { marginTop: 6 } }, h(Btn, { primary: true, onClick: () => setReqForm({ mode: 'create', key: `new-${Date.now()}`, initial: null }) }, '＋ 新建需求')),
            })
          : result.requirements.map((r) => {
              const statusColor = STATUS_COLOR[r.status] ?? 'inherit'
              const expanded = detail && detail.id === r.id
              return h(
                'div',
                { key: r.id, className: 'dsh-ph-card', style: { ...S.card, borderLeft: `3px solid ${statusColor}` } },
                h(
                  'div',
                  { style: S.row },
                  h('strong', { style: { ...S.mono, fontSize: 13 } }, r.id),
                  r.title ? h('span', { style: { fontWeight: 500 } }, r.title) : h('span', { style: S.dim }, '(未填标题)'),
                  h('span', { style: { flex: 1 } }),
                  // 状态可在卡片上直接改；颜色跟着状态走
                  h(
                    'select',
                    {
                      className: 'dsh-ph-input',
                      style: { ...S.input, color: statusColor, borderColor: statusColor, width: 'auto', padding: '1px 4px', fontWeight: 600 },
                      value: REQ_STATUS_KEYS.includes(r.status) ? r.status : 'developing',
                      title: '直接改需求状态',
                      disabled: busy,
                      onChange: (e) => void applyStatus(r, e.target.value),
                    },
                    ...REQ_STATUS_KEYS.map((k) => h('option', { key: k, value: k }, STATUS_LABEL[k] ?? k)),
                  ),
                  h(Pill, { color: projectColor(r.projectId ?? r.projectName), title: `项目：${r.projectName ?? r.projectId ?? '?'}` }, r.projectName ?? r.projectId ?? '未指定项目'),
                  r.archivedAt ? h(Pill, { color: TOKEN.warn }, '已归档') : null,
                ),
                h('div', { style: { ...S.row, marginTop: 3 } }, ...renderLinkChips(r.links ?? [], r)),
                h(
                  'div',
                  { style: { ...S.row, marginTop: 3 } },
                  r.lastWorkDate ? h('span', { style: S.faint }, `最近开发 ${r.lastWorkDate}`) : null,
                  r.workCount ? h('span', { style: S.faint }, `记录 ${r.workCount} 条`) : null,
                  r.priority ? h(Pill, null, r.priority) : null,
                  ...(r.tags ?? []).slice(0, 4).map((item) =>
                    h(
                      'button',
                      {
                        key: `t-${item}`,
                        className: 'dsh-ph-pill dsh-ph-btn',
                        style: { borderColor: projectColor(item), color: projectColor(item), cursor: 'pointer', background: 'transparent' },
                        title: `只看打了「${item}」标签的需求`,
                        onClick: () => setTag(item),
                      },
                      `#${item}`,
                    ),
                  ),
                  h('span', { style: { flex: 1 } }),
                  h(Btn, { disabled: busy, primary: true, onClick: () => void openSession(r), title: '在该项目工作区里开新会话，并把需求简报（含全部链接）作为首条消息发进去' }, '开新会话'),
                  h(Btn, { disabled: busy, onClick: () => void editRequirement(r.id), title: '把这条需求载入表单修改' }, '编辑'),
                  h(Btn, { disabled: busy, onClick: () => (expanded ? setDetail(null) : void openDetail(r.id)) }, expanded ? '收起' : '详情'),
                  h(Btn, { disabled: busy, onClick: () => void archiveRequirement(r.id, !r.archivedAt) }, r.archivedAt ? '恢复' : '归档'),
                  // 归档视图里才给「删除」：归档是软删，删除是不可恢复的硬删，别让它出现在日常列表上误触
                  showArchived ? deleteButton('requirement', r.id) : null,
                ),
                expanded
                  ? h(RequirementDetail, {
                      detail,
                      onChanged: () => void openDetail(r.id),
                      onOpenSession: () => void openSession(r),
                      onPickTag: (item) => setTag(item),
                    })
                  : null,
              )
            })

      // ── 开发日志 tab（只放记录）
      const logList = () =>
        result.logs.length === 0
          ? h(Empty, {
              text: showArchived ? '没有已归档的记录' : '还没有开发记录',
              hint: '到「会话扫描」按天自动归集，或用「＋ 记录」手动补一条（例如当天解决的 bug）',
              action: h('div', { style: { marginTop: 6 } }, h(Btn, { primary: true, onClick: () => setLogForm({ mode: 'create', key: `new-log-${Date.now()}`, initial: null }) }, '＋ 加记录')),
            })
          : result.logs.map((l) => {
              const color = KIND_COLOR[l.kind] ?? TOKEN.dim
              const editing = logForm && logForm.mode === 'edit' && logForm.initial && logForm.initial.id === l.id
              return h(
                'div',
                { key: l.id, className: 'dsh-ph-card', style: { ...S.card, borderLeft: `3px solid ${color}` } },
                h(
                  'div',
                  { style: S.row },
                  h('span', { style: { ...S.mono, minWidth: 74 } }, l.date),
                  h(Pill, { color }, KIND_LABEL[l.kind] ?? l.kind),
                  h('span', { style: { fontWeight: 500, flex: '1 1 120px' } }, l.title ?? '(无标题)'),
                  l.requirementId ? h(Pill, null, l.requirementId) : null,
                  h(Pill, { color: projectColor(l.projectId ?? l.projectName), title: `项目：${l.projectName ?? l.projectId ?? '?'}` }, l.projectName ?? l.projectId ?? '未指定项目'),
                  l.minutes ? h(Pill, null, `${l.minutes} 分钟`) : null,
                  h(Pill, { color: l.source === 'session-scan' ? TOKEN.dim : TOKEN.accent }, l.source === 'session-scan' ? '扫描' : '手工'),
                  l.archivedAt ? h(Pill, { color: TOKEN.warn }, '已归档') : null,
                  h('span', { style: { flex: 1 } }),
                  h(Btn, { disabled: busy, onClick: () => (editing ? setLogForm(null) : setLogForm({ mode: 'edit', key: `edit-log-${l.id}`, initial: { id: l.id, date: l.date, project: l.projectId ?? '', requirement: l.requirementId ?? '', kind: l.kind ?? 'dev', title: l.title ?? '', detail: l.detail ?? '', minutes: l.minutes === null || l.minutes === undefined ? '' : String(l.minutes) } })) }, editing ? '取消' : '编辑'),
                  h(Btn, { disabled: busy, onClick: () => void archiveLog(l.id, !l.archivedAt) }, l.archivedAt ? '恢复' : '归档'),
                  showArchived ? deleteButton('log', l.id) : null,
                ),
                l.detail ? h('div', { style: S.pre }, l.detail) : null,
                l.evidence && l.evidence !== l.detail ? h('div', { style: S.pre }, `证据：${l.evidence}`) : null,
                editing
                  ? h(LogForm, {
                      key: logForm.key,
                      projects: projectOptions,
                      defaultProject: project,
                      busy,
                      initial: logForm.initial,
                      onCancel: () => setLogForm(null),
                      onSubmit: (payload) =>
                        run('保存记录', async () => {
                          const saved = await api('/logs/update', { method: 'POST', body: { ...payload, id: logForm.initial.id } })
                          setLogForm(null)
                          await reload()
                          return `已更新 #${saved.log.id}：${saved.log.date} ${saved.log.title}`
                        }),
                      onError: reportError,
                    })
                  : null,
              )
            })

      // 归档视图顶部提醒：删除是硬删（不可恢复），恢复是放回日常列表
      const archivedBanner = showArchived
        ? h(
            'div',
            { style: { ...S.card, borderColor: TOKEN.warn, marginBottom: 6 } },
            h('span', { style: { color: TOKEN.warn, fontWeight: 600 } }, '归档视图'),
            h('span', { style: { ...S.faint, marginLeft: 6 } }, '「删除」= 彻底删除（不可恢复，会同时删掉该需求的全部链接）；只想放回日常列表就点「恢复」。'),
          )
        : null
      const body = view === 'scan' ? scanView() : h('div', null, archivedBanner, view === 'req' ? requirementList() : logList())

      return h(
        'div',
        { style: S.root },
        header,
        tabs,
        toolbar,
        h(Notice, { notice, onClose: () => setNotice(null) }),
        reqForm && view === 'req'
          ? h(RequirementForm, {
              key: reqForm.key,
              projects: projectOptions,
              tagOptions,
              defaultProject: project,
              busy,
              mode: reqForm.mode,
              initial: reqForm.initial,
              onCancel: () => setReqForm(null),
              onDone: (text) => ok(text),
              onSubmit: (payload) =>
                run('保存需求', async () => {
                  const saved = await api('/requirements/save', { method: 'POST', body: { ...payload, project: payload.project || project || undefined } })
                  setReqForm(null)
                  await reload()
                  const links = (saved.requirement?.links ?? []).length
                  // 文档标题没读到（多半是内部站点要登录）时，把原因一并说出来，别让用户以为「标题没了」
                  const titleHint =
                    saved.titleRead && !saved.titleRead.ok
                      ? `　⚠ 文档标题没读到：${saved.titleRead.error}${
                          (saved.titleRead.attempts ?? []).length ? `　[取页链路：${saved.titleRead.attempts.join(' → ')}]` : ''
                        }`
                      : ''
                  const noHint = saved.noFromTitle ? `　需求号 ${saved.noFromTitle} 取自文档标题` : ''
                  return `${reqForm.mode === 'edit' ? '已更新' : '已保存'}需求 ${saved.requirement.id}${saved.requirement.title ? ` · ${saved.requirement.title}` : ''}（${links} 条链接）${noHint}${titleHint}`
                }),
              onError: reportError,
            })
          : null,
        logForm && logForm.mode === 'create' && view === 'logs'
          ? h(LogForm, {
              key: logForm.key,
              projects: projectOptions,
              defaultProject: project,
              busy,
              initial: null,
              onCancel: () => setLogForm(null),
              onSubmit: (payload) =>
                run('保存记录', async () => {
                  const saved = await api('/logs/add', { method: 'POST', body: { ...payload, project: payload.project || project || undefined } })
                  setLogForm(null)
                  await reload()
                  return `已记录 #${saved.log.id}：${saved.log.date} ${saved.log.title}`
                }),
              onError: reportError,
            })
          : null,
        h('div', { className: 'dsh-ph-scroll', style: S.body }, body),
      )
    }

    // ────────────────────────────────────────────────────────────── 需求详情

    function RequirementDetail(props) {
      const { detail, onChanged, onOpenSession, onPickTag } = props
      const [draft, setDraft] = useState({ kind: 'ui', url: '', title: '' })
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState(null)
      const runLink = async (path, body) => {
        setBusy(true)
        setErr(null)
        try {
          await api(path, { method: 'POST', body })
          if (typeof onChanged === 'function') onChanged()
        } catch (error) {
          setErr(error && error.message ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }
      if (!detail) return null
      const req = detail.requirement ?? {}
      const links = req.links ?? []
      return h(
        'div',
        { style: { marginTop: 8, borderTop: `1px dashed ${TOKEN.borderSoft}`, paddingTop: 6 } },
        h(
          'div',
          { style: { ...S.row, justifyContent: 'space-between' } },
          h('div', { style: S.faint }, `创建 ${fmtTime(req.createdAt)}　更新 ${fmtTime(req.updatedAt)}　记录 ${detail.logs.length} 条`),
          typeof onOpenSession === 'function'
            ? h(Btn, { primary: true, disabled: busy, onClick: onOpenSession, title: '在该项目工作区开新会话，并把需求简报作为首条消息' }, '开新会话')
            : null,
        ),
        (req.tags ?? []).length > 0
          ? h(
              'div',
              { style: { ...S.row, gap: 4, marginTop: 6 } },
              h('span', { style: S.faint }, '标签：'),
              ...req.tags.map((item) =>
                h(
                  'button',
                  {
                    key: `dtag-${item}`,
                    className: 'dsh-ph-pill dsh-ph-btn',
                    style: { borderColor: projectColor(item), color: projectColor(item), cursor: 'pointer', background: 'transparent' },
                    title: `只看打了「${item}」标签的需求`,
                    onClick: () => (typeof onPickTag === 'function' ? onPickTag(item) : undefined),
                  },
                  `#${item}`,
                ),
              ),
            )
          : null,
        h('div', { style: S.section }, `链接 ${links.length} 条（点标题跳转，⧉ 复制；每类可多条）`),
        links.length === 0
          ? h('div', { style: S.faint }, '还没有链接')
          : links.map((link) =>
              h(
                'div',
                { key: `lk-${link.id}`, style: { ...S.row, marginTop: 3, alignItems: 'center' } },
                // 只显示「类别 + 短标题」：不铺全量 URL，点一下跳转即可
                h(LinkPill, { color: LINK_COLOR[link.kind] ?? 'inherit', href: link.url, title: `打开：${link.url}` }, link.kindLabel ?? link.kind),
                h(
                  LinkText,
                  { href: link.url, title: `${link.url}${link.note ? `　（${link.note}）` : ''}`, style: { flex: '1 1 auto', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  link.title ? link.title : shortUrlLabel(link.url),
                ),
                link.note ? h('span', { style: { ...S.faint, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, link.note) : null,
                h(CopyBtn, { value: link.url, disabled: busy, label: '⧉', style: { padding: '0 5px' }, doneText: `已复制${link.kindLabel ?? ''}链接` }),
                h(Btn, { disabled: busy, onClick: () => void runLink('/requirements/link/remove', { id: req.id, linkId: link.id }), title: '删掉这条链接' }, '删除'),
              ),
            ),
        h(
          'div',
          { style: { ...S.row, marginTop: 4 } },
          h(
            'select',
            { className: 'dsh-ph-input', style: S.input, value: draft.kind, onChange: (e) => setDraft((p) => ({ ...p, kind: e.target.value })) },
            ...LINK_FORM_KINDS.map((k) => h('option', { key: k, value: k }, LINK_LABEL[k])),
          ),
          h('input', {
            className: 'dsh-ph-input',
            style: { ...S.input, flex: '2 1 150px' },
            value: draft.url,
            placeholder: draft.kind === 'ui' ? 'https://figma.com/… / mastergo / 蓝湖' : 'https://… 或本地路径',
            onChange: (e) => setDraft((p) => ({ ...p, url: e.target.value })),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && draft.url) void runLink('/requirements/link/add', { id: req.id, ...draft })
            },
          }),
          h('input', { className: 'dsh-ph-input', style: { ...S.input, flex: '1 1 100px' }, value: draft.title, placeholder: '标题（可空）', onChange: (e) => setDraft((p) => ({ ...p, title: e.target.value })) }),
          draft.url ? h(LinkPill, { href: draft.url, title: `先看看这条：${draft.url}` }, '↗ 试打开') : null,
          h(
            Btn,
            {
              primary: true,
              disabled: busy || !draft.url,
              onClick: () =>
                void runLink('/requirements/link/add', { id: req.id, ...draft }).then(() => setDraft((p) => ({ ...p, url: '', title: '' }))),
            },
            '＋ 加链接',
          ),
        ),
        err ? h('div', { style: { ...S.pre, color: TOKEN.danger } }, err) : null,
        detail.logs.length ? h('div', { style: S.section }, `开发记录 ${detail.logs.length} 条`) : null,
        ...detail.logs.slice(0, 20).map((l) =>
          h('div', { key: `log-${l.id}`, style: S.pre }, `${l.date} [${KIND_LABEL[l.kind] ?? l.kind}] ${l.title ?? ''}${l.source === 'session-scan' ? '（扫描）' : ''}`),
        ),
        detail.days.length ? h('div', { style: S.section }, `按天活动 ${detail.days.length} 天`) : null,
        ...detail.days.slice(0, 10).map((d) =>
          h(
            'div',
            { key: `day-${d.date}`, style: S.pre },
            `${d.date}　${d.projects.map((p) => `${p.projectName ?? p.projectId}(${p.requirements.map((r) => `${r.id}×${r.msgs}`).join('、') || '无需求号'})`).join('　')}`,
          ),
        ),
      )
    }

    // ────────────────────────────────────────────────────────────── 表单

    function RequirementForm(props) {
      const initial = props.initial
      const editing = props.mode === 'edit'
      const [form, setForm] = useState({
        id: initial?.id ?? '',
        no: initial?.no ?? '',
        project: initial?.project ?? props.defaultProject ?? '',
        title: initial?.title ?? '',
        status: initial?.status ?? 'developing',
        priority: initial?.priority ?? '',
        tags: initial?.tags ?? '',
      })
      const [links, setLinks] = useState(() => {
        const src = initial?.links ?? {}
        const out = {}
        for (const k of LINK_FORM_KINDS) out[k] = (src[k] ?? []).map((row) => ({ url: row.url ?? '', title: row.title ?? '', note: row.note ?? '' }))
        if (out.doc.length === 0 && !editing) out.doc = [{ url: '', title: '', note: '' }]
        return out
      })
      const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))
      const setRow = (kind, index, key, value) => setLinks((prev) => ({ ...prev, [kind]: prev[kind].map((row, i) => (i === index ? { ...row, [key]: value } : row)) }))
      const addRow = (kind) => setLinks((prev) => ({ ...prev, [kind]: [...prev[kind], { url: '', title: '', note: '' }] }))
      const removeRow = (kind, index) => setLinks((prev) => ({ ...prev, [kind]: prev[kind].filter((_, i) => i !== index) }))
      const readRowTitle = async (kind, index) => {
        const url = links[kind][index]?.url
        if (!url) {
          props.onError(new Error('先填这条链接的地址'))
          return
        }
        try {
          const payload = await api('/doc-title', { method: 'POST', body: { url } })
          if (!payload.ok || !payload.title) {
            props.onError(new Error(payload.error ?? '没读到标题'))
            return
          }
          setRow(kind, index, 'title', payload.title)
          // 标题里常常带需求号（`【5922】L&F Q3 …`）：空着就自动填，已填则只提醒、不覆盖
          const detected = extractNoFromTitle(payload.title)
          const currentNo = String(form.no ?? '').trim()
          const patch = { title: form.title || payload.title }
          let note = ''
          if (detected && !currentNo) {
            patch.no = detected
            note = `　需求号已自动填入 ${detected}`
          } else if (detected && currentNo !== detected) {
            note = `　⚠ 标题里是 ${detected}，当前填的是 ${currentNo}（没有覆盖）`
          }
          setForm({ ...form, ...patch })
          if (typeof props.onDone === 'function') props.onDone(`读标题成功：${payload.title}${note}`)
        } catch (error) {
          props.onError(error)
        }
      }
      const collectLinks = () =>
        LINK_FORM_KINDS.flatMap((kind) =>
          (links[kind] ?? [])
            .filter((row) => String(row.url ?? '').trim())
            .map((row) => ({ kind, url: String(row.url).trim(), title: row.title ? String(row.title).trim() : undefined, note: row.note ? String(row.note).trim() : undefined })),
        )
      const linkEditor = (kind) =>
        h(
          'div',
          { key: kind, style: { marginTop: 4 } },
          h(
            'div',
            { style: { ...S.row, gap: 6 } },
            h('span', { style: { minWidth: 56, color: LINK_COLOR[kind], fontWeight: 500 } }, LINK_LABEL[kind]),
            h(Btn, { style: { padding: '0 6px' }, onClick: () => addRow(kind) }, '＋ 添加一条'),
            (links[kind] ?? []).length > 1 ? h('span', { style: S.faint }, `共 ${links[kind].length} 条`) : null,
          ),
          ...(links[kind] ?? []).map((row, index) =>
            h(
              'div',
              { key: `${kind}-${index}`, style: { ...S.row, marginTop: 3, alignItems: 'center' } },
              // 每一行的 URL 都可点：非空时给一个 ↗ 直接打开（输入框本身不可点）
              String(row.url ?? '').trim() ? h(LinkPill, { href: String(row.url).trim(), color: LINK_COLOR[kind], title: `打开：${row.url}` }, '↗') : h('span', { style: { ...S.faint, minWidth: 18, textAlign: 'center' } }, '·'),
              h('input', {
                className: 'dsh-ph-input',
                style: { ...S.input, flex: '2 1 170px' },
                value: row.url,
                placeholder: kind === 'ui' ? 'https://figma.com/… / mastergo / 蓝湖' : 'https://… 或本地路径',
                onChange: (e) => setRow(kind, index, 'url', e.target.value),
              }),
              h('input', { className: 'dsh-ph-input', style: { ...S.input, flex: '1 1 100px' }, value: row.title, placeholder: '标题', onChange: (e) => setRow(kind, index, 'title', e.target.value) }),
              h('input', { className: 'dsh-ph-input', style: { ...S.input, flex: '1 1 90px' }, value: row.note, placeholder: '备注', onChange: (e) => setRow(kind, index, 'note', e.target.value) }),
              String(row.url ?? '').trim() ? h(CopyBtn, { value: String(row.url).trim(), label: '⧉', style: { padding: '0 5px' }, doneText: '已复制链接' }) : null,
              kind === 'doc' ? h(Btn, { onClick: () => void readRowTitle(kind, index) }, '读标题') : null,
              h(Btn, { onClick: () => removeRow(kind, index), title: '删掉这条链接' }, '×'),
            ),
          ),
        )
      const count = collectLinks().length
      return h(
        'div',
        { style: { ...S.card, margin: '6px 10px', borderColor: TOKEN.accent } },
        h(
          'div',
          { style: { ...S.row, marginBottom: 4 } },
          h('strong', null, editing ? `编辑需求 ${initial?.id ?? ''}` : '新建需求'),
          h('span', { style: S.faint }, editing ? '改完点「保存修改」；链接按当前列表整体替换' : '需求 ID 缺省按 <项目名大写>-<需求号> 自动拼'),
          h('span', { style: { flex: 1 } }),
          h(Btn, { onClick: props.onCancel }, '取消'),
        ),
        h(
          'div',
          { style: S.row },
          h(Field, { label: '需求号' }, h('input', { className: 'dsh-ph-input', style: S.input, value: form.no, onChange: set('no'), placeholder: '5921' })),
          h(
            Field,
            { label: editing ? '需求 ID（编辑中不可改）' : '需求 ID（可空，自动拼）' },
            h('input', { className: 'dsh-ph-input', style: { ...S.input, opacity: editing ? 0.7 : 1 }, value: form.id, onChange: set('id'), placeholder: 'SPMS-5921', readOnly: editing }),
          ),
          h(
            Field,
            { label: '项目' },
            h(
              'select',
              { className: 'dsh-ph-input', style: S.input, value: form.project, onChange: set('project') },
              h('option', { value: '' }, '（当前工作区）'),
              ...(props.projects ?? []).map((p) => h('option', { key: p.id, value: p.id }, p.name ? `${p.name}（${p.id}）` : p.id)),
            ),
          ),
          h(Field, { label: '状态' }, h('select', { className: 'dsh-ph-input', style: S.input, value: form.status, onChange: set('status') }, ...Object.entries(STATUS_LABEL).map(([k, v]) => h('option', { key: k, value: k }, v)))),
          h(Field, { label: '优先级' }, h('input', { className: 'dsh-ph-input', style: { ...S.input, width: 70 }, value: form.priority, onChange: set('priority'), placeholder: 'P0' })),
        ),
        h(Field, { label: '标题（留空则用需求文档标题）' }, h('input', { className: 'dsh-ph-input', style: S.input, value: form.title, onChange: set('title') })),
        h(
          Field,
          { label: '标签（逗号分隔；点下面的常用标签直接加）' },
          h('input', { className: 'dsh-ph-input', style: S.input, value: form.tags, onChange: set('tags'), placeholder: '待评审, 前端, 等UI稿' }),
          (() => {
            const picks = tagSuggestions(props.tagOptions ?? [], form.tags)
            if (picks.length === 0) return null
            return h(
              'div',
              { style: { ...S.row, gap: 4, marginTop: 4, flexWrap: 'wrap' } },
              h('span', { style: S.faint }, '常用：'),
              ...picks.map((item) =>
                h(
                  'button',
                  {
                    key: `pick-${item.tag}`,
                    className: 'dsh-ph-pill dsh-ph-btn',
                    style: { borderColor: projectColor(item.tag), color: projectColor(item.tag), cursor: 'pointer', background: 'transparent' },
                    title: `加入标签「${item.tag}」（用过 ${item.count} 次）`,
                    onClick: () => setForm({ ...form, tags: addTagToText(form.tags, item.tag) }),
                  },
                  `#${item.tag}`,
                ),
              ),
            )
          })(),
        ),
        h('div', { style: S.section }, '链接（UI / 需求 / WBS / 设计 每类都可以加多条；每行左侧 ↗ 可点开）'),
        ...LINK_FORM_KINDS.map((k) => linkEditor(k)),
        h(
          'div',
          { style: { ...S.row, marginTop: 8 } },
          h(Btn, { primary: true, disabled: props.busy, onClick: () => props.onSubmit({ ...form, links: collectLinks(), replaceLinks: true, tags: form.tags ? form.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean) : undefined }) }, editing ? '保存修改' : '保存需求'),
          h('span', { style: S.faint }, `将保存 ${count} 条链接`),
        ),
      )
    }

    function LogForm(props) {
      const initial = props.initial
      const editing = Boolean(initial && initial.id)
      const [form, setForm] = useState({
        date: initial?.date ?? today(),
        project: initial?.project ?? props.defaultProject ?? '',
        requirement: initial?.requirement ?? '',
        kind: initial?.kind ?? 'bug',
        title: initial?.title ?? '',
        detail: initial?.detail ?? '',
        minutes: initial?.minutes ?? '',
      })
      const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))
      return h(
        'div',
        { style: { ...S.card, margin: '6px 10px', borderColor: TOKEN.accent } },
        h(
          'div',
          { style: { ...S.row, marginBottom: 4 } },
          h('strong', null, editing ? `编辑记录 #${initial.id}` : '手动加一条开发记录'),
          h('span', { style: S.faint }, editing ? '只改你要改的字段' : '例如：当天解决的 bug'),
          h('span', { style: { flex: 1 } }),
          h(Btn, { onClick: props.onCancel }, '取消'),
        ),
        h(
          'div',
          { style: S.row },
          h(Field, { label: '日期' }, h('input', { className: 'dsh-ph-input', type: 'date', style: S.input, value: form.date, onChange: set('date') })),
          h(
            Field,
            { label: '项目' },
            h(
              'select',
              { className: 'dsh-ph-input', style: S.input, value: form.project, onChange: set('project') },
              h('option', { value: '' }, '（当前工作区）'),
              ...(props.projects ?? []).map((p) => h('option', { key: p.id, value: p.id }, p.name ? `${p.name}（${p.id}）` : p.id)),
            ),
          ),
          h(Field, { label: '需求 ID / 号（可空）' }, h('input', { className: 'dsh-ph-input', style: S.input, value: form.requirement, onChange: set('requirement'), placeholder: '55036' })),
          h(Field, { label: '类型' }, h('select', { className: 'dsh-ph-input', style: S.input, value: form.kind, onChange: set('kind') }, ...KINDS.map((k) => h('option', { key: k, value: k }, KIND_LABEL[k] ?? k)))),
          h(Field, { label: '耗时(分钟)' }, h('input', { className: 'dsh-ph-input', style: { ...S.input, width: 70 }, value: form.minutes, onChange: set('minutes') })),
        ),
        h(Field, { label: '标题' }, h('input', { className: 'dsh-ph-input', style: S.input, value: form.title, onChange: set('title'), placeholder: '修复 55036 分页越界' })),
        h(Field, { label: '详情' }, h('input', { className: 'dsh-ph-input', style: S.input, value: form.detail, onChange: set('detail') })),
        h(
          'div',
          { style: { ...S.row, marginTop: 8 } },
          h(
            Btn,
            {
              primary: true,
              disabled: props.busy,
              onClick: () =>
                props.onSubmit({
                  date: form.date,
                  project: form.project,
                  requirement: form.requirement,
                  kind: form.kind,
                  title: form.title,
                  detail: form.detail,
                  minutes: form.minutes === '' ? undefined : Number(form.minutes),
                }),
            },
            editing ? '保存修改' : '保存记录',
          ),
        ),
      )
    }

    // ────────────────────────────────────────────── 在项目工作区开新会话

    /**
     * 「开新会话」全流程（**能力探测式**，不假设 API 形态）：
     *   ① 宿主路由 `/open-session` 负责：解析需求 → 渲染简报（提示词）→ 把项目目录登记成
     *      宿主 workspace，返回 `{ prompt, workspace:{id,path}, canCreate }`；
     *   ② 客户端负责建会话并投喂首条消息 —— 本机实测链路（dsh-zentao-workbench 同款）：
     *      `sessions.create({ workspaceId })` → `sessions.open(id)` →
     *      `sessions.scope(id).get('conversation').send(text)`；
     *      拿不到 scope 时退到 `sessions.using(id, {}, binding => …)`；
     *   ③ 任何一步失败：把简报**复制到剪贴板**并把真实原因显示出来（绝不静默失败）。
     *
     * 读服务必须**按属性读**（`scoped.sessions`）：cordis 的 `ctx.get` 是严格的，
     * 对当前 fiber 不可见的服务会直接抛，这正是别的插件「按钮点了没反应」的根因。
     */
    let hubCtx = null
    const hubServices = { sessions: null, workspaces: null }

    function callIfPresent(target, name, ...args) {
      const fn = target ? target[name] : undefined
      if (typeof fn !== 'function') return undefined
      return { value: fn.apply(target, args) }
    }

    function methodsOf(target) {
      const names = new Set()
      let current = target
      while (current && current !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(current)) {
          if (key === 'constructor') continue
          try {
            if (typeof target[key] === 'function') names.add(key)
          } catch (e) {
            /* getter 抛错不算能力 */
          }
        }
        current = Object.getPrototypeOf(current)
      }
      return [...names].sort().join(', ') || '(无)'
    }

    /** scope/binding 背后的 `conversation` 服务（有 send 才算）。 */
    function conversationOf(scope) {
      const get = scope ? scope.get : undefined
      if (typeof get !== 'function') return undefined
      try {
        const conversation = get.call(scope, 'conversation')
        return conversation && typeof conversation.send === 'function' ? conversation : undefined
      } catch (e) {
        return undefined
      }
    }

    /** 拿到某个会话的作用域：本机 `scope()` 对新会话可能返回 undefined，先 materialize。 */
    function scopeFor(sessions, sessionId) {
      callIfPresent(sessions, 'materializeScope', sessionId)
      const direct = callIfPresent(sessions, 'scope', sessionId)?.value ?? callIfPresent(sessions, 'scopeOf', sessionId)?.value
      if (direct !== undefined) return direct
      for (const route of ['sessionOf', 'binding']) {
        const held = callIfPresent(sessions, route, sessionId)?.value
        if (!held) continue
        const viaScope = callIfPresent(held, 'scope', sessionId)?.value
        if (viaScope !== undefined) return viaScope
        if (held.context !== undefined) return held.context
      }
      return undefined
    }

    /** 在当前可见的 workspace 快照里找目标 workspace；找不到就用默认 workspace。 */
    async function resolveWorkspaceId(workspaces, wanted) {
      const snapshotOf = () => {
        try {
          return workspaces?.list?.getSnapshot?.() ?? {}
        } catch (e) {
          return {}
        }
      }
      const ids = () => {
        const snap = snapshotOf()
        const list = snap.items ?? snap.workspaces ?? []
        return list.map((item) => item && item.workspaceId).filter(Boolean)
      }
      if (wanted) {
        // 宿主刚登记的 workspace 可能还没同步到客户端，等一会儿
        for (let i = 0; i < 6; i += 1) {
          if (ids().includes(wanted)) return wanted
          await new Promise((resolve) => setTimeout(resolve, 350))
        }
        // 同步不过来也先按宿主给的 id 试（客户端 create 可能直接接受）
        return wanted
      }
      const snap = snapshotOf()
      const list = snap.items ?? snap.workspaces ?? []
      let current = null
      try {
        current = hubServices.sessions?.list?.getSnapshot?.()?.current ?? null
      } catch (e) {
        current = null
      }
      const byCurrent = current ? list.find((item) => (item?.sessionIds ?? []).includes(current))?.workspaceId : undefined
      const fallback = await (async () => {
        const init = callIfPresent(workspaces, 'initializeDefault')?.value
        const value = init instanceof Promise ? await init.catch(() => undefined) : init
        return typeof value === 'string' ? value : (value && value.workspaceId) || undefined
      })()
      return byCurrent ?? list[0]?.workspaceId ?? snap.recentWorkspaceId ?? fallback
    }

    async function createSessionIn(sessions, workspaces, workspaceId) {
      const create = sessions ? sessions.create : undefined
      if (typeof create === 'function') {
        const created = await create.call(sessions, { workspaceId })
        const id = typeof created === 'string' ? created : (created && (created.sessionId ?? created.id)) || undefined
        if (typeof id === 'string' && id) return id
      }
      const legacy = callIfPresent(workspaces, 'connectWorkspace', workspaceId)?.value
      if (typeof legacy === 'string') return legacy
      if (legacy instanceof Promise) return await legacy
      throw new Error(`无法新建会话：sessions 暴露的方法：${methodsOf(sessions)}；workspaces 暴露的方法：${methodsOf(workspaces)}`)
    }

    async function sendIntoSession(sessions, sessionId, text) {
      const scoped = scopeFor(sessions, sessionId)
      const direct = conversationOf(scoped)
      if (direct) {
        await direct.send(text)
        return 'scope.conversation'
      }
      const using = sessions ? sessions.using : undefined
      if (typeof using !== 'function') throw new Error(`拿不到会话作用域（sessions 方法：${methodsOf(sessions)}）`)
      let used = null
      await using.call(sessions, sessionId, {}, async (binding) => {
        const conversation = conversationOf(binding) ?? conversationOf(scopeFor(sessions, sessionId))
        if (!conversation) throw new Error('会话作用域里没有 conversation.send')
        await conversation.send(text)
        used = 'using'
      })
      return used ?? 'using'
    }

    async function copyToClipboard(text) {
      try {
        const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null
        if (clipboard && typeof clipboard.writeText === 'function') {
          await clipboard.writeText(text)
          return true
        }
      } catch (e) {
        /* 忽略：下面还有兜底 */
      }
      return false
    }

    /**
     * 点「开新会话」：在需求所属项目的工作区里新建会话，并把简报作为首条消息发进去。
     * @returns {Promise<string>} 给用户看的结果说明
     */
    async function openRequirementSession(requirementId) {
      const payload = await api('/open-session', { method: 'POST', body: { id: requirementId } })
      const prompt = payload.prompt ?? ''
      const sessions = hubServices.sessions ?? (hubCtx ? hubCtx.sessions : null)
      const workspaces = hubServices.workspaces ?? (hubCtx ? hubCtx.workspaces : null)
      if (!sessions) {
        const copied = await copyToClipboard(prompt)
        return `会话服务不可见（刷新页面重试）。需求简报${copied ? '已复制到剪贴板，直接粘贴即可' : '：\n' + prompt}`
      }
      const workspaceId = await resolveWorkspaceId(workspaces, payload.workspace?.id ?? null)
      if (!workspaceId) {
        const copied = await copyToClipboard(prompt)
        return `没能定位工作区（${payload.workspaceError ?? '宿主没有可用的 workspace'}）。简报${copied ? '已复制到剪贴板' : '：\n' + prompt}`
      }
      const sessionId = await createSessionIn(sessions, workspaces, workspaceId)
      callIfPresent(sessions, 'open', sessionId)
      try {
        await sendIntoSession(sessions, sessionId, prompt)
        return `已在新会话里打开【${payload.project?.name ?? workspaceId}】并发出需求简报（${sessionId}）`
      } catch (error) {
        const copied = await copyToClipboard(prompt)
        return `新会话已创建（${sessionId}），但简报没发出去：${error && error.message}。简报${copied ? '已复制到剪贴板，粘贴后回车即可' : '：\n' + prompt}`
      }
    }

    // ────────────────────────────────────────────────────────────── 座位

    let openPanelRef = () => false

    function SidebarEntry() {
      const [open, setOpen] = useState(false)
      return h(
        'div',
        {
          className: 'dsh-ph-btn',
          style: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 6, cursor: 'pointer', color: TOKEN.text, fontSize: 12 },
          title: '打开项目管理台账（需求 / WBS / 后端设计 / UI 设计 / 开发记录）',
          onClick: () => setOpen(Boolean(openPanelRef())),
        },
        h('span', { style: { fontSize: 13 } }, '📋'),
        h('span', { style: { flex: 1 } }, '项目管理'),
        open ? h('span', { style: { color: TOKEN.ok, fontSize: 10 } }, '已打开') : null,
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ensureStyles()
      hubCtx = ctx
      // 会话/工作区服务：按属性读（ctx.get 对不可见服务会抛），缺席时按钮降级为「复制简报」
      try {
        ctx.inject(['sessions', 'workspaces'], (scoped) => {
          hubServices.sessions = scoped.sessions ?? null
          hubServices.workspaces = scoped.workspaces ?? null
        })
      } catch (error) {
        console.warn(`[project-hub] 会话/工作区服务不可见（开新会话将退化为复制简报）：${error && error.message}`)
      }
      let disposeTab
      let opened = false

      // ① 页签类型：这一步才让「项目管理」出现在侧边栏的页签表里
      try {
        ctx.inject(['sidebarRightTabs'], (scoped) => {
          const tabs = scoped.sidebarRightTabs ?? (typeof scoped.get === 'function' ? scoped.get('sidebarRightTabs') : undefined)
          if (!tabs || typeof tabs.register !== 'function') return undefined
          const dispose = tabs.register({
            id: TYPE_ID,
            kind: KIND,
            title: () => '项目管理',
            guide: [
              {
                id: 'project-hub',
                order: 36,
                title: () => '项目管理',
                description: () => '需求台账 / WBS / 后端设计 / UI 设计 / 按天开发记录',
              },
            ],
          })
          disposeTab = dispose
          return () => {
            disposeTab = undefined
            dispose?.()
          }
        })
      } catch (error) {
        console.warn(`[project-hub] 侧边栏页签注册失败（降级为仅工具面）：${error && error.message}`)
      }

      // ② 页签主体：座位按上面注册的 id 分发，并把该页签绑定的会话 id 传进来
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              { name: 'sidebar.right.pane.tab', key: TYPE_ID, inject: (sessionId) => ({ sessionId: sessionId ? String(sessionId) : null }) },
              (props) => h(Panel, props ?? {}),
            ),
          ),
        'dsh-project-hub: sidebar pane body',
      )

      // ③ 页签标题
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TYPE_ID }, () => h('span', null, '项目管理')),
          ),
        'dsh-project-hub: sidebar pane title',
      )

      // ④ 打开入口：只 register 不 openTab 时页签存在但没人看见
      const openPanel = () => {
        try {
          ctx.inject(['sidebarRight'], (scoped) => {
            const right = scoped.sidebarRight ?? (typeof scoped.get === 'function' ? scoped.get('sidebarRight') : undefined)
            if (!right || typeof right.openTab !== 'function') return undefined
            right.openTab(KIND, { replaceTab: true })
            opened = true
            return undefined
          })
          return opened
        } catch (error) {
          console.warn(`[project-hub] 打开侧边栏失败：${error && error.message}`)
          return false
        }
      }
      openPanelRef = openPanel

      // ⑤ 侧边栏入口按钮（侧边栏底部）
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.footer.action', () =>
            ctx.slots.register({ name: 'sidebar.footer.action', id: 'project-hub', order: 36 }, () => h(SidebarEntry, null)),
          ),
        'dsh-project-hub: sidebar footer entry',
      )

      return { openPanel }
    }

    // `__test` 只给契约测试用（宿主只认 inject/apply，多余键无副作用）
    return {
      inject,
      apply,
      __test: {
        TYPE_ID,
        KIND,
        scopeQuery,
        fmtTime,
        fmtRelative,
        today,
        KIND_LABEL,
        KIND_COLOR,
        STATUS_LABEL,
        LINK_LABEL,
        LINK_FORM_KINDS,
        renderLinkChips,
        shortUrlLabel,
        projectColor,
        deleteButtonLabel,
        parseTagInput,
        addTagToText,
        tagSuggestions,
        shouldMarkDeveloping,
        REQ_STATUS_KEYS,
        extractNoFromTitle,
        fmtClock,
        TABS,
        /** 「开新会话」的能力探测工具（测试用；生产路径见 openRequirementSession）。 */
        session: { callIfPresent, methodsOf, conversationOf, scopeFor, resolveWorkspaceId, createSessionIn, sendIntoSession },
        openSidebar: () => openPanelRef(),
      },
    }
  },
})
