/**
 * 默认排序：**新到旧**（用户要求）。
 *
 * 需求列表原先按「最近开发」排（`last_worked_at DESC`），刚建的需求会被压在一堆老需求下面；
 * 现在默认按 `created_at DESC`，另外两种口径保留成可切换的排序。
 * 开发记录本来就是新到旧（`date DESC, id DESC`），这里一并钉住，避免以后改坏。
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { openStore, useTempHome } from './helpers.js'

let tmp = null
let store = null

beforeEach(() => {
  tmp = useTempHome()
  store = openStore()
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

/** 依次建三条需求，保证 created_at 严格递增（同毫秒会让断言不稳）。 */
async function seedThree() {
  const ids = []
  for (const [id, title] of [
    ['SPMS-1', '最早建的'],
    ['SPMS-2', '中间建的'],
    ['SPMS-3', '最新建的'],
  ]) {
    const saved = await store.saveRequirement({ id, project: 'spms', title, readTitle: false })
    ids.push(saved.requirement.id)
    await new Promise((resolve) => setTimeout(resolve, 3))
  }
  return ids
}

test('默认排序：新建的排最前（新到旧）', async () => {
  await seedThree()
  const items = store.listRequirements({}).items
  assert.equal(items.map((r) => r.id).join(' > '), 'SPMS-3 > SPMS-2 > SPMS-1')

  // 即使最早那条「最近被开发过」，默认排序也不动
  store.addLog({ date: '2026-09-29', project: 'spms', requirement: 'SPMS-1', title: '今天动了它' })
  store.db.prepare("UPDATE requirements SET last_worked_at = '2026-09-29' WHERE id = 'SPMS-1'").run()
  assert.equal(store.listRequirements({}).items.map((r) => r.id).join(' > '), 'SPMS-3 > SPMS-2 > SPMS-1')

  // 显式切到「最近开发」→ 老需求浮上来（老行为仍可用）
  assert.equal(store.listRequirements({ sort: 'worked' }).items.map((r) => r.id).join(' > '), 'SPMS-1 > SPMS-3 > SPMS-2')
  // 未知值回落到默认，不抛
  assert.equal(store.listRequirements({ sort: '乱写' }).items.map((r) => r.id).join(' > '), 'SPMS-3 > SPMS-2 > SPMS-1')
})

test('编辑旧需求后：默认排序不变，updated 口径能把它顶上来', async () => {
  await seedThree()
  await store.saveRequirement({ id: 'SPMS-1', project: 'spms', title: '最早建的（改过）', readTitle: false })
  assert.equal(store.listRequirements({ sort: 'created' }).items.map((r) => r.id).join(' > '), 'SPMS-3 > SPMS-2 > SPMS-1')
  assert.equal(store.listRequirements({ sort: 'updated' }).items[0].id, 'SPMS-1')
})

test('筛选后的排序照样是新到旧（项目 / 标签 / 归档）', async () => {
  await seedThree()
  await store.saveRequirement({ id: 'HS-9', project: 'hs_config', title: '别的项目', readTitle: false, tags: ['待评审'] })
  assert.equal(store.listRequirements({ project: 'spms' }).items.map((r) => r.id).join(' > '), 'SPMS-3 > SPMS-2 > SPMS-1')
  assert.equal(store.listRequirements({ tag: '待评审' }).items.map((r) => r.id).join(' > '), 'HS-9')
  store.archiveRequirement('SPMS-2', true)
  assert.equal(store.listRequirements({ archived: 'only' }).items.map((r) => r.id).join(' > '), 'SPMS-2')
})

test('开发记录本来就是新到旧（date DESC, id DESC），不受需求排序影响', async () => {
  store.addLog({ date: '2026-09-27', project: 'spms', title: '前天' })
  store.addLog({ date: '2026-09-29', project: 'spms', title: '今天 A' })
  store.addLog({ date: '2026-09-29', project: 'spms', title: '今天 B' })
  const items = store.listLogs({}).items
  assert.equal(items.map((l) => l.title).join(' > '), '今天 B > 今天 A > 前天', '同一天按 id 倒序（后记的在前）')
})
