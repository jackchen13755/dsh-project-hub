/**
 * 文档快照（P2）：给一条需求的文档拍一次「指纹」，用于漂移对账。
 *
 * **刻意只存版本号 + 正文 hash + 摘要，不存全文**：
 *   · 判断"变没变"只需要 hash / 版本号；
 *   · 判断"变了哪段"有摘要足够给线索；
 *   · 全文留在事实源（Confluence/禅道），本地少一份可能含敏感信息的副本；
 *     需要正文时现场带登录态读（浏览器中继那条链路）。
 */
import { hashText, excerptOf } from './drift.js'
import { docChecks } from './review.js'
import { confluenceApiUrl, parseDocMeta } from './doc-meta.js'
import { fetchPage } from './page-fetch.js'

/**
 * 拉一次文档并算出快照。
 * @param {string} url 文档地址（http(s) 或本地路径）
 * @param {{ fetchText?: Function, env?: object, timeoutMs?: number, excerptLimit?: number }} [opts]
 * @returns {Promise<{ ok:boolean, url:string, title:string|null, version:string|null, hash:string|null,
 *   excerpt:string|null, changedAt:string|null, error?:string, strategy?:string }>}
 */
export async function snapshotDoc(url, opts = {}) {
  const { env = process.env, timeoutMs = 15000, excerptLimit = 400, fetchText = null } = opts
  const target = String(url ?? '').trim()
  if (!target) return { ok: false, url: target, title: null, version: null, hash: null, excerpt: null, changedAt: null, error: '空的文档地址' }

  const page = typeof fetchText === 'function'
    ? await fetchText(target)
    : /^https?:\/\//i.test(target)
      ? await fetchPage(target, { env, timeoutMs })
      : { ok: false, error: '本地文件请走 resolveDocTitle' }
  if (!page?.ok || !page.text) {
    return { ok: false, url: target, title: null, version: null, hash: null, excerpt: null, changedAt: null, error: page?.error ?? '取页失败' }
  }

  const meta = parseDocMeta(page.text, { url: target })
  let version = null
  let changedAt = null
  let title = meta.title ?? null

  // Confluence：版本号与最后更新时间在 REST 里（服务端 HTML 没有）—— 有 pageId 才打
  const apiUrl = confluenceApiUrl(target)
  if (apiUrl) {
    try {
      const rest = typeof fetchText === 'function' ? await fetchText(apiUrl) : await fetchPage(apiUrl, { env, timeoutMs })
      if (rest?.ok && rest.text) {
        const json = JSON.parse(rest.text)
        if (json?.title) title = String(json.title)
        if (json?.version?.number !== undefined) version = String(json.version.number)
        changedAt = json?.version?.when ?? json?.history?.lastUpdated?.when ?? null
      }
    } catch {
      /* REST 拿不到不影响 hash 对账 */
    }
  }

  return {
    ok: true,
    url: target,
    title,
    version,
    hash: hashText(meta.text),
    excerpt: excerptOf(meta.text, { limit: excerptLimit }),
    /** 全文关键词命中标记（只存标记，不存全文）—— 文档缺口检查用它，避免摘要截断造成假警报 */
    checks: docChecks(meta.text),
    changedAt,
    strategy: page.strategy ?? null,
  }
}
