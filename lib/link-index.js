/**
 * 链接层面的「撞车」检测 —— 目前只做最有效的一种：**同一份 Figma 设计稿被多条需求引用**。
 *
 * 为什么先做这个：UI 稿是"同一个页面/同一批控件"的强证据，比文档措辞可靠得多；
 * 两条需求改同一份稿，冲突概率极高（实测本机台账里就有）。
 * 而且不需要任何外部依赖 —— 链接 URL 里就带 `figma.com/design/<fileKey>`。
 */
const FIGMA_FILE_RE = /figma\.com\/(?:design|file|board|proto)\/([A-Za-z0-9]+)/i

/** 从任意 UI 链接里取 Figma fileKey；不是 Figma 链接返回 null。 */
export function figmaFileKey(url) {
  const m = String(url ?? '').match(FIGMA_FILE_RE)
  return m ? m[1] : null
}

/** 一条需求引用到的全部 Figma fileKey（去重）。 */
export function figmaKeysOf(requirement) {
  const keys = new Set()
  for (const link of requirement?.links ?? []) {
    const key = figmaFileKey(link.url)
    if (key) keys.add(key)
  }
  for (const url of [requirement?.uiUrl]) {
    const key = figmaFileKey(url)
    if (key) keys.add(key)
  }
  return [...keys]
}

/**
 * 批量算「同稿需求」：返回 `Map<需求ID, [{id,title,linkTitle,fileKey}]>`。
 * 只看彼此都引用了同一 fileKey 的需求（自己不算），同一对手只报一次。
 */
export function figmaOverlaps(requirements) {
  const byKey = new Map()
  for (const req of requirements ?? []) {
    if (!req?.id) continue
    for (const key of figmaKeysOf(req)) {
      if (!byKey.has(key)) byKey.set(key, [])
      byKey.get(key).push(req)
    }
  }
  const out = new Map()
  for (const [fileKey, reqs] of byKey) {
    if (reqs.length < 2) continue
    for (const req of reqs) {
      const others = reqs.filter((other) => other.id !== req.id)
      if (others.length === 0) continue
      if (!out.has(req.id)) out.set(req.id, [])
      const seen = new Set(out.get(req.id).map((item) => item.id))
      for (const other of others) {
        if (seen.has(other.id)) continue
        seen.add(other.id)
        out.get(req.id).push({
          id: other.id,
          title: other.title ?? null,
          fileKey,
          linkTitle: (other.links ?? []).find((l) => figmaFileKey(l.url) === fileKey)?.title ?? null,
        })
      }
    }
  }
  return out
}
