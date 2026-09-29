/**
 * P0：同 Figma 稿冲突提示（DESIGN.md §9.4 的"便宜先手"）。
 *
 * 判据很硬：两条需求引用**同一个 `figma.com/design/<fileKey>`** —— 改同一份设计稿 = 同一批页面/控件，
 * 冲突概率高。这是不需要 git、不需要联网就能算出来的最强信号，所以先做它。
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { figmaFileKey, figmaKeysOf, figmaOverlaps } from '../lib/link-index.js'
import { buildTools } from '../lib/tools.js'
import { openStore, useTempHome } from './helpers.js'

const PC_DOC = 'https://www.figma.com/design/AAAABBBBcccc/PC-Board?node-id=1-2'
const APP_DOC = 'https://www.figma.com/design/DDDDEEEEffff/APP-Board'
const OTHER_DOC = 'https://www.figma.com/design/ZZZZYYYYxxxx/Other-Board'

let tmp = null
let store = null
let byName = null

beforeEach(() => {
  tmp = useTempHome()
  store = openStore()
  byName = new Map(buildTools({ store, config: {}, version: '0.1.0-test' }).map((t) => [t.name, t]))
})

afterEach(() => {
  try {
    store?.close()
  } catch {
    /* 已关闭 */
  }
  store = null
  tmp?.restore()
  tmp = null
})

test('figmaFileKey：认 design/file/board/proto，非 Figma 返回 null', () => {
  assert.equal(figmaFileKey(PC_DOC), 'AAAABBBBcccc')
  assert.equal(figmaFileKey('https://figma.com/file/XYZ123/Name'), 'XYZ123')
  assert.equal(figmaFileKey('https://mastergo.com/file/123'), null)
  assert.equal(figmaFileKey('https://wiki.example.com/pages/1'), null)
  assert.equal(figmaFileKey(null), null)
})

test('figmaKeysOf：一条需求的多份稿（PC端/APP端）都算，去重', async () => {
  await store.saveRequirement({
    id: 'SPMS-1',
    project: 'spms',
    title: 'A',
    readTitle: false,
    links: [
      { kind: 'ui', url: PC_DOC, title: 'PC端' },
      { kind: 'ui', url: PC_DOC, title: 'PC端-重复' },
      { kind: 'ui', url: APP_DOC, title: 'APP端' },
    ],
  })
  const req = store.attachLinksOne(store.requirementDetail('SPMS-1'))
  assert.equal(figmaKeysOf(req).sort().join(','), 'AAAABBBBcccc,DDDDEEEEffff')
})

test('figmaOverlaps：同稿的两条互相报，不同稿的不报', () => {
  const rows = [
    { id: 'A', title: '甲', links: [{ url: PC_DOC, title: 'PC端' }] },
    { id: 'B', title: '乙', links: [{ url: PC_DOC, title: 'PC端' }] },
    { id: 'C', title: '丙', links: [{ url: OTHER_DOC }] },
  ]
  const map = figmaOverlaps(rows)
  assert.equal(map.get('A').map((x) => x.id).join(','), 'B')
  assert.equal(map.get('B').map((x) => x.id).join(','), 'A')
  assert.equal(map.get('C'), undefined, '没人跟它同稿就不报')
  assert.equal(map.get('A')[0].linkTitle, 'PC端', '带上对方那条链接的标签')
})

test('store：列表与单条都带 figmaOverlaps（同稿/不同稿两种情形）', async () => {
  await store.saveRequirement({ id: 'SPMS-1', project: 'spms', title: '甲', readTitle: false, links: [{ kind: 'ui', url: PC_DOC, title: 'PC端' }] })
  await store.saveRequirement({ id: 'SPMS-2', project: 'spms', title: '乙', readTitle: false, links: [{ kind: 'ui', url: PC_DOC, title: 'PC端' }] })
  await store.saveRequirement({ id: 'SPMS-3', project: 'spms', title: '丙', readTitle: false, links: [{ kind: 'ui', url: OTHER_DOC }] })

  const list = store.listRequirements({}).items
  const byId = new Map(list.map((r) => [r.id, r]))
  assert.equal(byId.get('SPMS-1').figmaOverlaps.map((o) => o.id).join(','), 'SPMS-2')
  assert.equal(byId.get('SPMS-2').figmaOverlaps.map((o) => o.id).join(','), 'SPMS-1')
  assert.equal(byId.get('SPMS-3').figmaOverlaps.length, 0)

  const single = store.attachLinksOne(store.requirementDetail('SPMS-1'))
  assert.equal(single.figmaOverlaps.map((o) => o.id).join(','), 'SPMS-2')

  // 归档掉对方后不再报警（归档的东西不该继续制造噪声）
  store.archiveRequirement('SPMS-2', true)
  assert.equal(store.attachLinksOne(store.requirementDetail('SPMS-1')).figmaOverlaps.length, 0)
})

test('工具面：ph_get_requirement 打出同稿冲突信号', async () => {
  await store.saveRequirement({ id: 'SPMS-1', project: 'spms', title: '甲', readTitle: false, links: [{ kind: 'ui', url: PC_DOC, title: 'PC端' }] })
  await store.saveRequirement({ id: 'SPMS-2', project: 'spms', title: '乙', readTitle: false, links: [{ kind: 'ui', url: PC_DOC, title: 'PC端' }] })
  const got = await byName.get('ph_get_requirement').execute({ id: 'SPMS-1' })
  assert.match(got.text, /同稿冲突信号/)
  assert.match(got.text, /SPMS-2/)
})
