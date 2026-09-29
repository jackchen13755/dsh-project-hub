/**
 * P3：一键「评审影响报告」（DESIGN.md §9.4）。
 *
 * 把前三期的证据拼成一份**评审时能直接念**的东西：
 *   ① 相关历史需求（同 Figma 稿 / 同代码模块 / 同项目同端 / 标题关键词）；
 *   ② 潜在冲突点（按证据强度排序，每条给出处）；
 *   ③ 建议在会上问的问题（模板化，随证据变化）；
 *   ④ 文档缺口（角色/权限、边界异常、兼容、回滚灰度、接口定义、验收标准、数据迁移）。
 *
 * 原则：**只说有证据的话**。任何一条判定都要能指回"哪条需求、哪个模块/哪份稿、哪天"；
 * 证据不足时明确写「证据不足，需要在评审中确认」，绝不编造冲突。冲突的最终判定交给 agent/人。
 */

/** 相关性权重（越大越强）。数值只是排序用，不对外当"概率"。 */
const WEIGHT = {
  figma: 5,
  module: 4,
  design: 3,
  projectPlatform: 2,
  keyword: 1,
}

/** 文档必备章节的检查表（关键词命中就算写了）。 */
const DOC_CHECKS = [
  { key: '权限/角色', words: ['权限', '角色', '谁能', '审批权'] },
  { key: '边界与异常', words: ['边界', '异常', '失败', '为空', '超时', '并发'] },
  { key: '兼容', words: ['兼容', '历史数据', '存量', '旧版本'] },
  { key: '回滚/灰度', words: ['回滚', '灰度', '开关', '降级'] },
  { key: '接口定义', words: ['接口', 'api', '字段', '入参', '出参'] },
  { key: '验收标准', words: ['验收', '测试用例', '预期结果'] },
  { key: '数据迁移', words: ['迁移', '刷数据', '初始化', '脚本'] },
]

/** 中文/英文都取一点：英文按词，中文取 2-gram（够做"标题相似"这种弱信号）。 */
export function titleTokens(title) {
  const text = String(title ?? '')
    .replace(/[【\[（(]\s*\d{1,8}\s*[】\]）)]/g, ' ')
    .toLowerCase()
  const out = new Set()
  for (const word of text.match(/[a-z][a-z0-9-]{2,}/g) ?? []) out.add(word)
  for (const run of text.match(/[\u4e00-\u9fa5]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2))
  }
  return out
}

function sharedTokens(a, b) {
  const left = titleTokens(a)
  const right = titleTokens(b)
  const shared = []
  for (const token of left) if (right.has(token) && token.length >= 2) shared.push(token)
  return shared
}

function modulesOf(requirement) {
  const out = new Map()
  for (const row of requirement?.codeTouches ?? []) {
    const module = row.module ?? row.path
    if (!module) continue
    out.set(module, {
      module,
      commits: Number(row.commits ?? 0),
      files: Number(row.files ?? 0),
      lastSeen: row.lastSeen ?? row.last_seen ?? null,
      sample: row.sample ?? null,
    })
  }
  return out
}

function figmaKeys(requirement) {
  const keys = new Set()
  for (const link of requirement?.links ?? []) {
    const m = String(link.url ?? '').match(/figma\.com\/(?:design|file|board|proto)\/([A-Za-z0-9]+)/i)
    if (m) keys.add(m[1])
  }
  return keys
}

function designDocs(requirement) {
  return (requirement?.links ?? []).filter((l) => l.kind === 'design').map((l) => String(l.url ?? ''))
}

/**
 * 找相关历史需求（按证据强度排序）。目标需求自己不在候选里。
 * @param {any} target 目标需求（含 links / codeTouches / projects）
 * @param {any[]} candidates 台账里的其它需求（同样形状）
 * @returns {Array<{ id, title, score, reasons: string[], sharedModules: string[], sharedFigma: string[], sharedTokens: string[] }>}
 */
