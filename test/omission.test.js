/**
 * 遗漏检查：改一处，还有哪些地方要跟着改。
 *
 * 用户场景原话："需求想改一个地方，但是不熟悉，漏了" —— 不熟的人最容易漏的就是
 * **伴随改动**（多语言、模型/接口、样式、同族页面、另一端），而这些在 git 历史里有统计规律。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyPath, companionProfile, omissionCheck } from '../lib/omission.js'

test('classifyPath：多语言/模型/接口/样式/页面/组件都能认', () => {
  assert.deepEqual(classifyPath('isomorph/views/X/locales/zh.json'), { kind: 'locale', lang: 'zh' })
  assert.equal(classifyPath('isomorph/models/LostAndFound/index.ts').kind, 'model')
  assert.equal(classifyPath('isomorph/api/services/lf.ts').kind, 'api')
  assert.equal(classifyPath('isomorph/views/X/index.less').kind, 'style')
  assert.equal(classifyPath('isomorph/views/X/index.tsx').kind, 'view')
  assert.equal(classifyPath('isomorph/components/Common/index.tsx').kind, 'component')
})

test('companionProfile：统计出"改这个模块历史上动过哪些伴随文件"', () => {
  const rows = [
    { path: 'isomorph/views/Housekeeping/LostAndFound/index.tsx', commits: 10, last_seen: '2026-09-20' },
    { path: 'isomorph/views/Housekeeping/LostAndFound/locales/zh.json', commits: 6, last_seen: '2026-09-20' },
    { path: 'isomorph/views/Housekeeping/LostAndFound/locales/en.json', commits: 6, last_seen: '2026-09-20' },
    { path: 'isomorph/views/Housekeeping/LostAndFound/locales/jp.json', commits: 2, last_seen: '2026-08-01' },
    { path: 'isomorph/models/Housekeeping/LostAndFound/index.ts', commits: 4, last_seen: '2026-09-10' },
    { path: 'isomorph/views/Housekeeping/LostAndFound/detail.less', commits: 3, last_seen: '2026-09-01' },
  ]
  const profile = companionProfile(rows)
  assert.equal(profile.localeCount, 3, '三种语言')
  assert.deepEqual(profile.languages.sort(), ['en', 'jp', 'zh'])
  assert.equal(profile.model.length, 1)
  assert.equal(profile.style.length, 1)
  assert.equal(profile.files, 6)
  assert.equal(profile.lastSeen, '2026-09-20')
})

test('omissionCheck：多语言清单要能对出"这次少改了哪几种"', () => {
  const profile = companionProfile([
    { path: 'views/A/locales/zh.json', commits: 5 },
    { path: 'views/A/locales/en.json', commits: 5 },
    { path: 'views/A/locales/tc.json', commits: 5 },
    { path: 'views/A/locales/jp.json', commits: 5 },
  ])
  // 这次需求已经有落点，但只覆盖了 zh
  const target = { codeTouches: [{ path: 'views/A/locales/zh.json', module: 'views/A' }], projects: [] }
  const items = omissionCheck({ profile, target, moduleName: 'views/A' })
  const locale = items.find((x) => x.kind === 'locale')
  assert.ok(locale, '要有"多语言"这条')
  assert.match(locale.text, /4 种/)
  assert.match(locale.text, /差 en、tc、jp/, '要明确点出少改了哪几种')
  assert.match(locale.question, /别只改一种/)
  // 模型/样式/页面也要各自成条
  const rich = omissionCheck({
    profile: companionProfile([
      { path: 'views/A/models/m.ts', commits: 3 },
      { path: 'views/A/index.less', commits: 2 },
      { path: 'views/A/list.tsx', commits: 4 },
      { path: 'views/A/detail.tsx', commits: 4 },
    ]),
    moduleName: 'views/A',
  })
  assert.ok(rich.some((x) => x.kind === 'model'))
  assert.ok(rich.some((x) => x.kind === 'style'))
  assert.ok(rich.some((x) => x.kind === 'view'))
  assert.match(rich.find((x) => x.kind === 'view').question, /列表改了详情没改/)
})

test('omissionCheck：多端需求要提醒另一端', () => {
  const items = omissionCheck({
    profile: companionProfile([{ path: 'views/A/index.tsx', commits: 2 }]),
    target: { projects: [{ platform: 'PC' }, { platform: 'APP' }] },
    moduleName: 'views/A',
  })
  const platform = items.find((x) => x.kind === 'platform')
  assert.ok(platform)
  assert.match(platform.question, /各端都要改吗/)
})
