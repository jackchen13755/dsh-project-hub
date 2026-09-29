/**
 * 文档页面里的「结构化信息」：谁创建的、谁是产品、以及页面自带的 UI 设计链接。
 *
 * 这些断言全部来自用户给的一条真实 Confluence 页面（`…/pages/viewpage.action?pageId=…`）实测：
 *   · 标题在 `<h1 id="title-text">`，`<title>` 会带 ` - 空间 - 站点` 后缀，REST 的 title 最干净；
 *   · 正文「相关人员」表：`产品：X` / `UI：Y` / `前端：Z` / `后端：…` / `QA：…`；
 *   · 「UI 文件」表：`PC端：<figma>` / `APP端：<figma>`；
 *   · **服务端 HTML 里没有创建者**，且页面 JS 包里有一行 `//作者 xxx@…` 的插件作者注释
 *     —— 拿它当创建者就是误判，所以创建者只认 Confluence REST / 正文里的显式字段。
 *
 * 夹具里的人名、邮箱、域名一律是假的（真实数据不能进仓库）。
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import {
  applyConfluenceMeta,
  confluenceApiUrl,
  confluencePageId,
  htmlToText,
  pageTitle,
  parseDocMeta,
  parseRoles,
  parseUiLinks,
  stripConfluenceSuffix,
} from '../lib/doc-meta.js'
import { resolveDocTitle } from '../lib/doc-title.js'
import { openStore, useTempHome } from './helpers.js'

let tmp = null
beforeEach(() => {
  tmp = useTempHome()
})
afterEach(() => {
  tmp?.restore()
  tmp = null
})

/** Confluence 风格页面（结构照着真实页面裁出来的，内容全部替换成假数据）。 */
const CONFLUENCE_HTML = `<!doctype html><html><head>
<title>【5922】Queue 数据记录 - Demo Space - Example Wiki</title>
</head><body>
<h1 id="logo">Example Wiki</h1>
<h1 id="title-text" class="with-breadcrumbs">【5922】Queue 数据记录</h1>
<div class="page-metadata" id="page-metadata-banner">JIRA 链接 | 回到标题开始 | 【5922】Queue 数据记录</div>
<table><tbody>
<tr><td>相关人员</td></tr>
<tr><td><p>产品：张三</p><p>UI：李四</p><p>前端：王五</p><p>后端：赵六 孙七</p><p>QA：钱八</p></td></tr>
<tr><td><p>UI 文件</p><p>PC端：<a href="https://www.figma.com/design/AAAA/PC-Board?node-id=1-2">PC</a></p>
<p>APP端：https://www.figma.com/design/BBBB/APP-Board</p></td></tr>
</tbody></table>
<script>var conf = { credit: '//作者 someone@example.com' }</script>
</body></html>`

test('pageTitle：优先 #title-text，其次 <title>（剥 Confluence 后缀），最后正文 h1（跳过 logo）', () => {
  assert.equal(pageTitle(CONFLUENCE_HTML), '【5922】Queue 数据记录')
  assert.equal(pageTitle('<title>需求说明书 - 禅道</title><h1>别的</h1>'), '需求说明书 - 禅道', '非 Confluence 后缀不动')
  assert.equal(stripConfluenceSuffix('【5922】Queue 数据记录 - Demo Space - Example Wiki'), '【5922】Queue 数据记录')
  assert.equal(stripConfluenceSuffix('标题 - 带一段后缀'), '标题 - 带一段后缀', '只有一段后缀不动手')
  assert.equal(pageTitle('<h1 id="logo">站点名</h1><h1>真正的标题</h1>'), '真正的标题')
})

test('htmlToText：剥脚本/样式、保留换行（JS 包里的字符串不能污染解析）', () => {
  const text = htmlToText(CONFLUENCE_HTML)
  assert.ok(!text.includes('someone@example.com'), 'script 里的内容必须被剥掉')
  assert.ok(text.includes('产品：张三'))
  assert.ok(text.includes('\n'))
})

test('parseRoles：认角色表，值是多人时截到下一个角色键之前', () => {
  const roles = parseRoles(htmlToText(CONFLUENCE_HTML))
  assert.equal(roles['产品'], '张三')
  assert.equal(roles['UI'], '李四')
  assert.equal(roles['前端'], '王五')
  assert.equal(roles['QA'], '钱八')
  assert.ok(roles['后端'].startsWith('赵六'), `后端应拿到人，实际 ${roles['后端']}`)
  assert.ok(!/QA/.test(roles['后端']), '不能把下一个角色名粘进值里')
})

test('parseDocMeta：标题 + 谁是产品 + UI 链接（带 PC端/APP端 标签、去重）', () => {
  const meta = parseDocMeta(CONFLUENCE_HTML, { url: 'https://wiki.example.com/pages/viewpage.action?pageId=1' })
  assert.equal(meta.title, '【5922】Queue 数据记录')
  assert.equal(meta.product, '张三', '「谁是产品」= 角色表里的 产品')
  const urls = meta.uiLinks.map((l) => l.url)
  assert.equal(urls.length, 2)
  assert.ok(urls.every((u) => u.startsWith('https://www.figma.com/')), `只收设计稿站点的链接：${urls}`)
  assert.equal(meta.uiLinks[0].title, 'PC端')
  assert.equal(meta.uiLinks[1].title, 'APP端')

  // 重复 URL 只收一次；非设计稿站点不收
  const twice = parseUiLinks('PC端：https://www.figma.com/x 备份：https://www.figma.com/x 需求：https://wiki.example.com/pages/1')
  assert.equal(twice.length, 1)
  assert.equal(parseUiLinks('什么都没有').length, 0)
})

