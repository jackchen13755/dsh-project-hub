/**
 * dsh-project-hub —— 客户端面板（Web UI 半边）。
 *
 * 交付形态与 DSH 约定一致（**无需构建**：手写 CJS 信封 + `require` 白名单模块）：
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 *
 * 座位：宿主**右侧边栏页签**（与 dsh-source-control / dsh-zentao-workbench 同款全链）：
 *   ① `ctx.inject(['sidebarRightTabs'])` → `tabs.register({ id, kind, title, guide })` 注册页签类型；
 *   ② `ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', …))` 注册页签主体；
 *   ③ `sidebar.right.pane.tab.title` 注册页签标题。
 *   三条纪律：`id`/`kind` 必须全局唯一（抢别人的 kind 会抛且带走同一轮后续注册）；
 *   读服务必须**按属性读**（`scoped.sidebarRightTabs`，`ctx.get` 对未 inject 的服务会抛）；
 *   只 register 不 `openTab` 时「页签在但没人看见」—— 所以再挂一个 `sidebarRight.openTab` 的入口。
 *
 * 数据面走宿主路由 `/project-hub/api/*`（同源 fetch，失败一律在顶部提示条反馈，绝不静默）。
 * 内联（侧边栏）渲染约束（实测坑）：根节点要 `flex:1 1 auto` 撑满座位、滚动区要 `min-height:0`，
 * 否则高度会退化成内容高。
 */
