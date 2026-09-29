/**
 * lib/doc-title.js —— 需求文档标题读取（R4）。
 *
 * 覆盖：站点后缀剥离（已知/未知）、<h1> 兜底、front-matter 优先于 H1、本地文件、
 * `resolveDocTitle` 注入假 fetchImpl 的 HTTP 200 / 404 / 超时（AbortError）三条路径。
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { DEFAULT_TIMEOUT_MS, isUrl, resolveDocTitle, stripSiteSuffix, titleFromHtml, titleFromText } from '../lib/doc-title.js'
import { cleanupScratch, makeScratch, writeFixture } from './helpers.js'

let scratch = null
let files = {}

before(() => {
  scratch = makeScratch('ph-test-doctitle')
  files = {
    frontmatter: writeFixture(scratch, 'a.md', ['---', 'title: 需求甲：分页越界修复', 'owner: zhe', '---', '', '# 需求乙（不该被选中）', ''].join('\n')),
    h1: writeFixture(scratch, 'b.md', '# 本地需求标题\n\n正文\n'),
    noTitle: writeFixture(scratch, 'c.md', '没有任何标题的一段正文。\n'),
    html: writeFixture(scratch, 'd.html', '<html><head><title>站点需求 - 禅道</title></head><body><h1>正文里的 H1</h1></body></html>'),
    // front-matter 在开头，正文很长：截断后 front-matter 的收尾 `---` 落在切点之后
    truncated: writeFixture(scratch, 'truncated.md', `---\ntitle: FAR-TITLE\n---\n${'x'.repeat(200)}\n`),
  }
})

after(() => cleanupScratch(scratch))

test('doc-title: <title>需求名 - 禅道</title> → 需求名（已知站点后缀剥离）', () => {
  const html = '<html><head><title>需求名 - 禅道</title></head><body></body></html>'
  const out = titleFromHtml(html)
  assert.equal(out.title, '需求名')
  assert.equal(out.rawTitle, '需求名 - 禅道')
  assert.equal(out.source, 'html-title')
  // 直连 stripSiteSuffix 也验一遍（含其它已知站点与重复尾缀）
  assert.equal(stripSiteSuffix('需求名 - 禅道'), '需求名')
  assert.equal(stripSiteSuffix('SPMS 需求 — Confluence'), 'SPMS 需求')
  assert.equal(stripSiteSuffix('需求名 - 语雀 - 禅道'), '需求名')
  assert.equal(stripSiteSuffix('  多余   空白  '), '多余 空白')
})

test('doc-title: 未知站点后缀不剥离（需求标题自带破折号不能被切）', () => {
  assert.equal(stripSiteSuffix('需求名 - 某某内部系统'), '需求名 - 某某内部系统')
  const out = titleFromHtml('<title>需求名 - 某某内部系统</title>')
  assert.equal(out.title, '需求名 - 某某内部系统')
  assert.equal(out.rawTitle, '需求名 - 某某内部系统')
})

test('doc-title: <h1> 兜底（无 title / title 为空时）', () => {
  const onlyH1 = titleFromHtml('<html><body><h1>只有 H1 的标题</h1></body></html>')
  assert.equal(onlyH1.title, '只有 H1 的标题')
  assert.equal(onlyH1.source, 'html-h1')

  const emptyTitle = titleFromHtml('<html><head><title>   </title></head><body><h1>空 title 时用 H1</h1></body></html>')
  assert.equal(emptyTitle.title, '空 title 时用 H1')
  assert.equal(emptyTitle.source, 'html-h1')

  // 实体与标签都要洗掉
  assert.equal(titleFromHtml('<title>A &amp; B &lt;分页&gt;</title>').title, 'A & B <分页>')

  // 一个都没有 → 只有给了 fallback 才返回
  assert.equal(titleFromHtml('<div>正文</div>'), null)
  assert.equal(titleFromHtml('<div>正文</div>', '兜底名').title, '兜底名')
  assert.equal(titleFromHtml('<div>正文</div>', '兜底名').source, 'filename')
})

test('doc-title: markdown front-matter title 优先于 # H1', () => {
  const md = ['---', 'title: 需求甲', 'tags: [a]', '---', '', '# 需求乙', ''].join('\n')
  const out = titleFromText(md)
  assert.equal(out.title, '需求甲')
  assert.equal(out.source, 'markdown-frontmatter')

  const quoted = titleFromText("---\ntitle: \"带引号的标题\"\n---\n# 别的\n")
  assert.equal(quoted.title, '带引号的标题')

  const noFm = titleFromText('# 需求乙\n正文\n')
  assert.equal(noFm.title, '需求乙')
  assert.equal(noFm.source, 'markdown-h1')

  // front-matter 里没有 title 时继续走 H1
  const fmWithoutTitle = titleFromText('---\nowner: zhe\n---\n# 走 H1\n')
  assert.equal(fmWithoutTitle.title, '走 H1')
  assert.equal(fmWithoutTitle.source, 'markdown-h1')

  // 站点后缀剥离只作用于 <title>；front-matter 原样采用（DESIGN §4）
  assert.equal(titleFromText('---\ntitle: 需求甲 - 禅道\n---\n').title, '需求甲 - 禅道')
})

test('doc-title: 本地文件读标题（front-matter / H1 / 文件名兜底 / file:// / 缺失 / 空值）', async () => {
  const fm = await resolveDocTitle(files.frontmatter)
  assert.equal(fm.ok, true)
  assert.equal(fm.title, '需求甲：分页越界修复')
  assert.equal(fm.source, 'markdown-frontmatter')
  assert.equal(fm.ref, files.frontmatter)

  const h1 = await resolveDocTitle(files.h1)
  assert.equal(h1.ok, true)
  assert.equal(h1.title, '本地需求标题')
  assert.equal(h1.source, 'markdown-h1')

  const html = await resolveDocTitle(files.html)
  assert.equal(html.ok, true)
  assert.equal(html.title, '站点需求')
  assert.equal(html.rawTitle, '站点需求 - 禅道')
  assert.equal(html.source, 'html-title')

  const fallback = await resolveDocTitle(files.noTitle)
  assert.equal(fallback.ok, true)
  assert.equal(fallback.title, 'c')
  assert.equal(fallback.source, 'filename')

  const asUrl = await resolveDocTitle(`file://${files.h1}`)
  assert.equal(asUrl.ok, true)
  assert.equal(asUrl.title, '本地需求标题')

  const missing = await resolveDocTitle(join(scratch, 'nope.md'))
  assert.equal(missing.ok, false)
  assert.equal(missing.source, 'missing')
  assert.equal(missing.title, null)
  assert.match(missing.error, /本地文件不存在/)

  const empty = await resolveDocTitle('   ')
  assert.equal(empty.ok, false)
  assert.equal(empty.source, 'empty')

  assert.equal(isUrl('https://a.test/x'), true)
  assert.equal(isUrl(' file:///tmp/x '), false)
  assert.equal(DEFAULT_TIMEOUT_MS, 12000)
})

test('doc-title: 本地文件 maxBytes 截断（标题在截断之后 → 兜底文件名）', async () => {
  const cut = await resolveDocTitle(files.truncated, { maxBytes: 16 })
  assert.equal(cut.ok, true)
  assert.equal(cut.title, 'truncated')
  assert.equal(cut.source, 'filename')

  const full = await resolveDocTitle(files.truncated)
  assert.equal(full.title, 'FAR-TITLE')
  assert.equal(full.source, 'markdown-frontmatter')
})

test('doc-title: 注入 fetchImpl —— HTTP 200（<title> 优先，带 signal）', async () => {
  const seen = {}
  const fetchImpl = async (url, init) => {
    seen.url = url
    seen.signal = Boolean(init?.signal)
    seen.accept = init?.headers?.accept
    return {
      ok: true,
      status: 200,
      text: async () => '<html><head><title>分页越界 - 禅道</title></head><body><h1>正文 H1 干扰项</h1></body></html>',
    }
  }
  const out = await resolveDocTitle('https://example.test/req/5921', { fetchImpl })
  assert.equal(seen.url, 'https://example.test/req/5921')
  assert.equal(seen.signal, true)
  assert.match(seen.accept, /text\/html/)
  assert.equal(out.ok, true)
  assert.equal(out.title, '分页越界')
  assert.equal(out.rawTitle, '分页越界 - 禅道')
  assert.equal(out.source, 'html-title')
  assert.equal(out.status, 200)
  assert.equal(out.ref, 'https://example.test/req/5921')

  // 只有 <h1> 的页面
  const h1Only = await resolveDocTitle('https://example.test/h1', {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html><body><h1>接口文档标题</h1></body></html>' }),
  })
  assert.equal(h1Only.title, '接口文档标题')
  assert.equal(h1Only.source, 'html-h1')

  // 页面里没有任何标题
  const noTitle = await resolveDocTitle('https://example.test/empty', {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html><body>正文</body></html>' }),
  })
  assert.equal(noTitle.ok, false)
  assert.equal(noTitle.source, 'no-title')
})

test('doc-title: 注入 fetchImpl —— HTTP 404', async () => {
  const out = await resolveDocTitle('https://example.test/gone', {
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => 'not found' }),
  })
  assert.equal(out.ok, false)
  assert.equal(out.title, null)
  assert.equal(out.source, 'http-error')
  assert.equal(out.status, 404)
  assert.equal(out.error, 'HTTP 404')

  // 网络层直接抛（DNS/连接失败）
  const boom = await resolveDocTitle('https://example.test/boom', {
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED')
    },
  })
  assert.equal(boom.ok, false)
  assert.equal(boom.source, 'fetch-failed')
  assert.match(boom.error, /ECONNREFUSED/)
})

test('doc-title: 注入 fetchImpl —— 超时（AbortError）', async () => {
  let aborted = false
  // resolveDocTitle 内部的超时定时器是 unref 的，这里用一个 ref 的定时器保住事件循环
  const keepAlive = setTimeout(() => {}, 2000)
  try {
    const slowFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const onAbort = () => {
          aborted = true
          const error = new Error('The operation was aborted')
          error.name = 'AbortError'
          reject(error)
        }
        assert.ok(init?.signal, '超时依赖 init.signal')
        if (init.signal.aborted) onAbort()
        else init.signal.addEventListener('abort', onAbort, { once: true })
      })
    const started = Date.now()
    const out = await resolveDocTitle('https://slow.test/req', { fetchImpl: slowFetch, timeoutMs: 40 })
    const elapsed = Date.now() - started
    assert.equal(aborted, true)
    assert.equal(out.ok, false)
    assert.equal(out.title, null)
    assert.equal(out.source, 'fetch-failed')
    assert.match(out.error, /abort/i)
    assert.ok(elapsed >= 30, `应该等满超时（实测 ${elapsed}ms）`)
    assert.ok(elapsed < 1500, `不该等太久（实测 ${elapsed}ms）`)
  } finally {
    clearTimeout(keepAlive)
  }
})

test('doc-title: fetchImpl 流式 body 的有界读取（超 maxBytes 就 cancel）', async () => {
  const chunks = [Buffer.from('<title>流式标题 - 语雀</title>'), Buffer.from('y'.repeat(5000))]
  let index = 0
  let cancelled = false
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => (index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }),
        cancel: async () => {
          cancelled = true
        },
      }),
    },
  })
  const out = await resolveDocTitle('https://stream.test/big', { fetchImpl, maxBytes: 100 })
  assert.equal(out.ok, true)
  assert.equal(out.title, '流式标题')
  assert.equal(cancelled, true, '超过 maxBytes 必须 cancel 掉 reader')
})