test('parseDocMeta：页面里没有角色表时，product 为 null（不瞎猜）', () => {
  const meta = parseDocMeta('<html><head><title>T</title></head><body><h1>标题</h1><p>正文</p></body></html>')
  assert.equal(meta.product, null)
  assert.deepEqual(meta.uiLinks, [])
})

test('Confluence：从 URL 推出 REST 地址，并把创建者/空间/时间并进来', () => {
  assert.equal(confluencePageId('https://wiki.example.com/pages/viewpage.action?pageId=161331405'), '161331405')
  assert.equal(confluencePageId('https://wiki.example.com/spaces/SS/pages/123456/Title'), '123456')
  assert.equal(confluencePageId('https://wiki.example.com/display/SS/Title'), null)
  assert.equal(
    confluenceApiUrl('https://wiki.example.com/pages/viewpage.action?pageId=161331405'),
    'https://wiki.example.com/rest/api/content/161331405?expand=history,version,space,metadata.labels',
  )
  assert.equal(confluenceApiUrl('/pages/viewpage.action?pageId=1'), null, '相对路径不打 REST')

  const base = parseDocMeta(CONFLUENCE_HTML)
  const merged = applyConfluenceMeta(base, {
    title: '【5922】Queue 数据记录',
    space: { key: 'SS', name: 'Demo Space' },
    history: { createdBy: { displayName: 'Zhang San' }, createdDate: '2026-07-23T15:03:57.000+08:00' },
    version: { by: { displayName: 'Li Si' }, when: '2026-08-01T10:00:00.000+08:00' },
  })
  assert.equal(merged.creator, 'Zhang San', '创建者只来自 REST')
  assert.equal(merged.updatedBy, 'Li Si')
  assert.equal(merged.space, 'Demo Space')
  assert.equal(merged.createdDate, '2026-07-23T15:03:57.000+08:00')
  assert.equal(merged.product, '张三', 'REST 不影响正文解析出来的产品')
})

test('resolveDocTitle：Confluence 页面 → 干净标题 + 创建人 + 产品 + UI 链接', async () => {
  const restJson = JSON.stringify({
    title: '【5922】Queue 数据记录',
    space: { key: 'SS', name: 'Demo Space' },
    history: { createdBy: { displayName: 'Zhang San' }, createdDate: '2026-07-23T15:03:57.000+08:00' },
    version: { by: { displayName: 'Li Si' }, when: '2026-08-01T10:00:00.000+08:00' },
  })
  const result = await resolveDocTitle('https://wiki.example.com/pages/viewpage.action?pageId=161331405', {
    fetchText: async (url) =>
      url.includes('/rest/api/content/')
        ? { ok: true, text: restJson, strategy: 'bridge', status: 200 }
        : { ok: true, text: CONFLUENCE_HTML, strategy: 'bridge', status: 200 },
  })
  assert.equal(result.ok, true)
  assert.equal(result.title, '【5922】Queue 数据记录', 'REST 的干净标题优先')
  assert.equal(result.creator, 'Zhang San')
  assert.equal(result.product, '张三')
  assert.equal(result.roles['前端'], '王五')
  assert.equal(result.uiLinks.length, 2)
  assert.equal(result.space, 'Demo Space')
  assert.equal(result.viaSession, true)
})

test('resolveDocTitle：REST 挂掉不影响标题（创建人留空，其余照常）', async () => {
  const result = await resolveDocTitle('https://wiki.example.com/pages/viewpage.action?pageId=999', {
    fetchText: async (url) => {
      if (url.includes('/rest/api/content/')) throw new Error('REST 500')
      return { ok: true, text: CONFLUENCE_HTML, strategy: 'bridge', status: 200 }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.title, '【5922】Queue 数据记录')
  assert.equal(result.creator, null)
  assert.equal(result.product, '张三')
  assert.equal(result.uiLinks.length, 2)
})

test('store：读文档时自动落 creator/product/roles，并把 UI 链接并入需求', async () => {
  const store = openStore()
  try {
    const file = `${tmp.dir}/prd.md`
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      file,
      ['# 【5922】Queue 数据记录', '', '产品：张三', 'UI：李四', 'QA：钱八', '', 'PC端：https://www.figma.com/design/AAAA/PC'].join('\n'),
    )
    const saved = await store.saveRequirement({ project: 'spms', docUrl: file, readTitle: true })
    assert.equal(saved.requirement.id, 'SPMS-5922', '需求号来自标题')
    assert.equal(saved.requirement.product, '张三')
    assert.equal(saved.requirement.roles['QA'], '钱八')
    assert.equal(saved.uiFromDoc, 1, '页面里的 UI 链接自动并入')
    const ui = store.listLinks('SPMS-5922').filter((l) => l.kind === 'ui')
    assert.equal(ui.length, 1)
    assert.equal(ui[0].title, 'PC端')
    assert.match(ui[0].note, /读文档时自动带入/)

    // 再存一次：不重复（唯一索引 + OR IGNORE）
    const again = await store.saveRequirement({ project: 'spms', docUrl: file, readTitle: true })
    assert.equal(again.uiFromDoc, 0)
    assert.equal(store.listLinks('SPMS-5922').filter((l) => l.kind === 'ui').length, 1)

    // 显式传的 creator/product 优先于文档里读到的
    const override = await store.saveRequirement({ id: 'SPMS-5922', project: 'spms', creator: '手动填的人', product: '手动产品', readTitle: false })
    assert.equal(override.requirement.creator, '手动填的人')
    assert.equal(override.requirement.product, '手动产品')
  } finally {
    store.close()
  }
})