export function findRelatedRequirements(target, candidates, { limit = 8 } = {}) {
  const targetModules = modulesOf(target)
  const targetFigma = figmaKeys(target)
  const targetDesign = new Set(designDocs(target))
  const targetProjects = new Set((target?.projects ?? []).map((p) => `${p.projectId}:${p.platform ?? ''}`))
  const rows = []
  for (const candidate of candidates ?? []) {
    if (!candidate?.id || candidate.id === target?.id) continue
    let score = 0
    const reasons = []
    const sharedFigma = []
    for (const key of figmaKeys(candidate)) {
      if (targetFigma.has(key)) {
        sharedFigma.push(key)
        score += WEIGHT.figma
      }
    }
    if (sharedFigma.length) reasons.push(`同一份 Figma 设计稿（${sharedFigma.map((k) => k.slice(0, 10)).join('、')}）`)

    const sharedModules = []
    for (const [module, info] of modulesOf(candidate)) {
      if (!targetModules.has(module)) continue
      sharedModules.push(module)
      score += WEIGHT.module
      reasons.push(`同一代码模块 ${module}（对方 ${info.commits} 次提交，最近 ${info.lastSeen ?? '-'}）`)
    }
    const sharedDesign = designDocs(candidate).filter((url) => targetDesign.has(url))
    if (sharedDesign.length) {
      score += WEIGHT.design
      reasons.push(`同一份后端设计文档（${sharedDesign.length} 条链接相同）`)
    }
    const sameProjectPlatform = (candidate.projects ?? []).some((p) => targetProjects.has(`${p.projectId}:${p.platform ?? ''}`))
    if (sameProjectPlatform) {
      score += WEIGHT.projectPlatform
      reasons.push('同一个项目 + 同一端')
    }
    const tokens = sharedTokens(target?.title, candidate.title).filter((t) => t.length >= 2)
    if (tokens.length) {
      score += WEIGHT.keyword
      reasons.push(`标题关键词重叠：${tokens.slice(0, 4).join('、')}`)
    }
    if (score > 0) rows.push({ id: candidate.id, title: candidate.title ?? null, status: candidate.status ?? null, score, reasons, sharedModules, sharedFigma, sharedTokens: tokens, lastWorkedAt: candidate.lastWorkedAt ?? null })
  }
  rows.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
  return rows.slice(0, limit)
}

/**
 * 对**全文**算一遍必备章节命中标记（抓快照时调用；结果只存标记，不存全文）。
 * @returns {string[]} 命中的章节 key
 */
export function docChecks(fullText) {
  const text = String(fullText ?? '')
  return DOC_CHECKS.filter((item) => item.words.some((word) => text.includes(word))).map((item) => item.key)
}

/**
 * 文档缺口。优先用抓快照时对**全文**算出的标记（`checks`），
 * 没有标记时才退化成扫摘要 —— 摘要只有几百字，正文后面对应的关键词会被漏判（实测踩到假警报）。
 * @param {string|null} excerpt
 * @param {string[]|string|null} checks 命中标记（数组或 JSON 字符串）
 */
export function docGaps(excerpt, checks = null) {
  let present = []
  let source = 'none'
  if (Array.isArray(checks)) {
    present = checks
    source = 'full-text'
  } else if (typeof checks === 'string' && checks.trim() !== '') {
    try {
      const parsed = JSON.parse(checks)
      if (Array.isArray(parsed)) {
        present = parsed
        source = 'full-text'
      }
    } catch {
      /* 坏 JSON 当没有 */
    }
  }
  if (source === 'none') {
    const text = String(excerpt ?? '')
    if (!text) return { checked: false, source, missing: [], present: [] }
    present = DOC_CHECKS.filter((item) => item.words.some((word) => text.includes(word))).map((item) => item.key)
    source = 'excerpt'
  }
  const missing = DOC_CHECKS.filter((item) => !present.includes(item.key)).map((item) => item.key)
  return { checked: true, source, missing, present }
}

/**
 * **复用检查**：评审不只是"会不会冲突"，更要问"能不能不做/能不能沿用"。
 * 证据源：同 Figma 稿（UI/交互可复用）、同代码模块（能力已实现过）、标题关键词（功能面重合）。
 * @returns {Array<{ kind:'ui'|'code'|'feature', id:string, note:string, question:string }>}
 */
export function reuseCheck({ related = [] } = {}) {
  const out = []
  for (const rel of related ?? []) {
    for (const key of rel.sharedFigma ?? []) {
      out.push({
        kind: 'ui',
        id: rel.id,
        note: `同一份 Figma 稿（\`${String(key).slice(0, 12)}\`）：页面/控件大概率是同一批，**交互与视觉可直接沿用** ${rel.id} 的做法`,
        question: `${rel.id} 的那套页面/交互能不能直接复用？如果不能，差在哪（字段/规则/权限）？`,
      })
    }
    for (const module of rel.sharedModules ?? []) {
      out.push({
        kind: 'code',
        id: rel.id,
        note: `同一代码模块 \`${module}\`：${rel.id} 已经在这里实现过相关能力${rel.commits ? `（${rel.commits} 次提交${rel.lastSeen ? `，最近 ${rel.lastSeen}` : ''}）` : ''}`,
        question: `${rel.id} 在 \`${module}\` 的实现是"扩展"还是"重做"？能直接复用的部分有哪些？`,
      })
    }
    if ((rel.sharedFigma ?? []).length === 0 && (rel.sharedModules ?? []).length === 0 && (rel.sharedTokens ?? []).length > 0) {
      out.push({
        kind: 'feature',
        id: rel.id,
        note: `标题关键词重合（${rel.sharedTokens.slice(0, 4).join('、')}）：可能是同一功能面的迭代`,
        question: `与 ${rel.id} 是同一件事的续做，还是两条独立需求？（若续做，历史结论是否还成立）`,
      })
    }
  }
  return out
}

