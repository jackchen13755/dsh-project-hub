/**
 * resume 聚合模块的单测。
 *
 * 只测**纯函数与降级行为**——真正去读 git 分支/账本的部分依赖本机仓库状态，
 * 放进单测会变成「换个机器就红」，那类验证走手工实测更合适。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { numbersInText, openItemsOf, collectResume, relatedBranches, relatedLedgers } from '../lib/resume.js'

test('numbersInText：分支名末尾的数字段能认出来', () => {
  assert.deepEqual([...numbersInText('feature/20260713-some-feature-5802')], ['20260713', '5802'].filter((n) => numbersInText('feature/20260713-some-feature-5802').has(n)))
  // 关键：需求号 5802 必须在里面
  assert.ok(numbersInText('feature/20260713-some-feature-5802').has('5802'))
  assert.ok(numbersInText('backup/6031-premerge-20260930').has('6031'))
})

test('numbersInText：需求 N / Bug N / #N 三种文本形态', () => {
  assert.ok(numbersInText('某系统 需求 6051 要在订单详情页加详情抽屉').has('6051'))
  assert.ok(numbersInText('核对禅道 Bug #55992 补充口径').has('55992'))
  assert.ok(numbersInText('fix(profile): 某处修正 #6051').has('6051'))
  assert.ok(numbersInText('修禅道 Bug 55 的越界').size === 0, '两位数字不该被当成需求号')
})

test('numbersInText：无关文本不产生噪音', () => {
  assert.equal(numbersInText('把按钮改大一点').size, 0)
  assert.equal(numbersInText('v1.2.3 升级').size, 0)
})

test('openItemsOf：有证据或标了 done/dropped 才算收了', () => {
  const ledger = {
    items: [
      { id: 'R1', text: '有证据的', evidence: [{ kind: 'file', ref: 'a.js:1' }] },
      { id: 'R2', text: '标了 done 但没证据', status: 'done' },
      { id: 'R3', text: '标了 dropped', status: 'dropped' },
      { id: 'R4', text: '真没收口', status: 'open' },
      { id: 'R5', text: '既没证据也没状态' },
    ],
  }
  const open = openItemsOf(ledger).map((i) => i.id)
  assert.deepEqual(open, ['R4', 'R5'])
})

test('collectResume：没有需求号 → null（不出段）', async () => {
  assert.equal(await collectResume({ requirementNo: '', root: null }), null)
  assert.equal(await collectResume({}), null)
})

test('collectResume：目录不存在 / 非 git 仓库 → 降级为 null，不抛错', async () => {
  assert.equal(await collectResume({ requirementNo: '12345', root: '/tmp/绝对不存在的路径-xyz' }), null)
  assert.equal(await collectResume({ requirementNo: '12345', root: '/tmp' }), null)
})

test('relatedBranches：非 git 目录返回空数组而非抛错', async () => {
  assert.deepEqual(await relatedBranches('/tmp', '9999'), [])
  assert.deepEqual(await relatedBranches(null, '9999'), [])
  assert.deepEqual(await relatedBranches('/tmp', ''), [])
})

test('relatedLedgers：没有需求号 → 空', () => {
  assert.deepEqual(relatedLedgers(''), [])
})