window.__ModuleLoader__.load({
  id: 'dsh-project-hub',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/project-hub/api'
    /** 页签类型 id（注册主体与标题都用它，必须全局唯一）。 */
    const TYPE_ID = 'dsh-project-hub:panel'
    /** 页签种类（guide 入口按它打开）。 */
    const KIND = 'dsh-project-hub:project'
    const STYLE_ID = 'dsh-project-hub-styles'
    const POLL_MS = 60000

    const TOKEN = {
      text: 'var(--dsw-alias-text-1, #e6e6e6)',
      dim: 'var(--dsw-alias-text-3, #9a9a9a)',
      border: 'var(--dsw-alias-border-l2, #333)',
      borderSoft: 'var(--dsw-alias-border-l1, rgba(127,127,127,.25))',
      hover: 'var(--dsw-alias-bg-2, rgba(127,127,127,.12))',
      accent: 'var(--dsw-alias-brand-1, #4d6bfe)',
      ok: 'var(--dsw-alias-success-1, #3fb950)',
      warn: 'var(--dsw-alias-warning-1, #d29922)',
      danger: 'var(--dsw-alias-danger-1, #f85149)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    }

    const KINDS = ['dev', 'bug', 'doc', 'review', 'meeting', 'release', 'other']
    const KIND_LABEL = { dev: '开发', bug: '缺陷', doc: '文档', review: '评审', meeting: '会议', release: '发布', other: '其它' }
    const STATUS_LABEL = {
      draft: '草稿',
      planning: '规划中',
      developing: '开发中',
      testing: '测试中',
      released: '已完成',
      paused: '暂停',
      dropped: '废弃',
    }
    /** 链接类型（每类都可以有多条）与显示名。 */
    const LINK_LABEL = { doc: '需求文档', wbs: 'WBS', design: '后端设计', ui: 'UI 设计', other: '其它' }
    const LINK_FORM_KINDS = ['doc', 'wbs', 'design', 'ui']

    const S = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, flex: '1 1 auto', fontSize: 12, lineHeight: 1.6, color: TOKEN.text, background: 'transparent' },
      header: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: `1px solid ${TOKEN.border}`, flexWrap: 'wrap' },
      tabRow: { display: 'flex', gap: 4, padding: '6px 10px 0', flexWrap: 'wrap' },
      tab: { border: `1px solid ${TOKEN.border}`, background: 'transparent', color: TOKEN.text, borderRadius: 4, padding: '2px 8px', fontSize: 12, cursor: 'pointer' },
      tabActive: { border: `1px solid ${TOKEN.accent}`, background: TOKEN.hover, color: TOKEN.text, borderRadius: 4, padding: '2px 8px', fontSize: 12, cursor: 'pointer', fontWeight: 600 },
      filters: { display: 'flex', gap: 4, padding: '6px 10px', flexWrap: 'wrap', alignItems: 'center', borderBottom: `1px solid ${TOKEN.borderSoft}` },
      input: { border: `1px solid ${TOKEN.border}`, background: 'transparent', color: TOKEN.text, borderRadius: 4, padding: '2px 6px', fontSize: 12, minWidth: 0 },
      button: { border: `1px solid ${TOKEN.border}`, background: 'transparent', color: TOKEN.text, borderRadius: 4, padding: '2px 8px', fontSize: 12, cursor: 'pointer' },
      buttonPrimary: { border: `1px solid ${TOKEN.accent}`, background: 'transparent', color: TOKEN.accent, borderRadius: 4, padding: '2px 8px', fontSize: 12, cursor: 'pointer' },
      body: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '8px 10px 16px' },
      card: { border: `1px solid ${TOKEN.borderSoft}`, borderRadius: 6, padding: '6px 8px', marginBottom: 6 },
      row: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      dim: { color: TOKEN.dim },
      mono: { fontFamily: TOKEN.mono },
      badge: { border: `1px solid ${TOKEN.border}`, borderRadius: 999, padding: '0 6px', fontSize: 11, color: TOKEN.dim },
      link: { color: TOKEN.accent, textDecoration: 'none' },
      notice: { margin: '6px 10px 0', padding: '4px 8px', borderRadius: 4, fontSize: 12 },
      pre: { margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: TOKEN.dim, fontSize: 11 },
      dayLine: { borderLeft: `2px solid ${TOKEN.borderSoft}`, paddingLeft: 8, marginBottom: 4 },
    }

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.dsh-ph-hidden { display: none; }
.dsh-ph-btn:hover { background: ${TOKEN.hover}; }
`
      document.head.appendChild(style)
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
      if (!payload || payload.ok === false) {
        throw new Error((payload && payload.error) || `请求失败（HTTP ${res.status}）`)
      }
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

    function today() {
      const d = new Date()
      const mm = String(d.getMonth() + 1).padStart(2, '0')
      const dd = String(d.getDate()).padStart(2, '0')
      return `${d.getFullYear()}-${mm}-${dd}`
    }

    function Badge(props) {
      return h('span', { style: { ...S.badge, ...(props.style ?? {}) } }, props.children)
    }

    /**
     * 需求卡片上的链接：按类分组（需求文档 / WBS / 后端设计 / UI 设计），每类可多条。
     * 老数据（只有单值列、links 为空）回落到 docUrl/wbsUrl/designUrl/uiUrl，显示不受影响。
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
      for (const kind of ['doc', 'wbs', 'design', 'ui', 'other']) {
        const rows = groups.get(kind)
        if (!rows || rows.length === 0) continue
        out.push(h('span', { key: `k-${kind}`, style: { ...S.dim, marginRight: 2 } }, `${rows[0].kindLabel ?? LINK_LABEL[kind]}${rows.length > 1 ? `(${rows.length})` : ''}`))
        rows.forEach((link, index) => {
          out.push(
            h(
              'a',
              {
                key: `l-${kind}-${index}`,
                style: { ...S.link, marginRight: 6 },
                href: link.url,
                target: '_blank',
                rel: 'noreferrer',
                title: `${link.url}${link.note ? `　（${link.note}）` : ''}`,
              },
              link.title ? `${link.title}` : rows.length > 1 ? `#${index + 1}` : '打开',
            ),
          )
        })
      }
      return out
    }

    function Field(props) {
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: TOKEN.dim } },
        props.label,
        props.children,
      )
    }

    function Notice(props) {
      if (!props.notice) return null
      const color = props.notice.kind === 'error' ? TOKEN.danger : TOKEN.ok
      return h(
        'div',
        { style: { ...S.notice, border: `1px solid ${color}`, color } },
        h('span', null, props.notice.text),
        h('button', { className: 'dsh-ph-btn', style: { ...S.button, marginLeft: 8, padding: '0 6px' }, onClick: props.onClose }, '×'),
      )
    }

    /**
     * 侧边栏入口按钮（`sidebar.footer.action` 座位）。
     *
     * 这是用户要的「入口加在侧边栏里」：点它把右侧边栏切到本插件的「项目管理」页签。
     * 渲染约束（内联座位实测坑）：只渲染一个普通可点元素，不渲染悬浮层、不渲染固定抽屉，
     * 也不要在 React 根下多包无高度 div，否则座位填不满 / 高度退化。
     */
    let openPanelRef = () => false

    function SidebarEntry() {
      const [open, setOpen] = React.useState(false)
      return h(
        'div',
        {
          className: 'dsh-ph-side-entry',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 8px',
            borderRadius: 4,
            cursor: 'pointer',
            color: TOKEN.text,
            fontSize: 12,
          },
          title: '打开项目管理台账（需求 / WBS / 后端设计 / 开发记录）',
          onClick: () => {
            const okOpen = openPanelRef()
            setOpen(Boolean(okOpen))
          },
        },
        h('span', { style: { fontSize: 13 } }, '📋'),
        h('span', { style: { flex: 1 } }, '项目管理'),
        open ? h('span', { style: { color: TOKEN.ok, fontSize: 10 } }, '已打开') : null,
      )
    }

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
      const [result, setResult] = useState({ requirements: [], logs: [], days: [] })
      const [detail, setDetail] = useState(null)
      const [showReqForm, setShowReqForm] = useState(false)
      const [showLogForm, setShowLogForm] = useState(false)
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const report = useCallback((error) => {
        setNotice({ kind: 'error', text: error && error.message ? error.message : String(error) })
      }, [])
      const ok = useCallback((text) => setNotice({ kind: 'ok', text }), [])

      const loadStatus = useCallback(async () => {
        try {
          const payload = await api(`/status${scopeQuery({}, sessionId)}`)
          if (alive.current) setStatus(payload)
        } catch (error) {
          if (alive.current) report(error)
        }
      }, [sessionId, report])

      const loadProjects = useCallback(async () => {
        try {
          const payload = await api(`/projects${scopeQuery({}, sessionId)}`)
          if (!alive.current) return
          setCandidates(payload.candidates ?? [])
        } catch (error) {
          if (alive.current) report(error)
        }
      }, [sessionId, report])

      const loadList = useCallback(async () => {
        try {
          const query = scopeQuery(
            {
              q,
              project,
              from,
              to,
              kind: view === 'logs' ? kind : null,
              archived: showArchived ? 'only' : 'exclude',
              limit: 60,
            },
            sessionId,
          )
          const payload = await api(`/search${query}`)
          if (alive.current) setResult({ requirements: payload.requirements ?? [], logs: payload.logs ?? [], days: payload.days ?? [] })
        } catch (error) {
          if (alive.current) report(error)
        }
      }, [q, project, from, to, kind, view, showArchived, sessionId, report])

      useEffect(() => {
        void loadStatus()
        void loadProjects()
      }, [loadStatus, loadProjects])

      useEffect(() => {
        void loadList()
      }, [loadList])

      useEffect(() => {
        if (sessionId) return undefined
        const timer = window.setInterval(() => {
          void loadStatus()
          void loadList()
        }, POLL_MS)
        return () => window.clearInterval(timer)
      }, [loadList, loadStatus, sessionId])

      const run = useCallback(
        async (label, fn) => {
          setBusy(true)
          try {
            const text = await fn()
            if (text) ok(text)
          } catch (error) {
            report(error)
          } finally {
            if (alive.current) setBusy(false)
          }
        },
        [ok, report],
      )

      const scan = () =>
        run('扫描会话', async () => {
          const payload = await api('/scan', { method: 'POST', body: { limit: 300 } })
          await loadStatus()
          await loadList()
          return `扫描完成：${payload.changed} 个会话有变更，跳过 ${payload.skipped}，新增记录 ${payload.logs} 条，覆盖 ${(payload.days ?? []).length} 天`
        })

      const openDetail = (id) =>
        run('读取需求', async () => {
          const payload = await api(`/requirements/get${scopeQuery({ id }, sessionId)}`)
          if (alive.current) setDetail({ id, requirement: payload.requirement, logs: payload.logs ?? [], days: payload.days ?? [] })
          return null
        })

      const archiveRequirement = (id, archived) =>
        run('归档需求', async () => {
          await api('/requirements/archive', { method: 'POST', body: { id, archived } })
          await loadList()
          return `${archived ? '已归档' : '已恢复'}需求 ${id}`
        })

      const archiveLog = (id, archived) =>
        run('归档记录', async () => {
          await api('/logs/archive', { method: 'POST', body: { id, archived } })
          await loadList()
          return `${archived ? '已归档' : '已恢复'}记录 #${id}`
        })

      const projectOptions = candidates.length > 0 ? candidates : []
      const archivedView = showArchived

      const header = h(
        'div',
        { style: S.header },
        h('strong', null, '项目管理'),
        status
          ? h(
              'span',
              { style: S.dim },
              `需求 ${status.counts.requirements}${status.counts.archivedRequirements ? `(+${status.counts.archivedRequirements} 归档)` : ''} / 记录 ${status.counts.workLogs} / 已扫会话 ${status.counts.scannedSessions}`,
            )
          : h('span', { style: S.dim }, '加载中…'),
        h('span', { style: { flex: 1 } }),
        h('button', { className: 'dsh-ph-btn', style: S.button, disabled: busy, onClick: () => void run('刷新', async () => { await loadStatus(); await loadProjects(); await loadList(); return null }) }, '刷新'),
        h('button', { className: 'dsh-ph-btn', style: S.buttonPrimary, disabled: busy, onClick: scan }, busy ? '处理中…' : '扫描会话'),
      )

      const scanLine = h(
        'div',
        { style: { ...S.dim, padding: '0 10px 4px', fontSize: 11 } },
        status && status.lastScanAt ? `上次扫描：${fmtTime(status.lastScanAt)}（每 ${status.scanIntervalMinutes} 分钟自动扫一次）` : '尚未扫描过会话（可手动点「扫描会话」）',
      )

      const tabRow = h(
        'div',
        { style: S.tabRow },
        h('button', { style: view === 'req' ? S.tabActive : S.tab, onClick: () => setView('req') }, `需求台账 (${result.requirements.length})`),
        h('button', { style: view === 'logs' ? S.tabActive : S.tab, onClick: () => setView('logs') }, `开发日志 (${result.logs.length})`),
        h('span', { style: { flex: 1 } }),
        h('button', { style: S.tab, onClick: () => setShowReqForm((v) => !v) }, showReqForm ? '收起加需求' : '＋ 需求'),
        h('button', { style: S.tab, onClick: () => setShowLogForm((v) => !v) }, showLogForm ? '收起加记录' : '＋ 记录'),
      )

      const filters = h(
        'div',
        { style: S.filters },
        h('input', {
          style: { ...S.input, flex: '1 1 120px' },
          placeholder: '搜索：需求 ID / 标题 / 记录…',
          value: q,
          onChange: (e) => setQ(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') void loadList()
          },
        }),
        h(
          'select',
          { style: S.input, value: project, onChange: (e) => setProject(e.target.value) },
          h('option', { value: '' }, '全部项目'),
          // 带上 id：不同目录可以同名（work/spms 与 work/spms-ui/spms 都叫 spms）
          ...projectOptions.map((p) => h('option', { key: p.id, value: p.id }, p.name ? `${p.name}（${p.id}）` : p.id)),
        ),
        h('input', { type: 'date', style: S.input, value: from, onChange: (e) => setFrom(e.target.value) }),
        h('span', { style: S.dim }, '→'),
        h('input', { type: 'date', style: S.input, value: to, onChange: (e) => setTo(e.target.value) }),
        view === 'logs'
          ? h(
              'select',
              { style: S.input, value: kind, onChange: (e) => setKind(e.target.value) },
              h('option', { value: '' }, '全部类型'),
              ...KINDS.map((k) => h('option', { key: k, value: k }, KIND_LABEL[k] ?? k)),
            )
          : null,
        h(
          'label',
          { style: { ...S.dim, display: 'flex', alignItems: 'center', gap: 4 } },
          h('input', { type: 'checkbox', checked: showArchived, onChange: (e) => setShowArchived(e.target.checked) }),
          '只看已归档',
        ),
      )

      const reqForm = showReqForm
        ? h(RequirementForm, {
            projects: projectOptions,
            defaultProject: project,
            busy,
            sessionId,
            onSubmit: (body) =>
              run('保存需求', async () => {
                const payload = await api('/requirements/save', { method: 'POST', body: { ...body, project: body.project || project || undefined } })
                setShowReqForm(false)
                await loadProjects()
                await loadList()
                const title = payload.requirement && payload.requirement.title ? ` · ${payload.requirement.title}` : ''
                const read = payload.titleRead && payload.titleRead.ok ? `（文档标题已读回：${payload.titleRead.title}）` : ''
                return `已保存需求 ${payload.requirement.id}${title}${read}`
              }),
            onError: report,
          })
        : null

      const logForm = showLogForm
        ? h(LogForm, {
            projects: projectOptions,
            defaultProject: project,
            busy,
            onSubmit: (body) =>
              run('保存记录', async () => {
                const payload = await api('/logs/add', { method: 'POST', body: { ...body, project: body.project || project || undefined } })
                setShowLogForm(false)
                await loadList()
                return `已记录 #${payload.log.id}：${payload.log.date} ${payload.log.title}`
              }),
            onError: report,
          })
        : null

      const listBody =
        view === 'req'
          ? result.requirements.length === 0
            ? h('div', { style: S.dim }, archivedView ? '没有已归档的需求。' : '还没有需求记录 —— 点右上「＋ 需求」新建，或先在项目里保存需求文档。')
            : result.requirements.map((r) =>
                h(
                  'div',
                  { key: r.id, style: S.card },
                  h(
                    'div',
                    { style: S.row },
                    h('strong', { style: S.mono }, r.id),
                    r.title ? h('span', null, r.title) : h('span', { style: S.dim }, '(未填标题)'),
                    h('span', { style: { flex: 1 } }),
                    h(Badge, null, r.projectName ?? r.projectId ?? '未指定项目'),
                    h(Badge, null, STATUS_LABEL[r.status] ?? r.status ?? '-'),
                    r.archivedAt ? h(Badge, { style: { color: TOKEN.warn, borderColor: TOKEN.warn } }, '已归档') : null,
                  ),
                  h(
                    'div',
                    { style: { ...S.row, marginTop: 2 } },
                    // 链接按类展示（每类可多条）：需求文档 / WBS / 后端设计 / UI 设计
                    ...renderLinkChips(r.links ?? [], r),
                    r.lastWorkDate ? h('span', { style: S.dim }, `最近开发 ${r.lastWorkDate}`) : null,
                    r.workCount ? h('span', { style: S.dim }, `记录 ${r.workCount} 条`) : null,
                    h('span', { style: { flex: 1 } }),
                    h('button', { className: 'dsh-ph-btn', style: S.button, onClick: () => void openDetail(r.id) }, '详情'),
                    h(
                      'button',
                      {
                        className: 'dsh-ph-btn',
                        style: S.button,
                        onClick: () => void archiveRequirement(r.id, !r.archivedAt),
                      },
                      r.archivedAt ? '恢复' : '归档',
                    ),
                  ),
                  detail && detail.id === r.id ? h(RequirementDetail, { detail, onChanged: () => void openDetail(r.id) }) : null,
                ),
              )
          : result.logs.length === 0
            ? h('div', { style: S.dim }, archivedView ? '没有已归档的记录。' : '还没有开发记录 —— 点「扫描会话」按天自动归集，或用「＋ 记录」手动补一条（例如当天解决的 bug）。')
            : result.logs.map((l) =>
                h(
                  'div',
                  { key: l.id, style: S.card },
                  h(
                    'div',
                    { style: S.row },
                    h('span', { style: S.mono }, l.date),
                    h(Badge, { style: { color: l.kind === 'bug' ? TOKEN.warn : TOKEN.dim } }, KIND_LABEL[l.kind] ?? l.kind),
                    h('strong', null, l.title ?? '(无标题)'),
                    h('span', { style: { flex: 1 } }),
                    h(Badge, null, l.projectName ?? l.projectId ?? '未指定项目'),
                    l.requirementId ? h(Badge, null, l.requirementId) : null,
                    h(Badge, null, l.source === 'session-scan' ? '扫描' : '手工'),
                    l.archivedAt ? h(Badge, { style: { color: TOKEN.warn, borderColor: TOKEN.warn } }, '已归档') : null,
                    h('button', { className: 'dsh-ph-btn', style: S.button, onClick: () => void archiveLog(l.id, !l.archivedAt) }, l.archivedAt ? '恢复' : '归档'),
                  ),
                  l.detail ? h('div', { style: S.pre }, l.detail) : null,
                  l.evidence && l.evidence !== l.detail ? h('div', { style: S.pre }, `证据：${l.evidence}`) : null,
                ),
              )

      const timelineDays = result.days.length
        ? h(
            'div',
            { style: { marginTop: 8 } },
            h('div', { style: { ...S.dim, marginBottom: 4 } }, '按天活动（会话扫描）'),
            ...result.days.slice(0, 14).map((d) =>
              h(
                'div',
                { key: d.date, style: S.dayLine },
                h('span', { style: S.mono }, d.date),
                h('span', { style: S.dim }, `  ${d.msgs} 条消息 / ${d.projects.length} 个项目`),
                ...d.projects.map((p) =>
                  h(
                    'div',
                    { key: `${d.date}-${p.projectId}`, style: { paddingLeft: 8 } },
                    h('span', null, p.projectName ?? p.projectId ?? '未指定项目'),
                    h(
                      'span',
                      { style: S.dim },
                      p.requirements.length ? `：${p.requirements.map((r) => `${r.id}×${r.msgs}`).join('、')}` : '：（无需求号）',
                    ),
                  ),
                ),
              ),
            ),
          )
        : null

      return h(
        'div',
        { style: S.root },
        header,
        scanLine,
        tabRow,
        filters,
        h(Notice, { notice, onClose: () => setNotice(null) }),
        reqForm,
        logForm,
        h('div', { style: S.body }, listBody, view === 'logs' ? null : timelineDays),
      )
    }

    function RequirementDetail(props) {
      const { detail, onChanged } = props
      // hooks 必须先于任何 return 调用（detail 为空时也要走同一套 hook 顺序）
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
      const linkRow = h(
        'div',
        { style: { ...S.row, marginTop: 4 } },
        h(
          'select',
          { style: S.input, value: draft.kind, onChange: (e) => setDraft((p) => ({ ...p, kind: e.target.value })) },
          ...LINK_FORM_KINDS.map((k) => h('option', { key: k, value: k }, LINK_LABEL[k])),
        ),
        h('input', {
          style: { ...S.input, flex: '2 1 200px' },
          value: draft.url,
          placeholder: draft.kind === 'ui' ? 'https://figma.com/… / mastergo / 蓝湖' : 'https://… 或本地路径',
          onChange: (e) => setDraft((p) => ({ ...p, url: e.target.value })),
          onKeyDown: (e) => {
            if (e.key === 'Enter' && draft.url) void runLink('/requirements/link/add', { id: req.id, ...draft })
          },
        }),
        h('input', { style: { ...S.input, flex: '1 1 120px' }, value: draft.title, placeholder: '标题（可空）', onChange: (e) => setDraft((p) => ({ ...p, title: e.target.value })) }),
        h(
          'button',
          {
            className: 'dsh-ph-btn',
            style: S.buttonPrimary,
            disabled: busy || !draft.url,
            onClick: () => void runLink('/requirements/link/add', { id: req.id, ...draft }).then(() => setDraft((p) => ({ ...p, url: '', title: '' }))),
          },
          '＋ 加链接',
        ),
      )
      return h(
        'div',
        { style: { marginTop: 6, borderTop: `1px dashed ${TOKEN.borderSoft}`, paddingTop: 4 } },
        h('div', { style: S.dim }, `状态 ${STATUS_LABEL[req.status] ?? req.status ?? '-'}　创建 ${fmtTime(req.createdAt)}　更新 ${fmtTime(req.updatedAt)}`),
        h('div', { style: { ...S.row, marginTop: 2, flexWrap: 'wrap' } }, links.length === 0 ? h('span', { style: S.dim }, '还没有链接') : renderLinkChips(links, req)),
        // 逐条列出 + 删除（每类可多条，删掉哪条一目了然）
        ...links.map((link) =>
          h(
            'div',
            { key: `lk-${link.id}`, style: { ...S.row, marginTop: 2 } },
            h(Badge, null, link.kindLabel ?? link.kind),
            h('a', { style: { ...S.link, flex: '2 1 160px', wordBreak: 'break-all' }, href: link.url, target: '_blank', rel: 'noreferrer' }, link.title ? `${link.title} — ${link.url}` : link.url),
            link.note ? h('span', { style: S.dim }, link.note) : null,
            h(
              'button',
              {
                className: 'dsh-ph-btn',
                style: S.button,
                disabled: busy,
                onClick: () => void runLink('/requirements/link/remove', { id: req.id, linkId: link.id }),
              },
              '删除',
            ),
          ),
        ),
        linkRow,
        err ? h('div', { style: { ...S.pre, color: TOKEN.danger } }, err) : null,
        req.tags && req.tags.length ? h('div', { style: S.pre }, `标签：${req.tags.join('、')}`) : null,
        h('div', { style: { ...S.dim, marginTop: 4 } }, `开发记录 ${detail.logs.length} 条`),
        ...detail.logs.slice(0, 20).map((l) =>
          h('div', { key: `log-${l.id}`, style: S.pre }, `${l.date} [${KIND_LABEL[l.kind] ?? l.kind}] ${l.title ?? ''}${l.source === 'session-scan' ? '（扫描）' : ''}`),
        ),
        detail.days.length ? h('div', { style: { ...S.dim, marginTop: 4 } }, `按天活动 ${detail.days.length} 天`) : null,
        ...detail.days.slice(0, 10).map((d) =>
          h(
            'div',
            { key: `day-${d.date}`, style: S.pre },
            `${d.date}  ${d.projects.map((p) => `${p.projectName ?? p.projectId}(${p.requirements.map((r) => `${r.id}×${r.msgs}`).join('、') || '无需求号'})`).join('  ')}`,
          ),
        ),
      )
    }

    function RequirementForm(props) {
      const [form, setForm] = useState({ id: '', no: '', project: props.defaultProject ?? '', title: '', status: 'developing', tags: '' })
      /** 链接：每类一个数组（UI / 需求 / WBS / 设计 都可多条）。 */
      const [links, setLinks] = useState(() => ({ doc: [{ url: '', title: '', note: '' }], wbs: [], design: [], ui: [] }))
      const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))
      const setRow = (kind, index, key, value) =>
        setLinks((prev) => ({ ...prev, [kind]: prev[kind].map((row, i) => (i === index ? { ...row, [key]: value } : row)) }))
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
          if (payload.ok && payload.title) {
            setRow(kind, index, 'title', payload.title)
            setForm((prev) => ({ ...prev, title: prev.title || payload.title }))
          } else props.onError(new Error(payload.error ?? '没读到标题'))
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
            h('span', { style: { ...S.dim, minWidth: 56 } }, LINK_LABEL[kind]),
            h('button', { className: 'dsh-ph-btn', style: { ...S.button, padding: '0 6px' }, onClick: () => addRow(kind) }, '＋ 添加一条'),
            (links[kind] ?? []).length > 1 ? h('span', { style: S.dim }, `共 ${links[kind].length} 条`) : null,
          ),
          ...(links[kind] ?? []).map((row, index) =>
            h(
              'div',
              { key: `${kind}-${index}`, style: { ...S.row, marginTop: 2 } },
              h('input', {
                style: { ...S.input, flex: '2 1 200px' },
                value: row.url,
                placeholder: kind === 'ui' ? 'https://figma.com/… / mastergo / 蓝湖' : 'https://… 或本地路径',
                onChange: (e) => setRow(kind, index, 'url', e.target.value),
              }),
              h('input', { style: { ...S.input, flex: '1 1 120px' }, value: row.title, placeholder: '标题', onChange: (e) => setRow(kind, index, 'title', e.target.value) }),
              h('input', { style: { ...S.input, flex: '1 1 100px' }, value: row.note, placeholder: '备注', onChange: (e) => setRow(kind, index, 'note', e.target.value) }),
              kind === 'doc' ? h('button', { className: 'dsh-ph-btn', style: S.button, onClick: () => void readRowTitle(kind, index) }, '读标题') : null,
              h('button', { className: 'dsh-ph-btn', style: S.button, onClick: () => removeRow(kind, index), title: '删掉这条链接' }, '×'),
            ),
          ),
        )
      return h(
        'div',
        { style: { ...S.card, margin: '6px 10px' } },
        h('div', { style: { ...S.row, marginBottom: 4 } }, h('strong', null, '新建 / 更新需求')),
        h(
          'div',
          { style: S.row },
          h(Field, { label: '需求号' }, h('input', { style: S.input, value: form.no, onChange: set('no'), placeholder: '5921' })),
          h(Field, { label: '需求 ID（可空，自动拼 项目-号）' }, h('input', { style: S.input, value: form.id, onChange: set('id'), placeholder: 'SPMS-5921' })),
          h(
            Field,
            { label: '项目' },
            h(
              'select',
              { style: S.input, value: form.project, onChange: set('project') },
              h('option', { value: '' }, '（当前工作区）'),
              ...(props.projects ?? []).map((p) => h('option', { key: p.id, value: p.id }, p.name ? `${p.name}（${p.id}）` : p.id)),
            ),
          ),
          h(Field, { label: '状态' }, h('select', { style: S.input, value: form.status, onChange: set('status') }, ...Object.entries(STATUS_LABEL).map(([k, v]) => h('option', { key: k, value: k }, v)))),
        ),
        h(Field, { label: '标题' }, h('input', { style: S.input, value: form.title, onChange: set('title'), placeholder: '留空则用需求文档标题' })),
        h('div', { style: { ...S.dim, marginTop: 6 } }, '链接（每类都可以加多条；保存时按当前列表整体替换）'),
        ...LINK_FORM_KINDS.map((kind) => linkEditor(kind)),
        h(
          'div',
          { style: S.row },
          h(Field, { label: '标签（逗号分隔）' }, h('input', { style: S.input, value: form.tags, onChange: set('tags') })),
        ),
        h(
          'div',
          { style: { ...S.row, marginTop: 6 } },
          h(
            'button',
            {
              className: 'dsh-ph-btn',
              style: S.buttonPrimary,
              disabled: props.busy,
              onClick: () =>
                props.onSubmit({
                  ...form,
                  links: collectLinks(),
                  replaceLinks: true,
                  tags: form.tags ? form.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean) : undefined,
                }),
            },
            '保存需求',
          ),
          h('span', { style: S.dim }, `　将保存 ${collectLinks().length} 条链接`),
        ),
      )
    }

    function LogForm(props) {
      const [form, setForm] = useState({ date: today(), project: props.defaultProject ?? '', requirement: '', kind: 'bug', title: '', detail: '', minutes: '' })
      const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))
      return h(
        'div',
        { style: { ...S.card, margin: '6px 10px' } },
        h('div', { style: { ...S.row, marginBottom: 4 } }, h('strong', null, '手动加一条开发记录（例如：当天解决的 bug）')),
        h(
          'div',
          { style: S.row },
          h(Field, { label: '日期' }, h('input', { type: 'date', style: S.input, value: form.date, onChange: set('date') })),
          h(
            Field,
            { label: '项目' },
            h(
              'select',
              { style: S.input, value: form.project, onChange: set('project') },
              h('option', { value: '' }, '（当前工作区）'),
              ...(props.projects ?? []).map((p) => h('option', { key: p.id, value: p.id }, p.name ? `${p.name}（${p.id}）` : p.id)),
            ),
          ),
          h(Field, { label: '需求 ID / 号（可空）' }, h('input', { style: S.input, value: form.requirement, onChange: set('requirement'), placeholder: '55036' })),
          h(Field, { label: '类型' }, h('select', { style: S.input, value: form.kind, onChange: set('kind') }, ...KINDS.map((k) => h('option', { key: k, value: k }, KIND_LABEL[k] ?? k)))),
          h(Field, { label: '耗时(分钟)' }, h('input', { style: { ...S.input, width: 70 }, value: form.minutes, onChange: set('minutes') })),
        ),
        h(Field, { label: '标题' }, h('input', { style: S.input, value: form.title, onChange: set('title'), placeholder: '修复 55036 分页越界' })),
        h(Field, { label: '详情' }, h('input', { style: S.input, value: form.detail, onChange: set('detail') })),
        h(
          'div',
          { style: { ...S.row, marginTop: 6 } },
          h(
            'button',
            {
              className: 'dsh-ph-btn',
              style: S.buttonPrimary,
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
            '保存记录',
          ),
        ),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ensureStyles()
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
                description: () => '需求台账 / WBS / 后端设计 / 按天开发记录',
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

      // ③ 页签标题（侧边栏标签文字用我们自己的渲染）
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TYPE_ID }, () => h('span', null, '项目管理')),
          ),
        'dsh-project-hub: sidebar pane title',
      )

      // ④ 打开入口：只 register 不 openTab 时页签存在但没人看见，所以给一个显式打开的方法
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
      // 让侧边栏入口按钮能调到它（座位渲染函数拿不到 apply 的局部变量）
      openPanelRef = openPanel

      // ⑤ 侧边栏入口按钮（用户要求的「入口加在侧边栏里」）：
      //    sidebar.footer.action 是宿主已知合法座位；点击 → 右侧边栏切到项目管理页签。
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
        today,
        KIND_LABEL,
        STATUS_LABEL,
        LINK_LABEL,
        LINK_FORM_KINDS,
        renderLinkChips,
        openSidebar: () => openPanelRef(),
      },
    }
  },
})