/**
 * **前端交互检查**：从代码落点推"这次会碰哪些前端面"，并提示可复用/风险点。
 * 依据（都来自 git 索引里真实改过的文件）：页面/组件（views/components）、样式（.less/.css）、多语言（locales）。
 */
export function frontendCheck({ target = null, related = [], docSnapshot = null } = {}) {
  const rows = Array.isArray(target?.codeTouches) ? target.codeTouches : []
  const views = new Set()
  const styles = new Set()
  const locales = new Set()
  for (const row of rows) {
    const module = String(row.module ?? row.path ?? '')
    if (/(^|\/)locales?(\/|$)/i.test(module) || /\/locales\//i.test(String(row.path ?? ''))) locales.add(module)
    else if (/\.(less|css|scss)$/i.test(String(row.path ?? ''))) styles.add(module)
    else if (/(^|\/)(views|components)(\/|$)/i.test(module)) views.add(module)
  }
  const sharedFigma = []
  for (const rel of related ?? []) for (const key of rel.sharedFigma ?? []) sharedFigma.push({ id: rel.id, key })
  // 评审时**可能还没有 UI 稿**（很常见）：别假设有 Figma，要如实说清"交互依据在哪"
  const uiLinks = (target?.links ?? []).filter((l) => /figma\.com|mastergo|lanhu|蓝湖|即时设计/i.test(String(l.url ?? '')))
  if (target?.uiUrl && !/figma\.com/i.test(String(target.uiUrl)) === false) uiLinks.push({ url: target.uiUrl })
  const uiMentions = String(docSnapshot?.excerpt ?? '').match(/页面|交互|弹窗|抽屉|按钮|入口|列表|表单|展示|跳转|提示/g)
  return {
    views: [...views].slice(0, 6),
    styles: [...styles].slice(0, 4),
    locales: [...locales].slice(0, 4),
    sharedFigma: sharedFigma.slice(0, 4),
    hasEvidence: rows.length > 0,
    hasUiDraft: uiLinks.length > 0,
    uiDraftCount: uiLinks.length,
    /** 需求正文里有没有提到页面/交互（没稿时这是唯一的交互线索） */
    uiMentions: [...new Set(uiMentions ?? [])].slice(0, 6),
  }
}

/** 生成「建议在会上问的问题」——每条都从证据出发。 */
export function reviewQuestions({ target, related, drift, gaps, coverage }) {
  const out = []
  const targetModules = [...modulesOf(target).keys()]
  for (const rel of (related ?? []).slice(0, 4)) {
    if (rel.sharedFigma.length) {
      out.push(`与 ${rel.id} 改的是**同一份 Figma 稿**：UI 规格谁说了算？改动会不会互相覆盖？需要一起评审还是拆开做？`)
    }
    for (const module of rel.sharedModules.slice(0, 2)) {
      out.push(`与 ${rel.id} 都落在 \`${module}\`：是否共用同一份逻辑/组件？这次改动会不会把对方刚做的行为改回去？`)
    }
    if (!rel.sharedFigma.length && rel.sharedModules.length === 0 && rel.sharedTokens.length) {
      out.push(`与 ${rel.id} 标题关键词重叠（${rel.sharedTokens.slice(0, 3).join('、')}）：确认是同一个功能面的迭代，还是两条独立需求？`)
    }
  }
  if (targetModules.length === 0) {
    out.push(
      `这条需求目前**没有代码落点证据**（可能还没开发，或提交没带需求号；当前项目带号覆盖率 ${coverage === null || coverage === undefined ? '未知' : `${Math.round(Number(coverage) * 100)}%`}）——请在评审里明确：改哪些模块/页面/接口，谁来改。`,
    )
  } else {
    out.push(`已知代码落点：${targetModules.slice(0, 5).join('、')} —— 确认这些模块的**回归范围**与负责人。`)
  }
  if (drift?.verdict === 'doc-stale') {
    out.push(`记录里出现了文档之外的变更（${drift.reason ?? drift.evidence ?? ''}）：评审前先把这些变更补进需求文档，否则后面所有人都会看错版本。`)
  }
  if ((target?.projects ?? []).length > 1) {
    out.push(`这条需求挂在多个项目/端上（${target.projects.map((p) => `${p.projectName ?? p.projectId}${p.platform ? `·${p.platform}` : ''}`).join('、')}）：各端的先后顺序、分支基线、由谁合并，要在会上定。`)
  }
  if (gaps?.checked && gaps.missing.length) {
    out.push(`文档里没看到：${gaps.missing.join('、')} —— 这几项是评审最容易漏、开发最容易返工的地方。`)
  }
  if (out.length === 0) out.push('没有发现明显冲突信号；仍建议确认改动模块与回归范围（当前证据不足，不代表无冲突）。')
  return out
}

/**
 * 组装 Markdown 报告（同时可当"新会话提示词"用）。
 * @param {{ target:any, related:any[], drift:any, gaps:any, docSnapshot:any, coverage:number|null,
 *   project:any, platform:string|null, now?:string }} input
 */
export function renderReviewReport(input) {
  const { target, related = [], drift = null, gaps = null, docSnapshot = null, coverage = null, project = null, platform = null, now = null } = input
  const _reuse = null
  const lines = []
  lines.push(`# 评审影响报告：${target?.id ?? '?'}${target?.title ? ` · ${target.title}` : ''}`)
  lines.push('')
  lines.push(`- 生成时间：${now ?? new Date().toISOString().slice(0, 16).replace('T', ' ')}`)
  const projectList = (target?.projects ?? []).map((p) => `${p.projectName ?? p.projectId}${p.platform ? `·${p.platform}` : ''}${p.primary ? '（主）' : ''}`)
  if (projectList.length) lines.push(`- 开发项目：${projectList.join('、')}`)
  if (project || platform) lines.push(`- 本次目标：${project?.name ?? project?.id ?? '-'}${platform ? ` · 只做 ${platform} 端` : ''}`)
  lines.push(`- 状态：${target?.status ?? '-'}`)
  if (docSnapshot) {
    lines.push(`- 文档快照：${docSnapshot.version ? `v${docSnapshot.version}　` : ''}${docSnapshot.changed_at ? `文档更新于 ${String(docSnapshot.changed_at).slice(0, 10)}　` : ''}摘要 ${String(docSnapshot.excerpt ?? '').length} 字`)
  }
  if (drift) lines.push(`- 漂移对账：**${drift.verdict}**　${drift.evidence ?? ''}`)

  lines.push('')
  lines.push('## 1. 相关历史需求（按证据强度排序）')
  if (related.length === 0) {
    lines.push('（台账里没有找到有证据关联的历史需求 —— 证据不足，不代表没有冲突；建议先把该项目的历史需求补进台账，或人工扫一遍同模块 git 历史）')
  } else {
    for (const rel of related) {
      lines.push(`### ${rel.id}${rel.title ? ` · ${rel.title}` : ''}　（相关度 ${rel.score}${rel.status ? `，状态 ${rel.status}` : ''}）`)
      for (const reason of rel.reasons) lines.push(`- ${reason}`)
    }
  }

  lines.push('')
  lines.push('## 2. 潜在冲突点')
  const conflicts = []
  for (const rel of related) {
    for (const key of rel.sharedFigma) conflicts.push(`- **[强]** 同一份 Figma 设计稿（\`${key}\`）与 ${rel.id} —— 改同一批页面/控件，UI 与交互最容易打架`)
    for (const module of rel.sharedModules) conflicts.push(`- **[强]** 同一代码模块 \`${module}\` 与 ${rel.id} —— 合并冲突与行为回归风险`)
    if (rel.reasons.some((r) => r.includes('后端设计文档'))) conflicts.push(`- **[中]** 与 ${rel.id} 引用同一份后端设计文档 —— 接口口径要一致`)
    if (rel.sharedTokens.length && !rel.sharedModules.length && !rel.sharedFigma.length) conflicts.push(`- **[弱]** 与 ${rel.id} 标题关键词重叠（${rel.sharedTokens.slice(0, 3).join('、')}）—— 可能是同一功能面的迭代`)
  }
  if (drift?.verdict === 'doc-stale') conflicts.push(`- **[强]** 记录里出现了文档之外的变更：${drift.reason ?? drift.evidence ?? ''}`)
  if (conflicts.length === 0) conflicts.push('- 暂无可指认的冲突点（证据不足）。')
  lines.push(...conflicts)

  lines.push('')
  lines.push('## 3. 建议在会上问清楚')
  for (const question of reviewQuestions({ target, related, drift, gaps, coverage })) lines.push(`- ${question}`)

  lines.push('')
  lines.push('## 4. 文档缺口检查')
  if (!gaps?.checked) {
    lines.push('（还没有文档摘要可供检查 —— 先在「变更对账」里抓一次快照）')
  } else if (gaps.missing.length === 0) {
    lines.push(`必备章节都提到了（${gaps.present.join('、')}）`)
  } else {
    lines.push(`没看到的章节：**${gaps.missing.join('、')}**`)
    lines.push(`已看到：${gaps.present.join('、') || '（无）'}`)
  }

  lines.push('')
  lines.push('## 5. 复用检查（能不能不做）')
  // 候选评审时：先看**这批候选内部**谁跟它重（台账里还没有它们，互相比才是唯一线索）
  for (const item of target?.overlaps ?? []) {
    lines.push(`- **同一批候选里可能重复（${item.no}）**：${(item.reasons ?? []).join('；')} —— 这两条是不是一件事？先合并评审或分个先后`)
  }
  const reuse = input.reuse ?? reuseCheck({ related })
  if (reuse.length === 0 && (target?.overlaps ?? []).length === 0) {
    lines.push('（没有找到可指认的复用证据 —— 证据不足，不代表没有可复用的历史实现；建议按模块翻一遍历史需求）')
  } else {
    for (const item of reuse) lines.push(`- **[${{ ui: 'UI/交互', code: '实现', feature: '功能面' }[item.kind] ?? item.kind}] 可能可复用（${item.id}）**：${item.note}`)
  }

  lines.push('')
  lines.push('## 6. 前端交互检查')
  const fe = input.frontend ?? frontendCheck({ target, related, docSnapshot })
  // 没有 UI 稿是很常见的情形：先说清"现在有什么、缺什么"，再给基于代码与文档的交互线索
  if (!fe.hasUiDraft) {
    lines.push('⚠ **这条需求目前没有 UI 稿**（没有 Figma/MasterGo 等设计链接）—— 交互评审不能只看稿，按下面两路先审：')
    lines.push('  1. **从代码推**：下面这些页面/组件是改动落点，交互应当**沿用既有页面**的模式（除非明确要新做）')
    lines.push(`  2. **从需求正文推**：${fe.uiMentions.length ? `正文里提到的界面要素有 ${fe.uiMentions.join('、')}` : '正文里也没看到界面要素描述'}${docSnapshot?.excerpt ? '' : '（还没有文档快照，先在「变更对账」里抓一次）'}`)
  }
  if (!fe.hasEvidence) {
    lines.push('（还没有代码落点，推不出前端影响面 —— 先把该模块的 git 索引扫出来，或让开发在评审里说明改哪些页面）')
  } else {
    if (fe.views.length) lines.push(`- 涉及页面/组件：${fe.views.map((m) => `\`${m}\``).join('、')}`)
    if (fe.styles.length) lines.push(`- 涉及样式面：${fe.styles.map((m) => `\`${m}\``).join('、')}（样式与组件成对出现时，通常是布局/交互改动，回归要覆盖）`)
    if (fe.locales.length) lines.push(`- 涉及多语言文案：${fe.locales.map((m) => `\`${m}\``).join('、')}（7 语言文案长度差异会影响布局，需逐语言过一眼）`)
    for (const item of fe.sharedFigma) lines.push(`- 与 **${item.id}** 改同一份 Figma 稿：交互模式应对齐（同一个页面/控件不要出现两套交互）`)
    lines.push(
      fe.hasUiDraft
        ? '- 建议在评审里确认：**交互模式是沿用既有页面还是新做**、空态/加载/异常态是否与既有页面一致、要不要一起改多语言。'
        : '- 建议在评审里确认（**无稿情形**）：谁来出稿、什么时候出、出稿前按哪套既有交互做；若确定复用历史页面，请点名复用的是哪一条需求的那套交互；空态/加载/异常态怎么办。',
    )
  }

  lines.push('')
  lines.push('## 7. 证据与边界')
  lines.push(`- 代码落点来自 git 索引（带号提交 + 特性合并；当前项目覆盖率 ${coverage === null || coverage === undefined ? '未知' : `${Math.round(Number(coverage) * 100)}%`}）`)
  lines.push('- 相关性只做**证据匹配**（同稿/同模块/同项目端/关键词），**不是冲突概率**；最终判定请读文档与代码后确认')
  lines.push('- 看不到的东西：后台服务与其它仓库、线下沟通、禅道单之外的讨论 —— 这些不会被这份报告覆盖')

  return lines.join('\n')
}
