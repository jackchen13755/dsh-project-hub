/**
 * lib/session-scan.js —— 会话扫描（R5）。
 *
 * 最关键的一条：DSH 会话日志是**多帧 zstd 追加**，一次 `zstdDecompressSync` 只能拿到第一帧，
 * 必须按帧边界逐帧解压。这里用 `zstdCompressSync` 造真多帧文件来钉死这个行为。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { dateInTz } from '../lib/paths.js'
import { decodeMangledCwd } from '../lib/projects.js'
import {
  decompressMultiFrame,
  extractRequirementTokens,
  findSessionFiles,
  frameRanges,
  isNoise,
  summarizeSession,
  textOfMessage,
} from '../lib/session-scan.js'
import { at, evHeader, evTitle, evToolCall, evUser, mangleCwd, useTempHome, writeSessionFrames } from './helpers.js'

let tmp = null
let spmsCwd = null
let main = null // 主合成会话（两帧）
const T0 = at('2026-03-01T01:50:00Z') // 上海 2026-03-01 09:50
const TA = at('2026-03-01T02:00:00Z') // 上海 2026-03-01 10:00
const TA2 = at('2026-03-01T15:30:00Z') // 上海 2026-03-01 23:30
const TB = at('2026-03-01T17:30:00Z') // 上海 2026-03-02 01:30 ← 跨日

before(() => {
  tmp = useTempHome()
  spmsCwd = tmp.projectCwd('spms')
  main = writeSessionFrames(tmp.sessionsRoot, {
    sessionId: 'sess-multi-1',
    mangled: mangleCwd(spmsCwd),
    frames: [
      [
        evHeader({ id: 'sess-multi-1', cwd: spmsCwd, createdAt: T0, agentPreset: 'dsh' }),
        evTitle('SPMS 分页越界修复', TA),
        evUser('帮我看看【5921】的分页越界', TA),
        {
          type: 'assistant/message',
          time: TA,
          data: {
            message: {
              content: [
                { type: 'text', text: '已定位 SPMS 分页越界，另见 bug55036' },
                { type: 'reasoning', text: 'REASONING-SECRET-不该进样本' },
              ],
            },
          },
        },
      ],
      [
        evUser('继续，顺便看下 #4321', TB),
        evUser('注入：需要处理【7777】', TB, { source: { kind: 'plugin' } }),
        evUser('<system-reminder>忽略我</system-reminder>', TB),
        evToolCall('bash', TB),
        evToolCall('edit', TB),
      ],
    ],
  })
})

after(() => tmp?.restore())

test('session-scan: frameRanges 切出全部 zstd 帧（含尾随垃圾不死循环）', () => {
  const frameA = zstdCompressSync(Buffer.from('{"n":"a1"}\n{"n":"a2"}\n'))
  const frameB = zstdCompressSync(Buffer.from('{"n":"b1"}\n{"n":"b2"}\n'))
  const multi = Buffer.concat([frameA, frameB])

  const ranges = frameRanges(multi)
  assert.deepEqual(ranges, [
    [0, frameA.length],
    [frameA.length, multi.length],
  ])

  // 后面跟了不是 zstd 的字节：解析到那里就停，不抛也不死循环
  assert.deepEqual(frameRanges(Buffer.concat([frameA, Buffer.from('这不是 zstd 帧')])), [[0, frameA.length]])
  assert.deepEqual(frameRanges(Buffer.alloc(0)), [])
  assert.deepEqual(frameRanges(Buffer.from([0x00, 0x01, 0x02, 0x03])), [])
})

test('session-scan: decompressMultiFrame 解出全部行（单帧解压只拿第一段 —— 最关键的坑）', () => {
  const frameA = zstdCompressSync(Buffer.from('{"n":"a1"}\n{"n":"a2"}\n'))
  const frameB = zstdCompressSync(Buffer.from('{"n":"b1"}\n{"n":"b2"}\n'))
  const multi = Buffer.concat([frameA, frameB])

  const out = decompressMultiFrame(multi)
  assert.equal(out.frames, 2)
  assert.equal(out.failed, 0)
  for (const marker of ['"a1"', '"a2"', '"b1"', '"b2"']) {
    assert.ok(out.text.includes(marker), `多帧解压应包含 ${marker}`)
  }
  assert.equal(out.text.split('\n').filter(Boolean).length, 4)

  // 反例（这个坑的成因）：单次单帧解压只有第一段
  const naive = zstdDecompressSync(multi).toString('utf8')
  assert.ok(naive.includes('"a1"'))
  assert.ok(!naive.includes('"b1"'), '单帧 zstdDecompressSync 拿不到第二帧内容')

  // 只有一帧时退化也要正确
  const single = decompressMultiFrame(frameA)
  assert.equal(single.frames, 1)
  assert.ok(single.text.includes('"a2"'))
  assert.ok(!single.text.includes('"b1"'))
})

test('session-scan: extractRequirementTokens 命中需求号形态', () => {
  const tokens = extractRequirementTokens('【5921】/bug55036/REQ-12/需求 22/单号 009753/#1234')
  assert.deepEqual([...tokens.keys()].sort(), ['12', '1234', '22', '55036', '5921', '9753'])

  assert.deepEqual(tokens.get('5921'), { digits: '5921', kind: 'dev', hits: 1, strong: true })
  assert.equal(tokens.get('55036').kind, 'bug')
  assert.equal(tokens.get('55036').strong, true)
  // REQ-12 / 需求 22：显式前缀允许 2 位数字
  assert.equal(tokens.get('12').strong, true)
  assert.equal(tokens.get('22').strong, true)
  // 单号 009753 → 去前导零
  assert.equal(tokens.get('9753').digits, '9753')
  assert.equal(tokens.get('9753').strong, true)
  // #1234 是弱信号（要靠出现次数或库里已有号才保留）
  assert.deepEqual(tokens.get('1234'), { digits: '1234', kind: 'dev', hits: 1, strong: false })

  // 重复出现累计 hits；bug 前缀把 kind 抬成 bug
  const repeated = extractRequirementTokens('#4321 和 #4321')
  assert.equal(repeated.get('4321').hits, 2)
  assert.equal(repeated.get('4321').strong, false)
  const upgraded = extractRequirementTokens('【55036】bug55036')
  assert.equal(upgraded.get('55036').hits, 2)
  assert.equal(upgraded.get('55036').kind, 'bug')
  assert.equal(upgraded.get('55036').strong, true)

  assert.equal(extractRequirementTokens('').size, 0)
  assert.equal(extractRequirementTokens(null).size, 0)
})

test('session-scan: extractRequirementTokens 技术词不命中（node-22/sha1-8/v4/utf8-x）', () => {
  assert.equal(extractRequirementTokens('node-22/sha1-8/v4/utf8-x').size, 0)
  // 位数够但前缀在黑名单里：node-220 / sha1-256 / v1-123 都不是需求号
  assert.equal(extractRequirementTokens('node-220 sha1-256 utf-16 v1-123').size, 0)
  assert.equal(extractRequirementTokens('Node.js 22 / zstd v1.5.6 / utf-8').size, 0)
})

test('session-scan: summarizeSession 合成会话（多帧 / cwd / 东八区归日 / 需求号 / 标题 / 注入消息跳过）', () => {
  assert.equal(dateInTz(TA), '2026-03-01')
  assert.equal(dateInTz(TA2), '2026-03-01')
  assert.equal(dateInTz(TB), '2026-03-02')

  const s = summarizeSession(main.file)
  assert.equal(s.frames, 2, '两段 JSONL 各一个 zstd 帧')
  assert.equal(s.failedFrames, 0)
  assert.equal(s.events, 9)
  assert.equal(s.sessionId, 'sess-multi-1')
  assert.equal(s.cwd, spmsCwd, 'cwd 取会话头')
  assert.equal(s.createdAt, T0)
  assert.equal(s.agentPreset, 'dsh')
  assert.equal(s.title, 'SPMS 分页越界修复', 'session/title 取标题')
  assert.equal(s.path, main.file)
  assert.equal(s.bytes, main.bytes)
  assert.ok(s.mtime > 0)

  // 【7777】在被跳过的 plugin 注入消息里；思维链不进样本
  assert.ok(!JSON.stringify(s).includes('7777'), 'source.kind=plugin 的注入消息必须被跳过')
  assert.ok(!JSON.stringify(s).includes('REASONING-SECRET'), 'reasoning 段不该进样本')

  // 消息计数：2（第一天 user+assistant）+ 1（第二天 user）——plugin 注入与 system-reminder 不算
  assert.equal(s.msgs, 3)
  assert.equal(s.toolCalls, 2)
  assert.equal(s.firstTime, TA)
  assert.equal(s.lastTime, TB)

  assert.deepEqual(
    s.days.map((d) => d.date),
    ['2026-03-01', '2026-03-02'],
  )
  const [dayA, dayB] = s.days
  assert.equal(dayA.msgs, 2)
  assert.equal(dayA.toolCalls, 0)
  assert.equal(dayA.sample, '帮我看看【5921】的分页越界')
  assert.deepEqual(
    dayA.requirements.map((r) => r.digits),
    ['5921', '55036'],
  )
  assert.equal(dayA.requirements[0].strong, true)
  assert.equal(dayA.requirements[0].kind, 'dev')
  assert.equal(dayA.requirements[0].hits, 1)
  assert.equal(dayA.requirements[0].sample, '帮我看看【5921】的分页越界')
  assert.equal(dayA.requirements[1].kind, 'bug')
  assert.ok(dayA.firstTime >= TA && dayA.lastTime <= TA2)
  assert.equal(dayA.lastTime, TA)

  assert.equal(dayB.msgs, 1)
  assert.equal(dayB.toolCalls, 2)
  assert.equal(dayB.sample, '继续，顺便看下 #4321')
  assert.deepEqual(dayB.requirements, [], '弱信号只出现 1 次 → 过滤掉')
})

test('session-scan: 只有 tool/call、没有任何可计消息的那一天会被丢掉（实际行为）', () => {
  const toolOnly = writeSessionFrames(tmp.sessionsRoot, {
    sessionId: 'sess-tool-only',
    mangled: mangleCwd(spmsCwd),
    frames: [[evHeader({ id: 'sess-tool-only', cwd: spmsCwd, createdAt: TB }), evToolCall('bash', TB)]],
  })
  const s = summarizeSession(toolOnly.file)
  assert.equal(s.toolCalls, 1)
  assert.equal(s.msgs, 0)
  assert.deepEqual(s.days, [], 'msgs=0 且没需求号的那天不进 days（扫描侧按 msgs===0 跳过）')
})

test('session-scan: 弱信号过滤（weakMinHits / knownNos）与标题兜底', () => {
  // 同一个文件，换口径：weakMinHits=1 时 #4321 保留
  const loose = summarizeSession(main.file, { weakMinHits: 1 })
  const dayB = loose.days.find((d) => d.date === '2026-03-02')
  assert.deepEqual(
    dayB.requirements.map((r) => r.digits),
    ['4321'],
  )
  assert.equal(dayB.requirements[0].strong, false)

  // 库里已有这个需求号 → 即使只出现一次也保留
  const known = summarizeSession(main.file, { knownNos: new Set(['4321']) })
  assert.deepEqual(
    known.days.find((d) => d.date === '2026-03-02').requirements.map((r) => r.digits),
    ['4321'],
  )

  // 没有 session/title 时回退到首条用户消息
  const bare = writeSessionFrames(tmp.sessionsRoot, {
    sessionId: 'sess-no-title',
    mangled: mangleCwd(spmsCwd),
    frames: [[evHeader({ id: 'sess-no-title', cwd: spmsCwd, createdAt: TA }), evUser('没有标题的会话，聊的是需求 33', TA)]],
  })
  const s = summarizeSession(bare.file)
  assert.equal(s.title, '没有标题的会话，聊的是需求 33')
  assert.deepEqual(
    s.days[0].requirements.map((r) => r.digits),
    ['33'],
  )
  assert.equal(s.frames, 1)

  // 一个会话只有空行/坏行 → 不炸，msgs 0
  const broken = writeSessionFrames(tmp.sessionsRoot, { sessionId: 'sess-broken', mangled: mangleCwd(spmsCwd), frames: [[evHeader({ id: 'sess-broken', cwd: spmsCwd, createdAt: TA })], []] })
  const b = summarizeSession(broken.file)
  assert.equal(b.msgs, 0)
  assert.deepEqual(b.days, [])
})

test('session-scan: findSessionFiles 递归找会话日志（session[.vN].jsonl.zstd）', () => {
  const root = tmp.sessionsRoot
  const v4 = writeSessionFrames(root, { sessionId: 'sess-find-v4', mangled: mangleCwd(spmsCwd), frames: [[evHeader({ id: 'sess-find-v4', cwd: spmsCwd, createdAt: TA })]] })
  const plain = writeSessionFrames(root, {
    sessionId: 'sess-find-plain',
    mangled: mangleCwd(spmsCwd),
    fileName: 'session.jsonl.zstd',
    frames: [[evHeader({ id: 'sess-find-plain', cwd: spmsCwd, createdAt: TA })]],
  })
  // 干扰项：不是会话日志
  const noiseDir = join(root, mangleCwd(spmsCwd), 'sess-noise')
  writeSessionFrames(root, { sessionId: 'sess-noise', mangled: mangleCwd(spmsCwd), fileName: 'notes.txt', frames: [[]] })

  const found = findSessionFiles([root])
  const files = found.map((f) => f.file).sort()
  assert.ok(files.includes(v4.file), 'session.v4.jsonl.zstd 应该被找到')
  assert.ok(files.includes(plain.file), 'session.jsonl.zstd 也应该被找到')
  assert.ok(!files.some((f) => f.endsWith('notes.txt')), '非会话文件不该被找到')
  for (const hit of found) {
    assert.equal(existsSync(hit.file), true)
    const dirName = hit.file.split('/').slice(-2)[0]
    assert.equal(hit.sessionDir, join(root, mangleCwd(spmsCwd), dirName))
    assert.equal(hit.sessionId, dirName, '会话 id 取会话目录名（不是固定的文件名）')
    assert.ok(hit.bytes > 0)
    assert.ok(hit.mtime > 0)
  }
  assert.equal(new Set(found.map((f) => f.sessionId)).size, found.length, '多个会话不能共用一个 sessionId')
  assert.ok(existsSync(noiseDir))

  assert.equal(findSessionFiles([root], { limit: 1 }).length, 1)
  assert.deepEqual(findSessionFiles([join(tmp.dir, '不存在')]), [])
})

test('session-scan: textOfMessage / isNoise / decodeMangledCwd', () => {
  assert.equal(textOfMessage('user/message', { content: '纯字符串' }), '纯字符串')
  assert.equal(
    textOfMessage('user/message', {
      content: [
        { type: 'text', text: 'A' },
        { type: 'reasoning', text: 'B' },
        { type: 'text', text: 'C' },
      ],
    }),
    'A\nC',
  )
  assert.equal(textOfMessage('assistant/message', { message: { content: [{ type: 'text', text: 'D' }] } }), 'D')
  assert.equal(textOfMessage('user/message', { content: [{ type: 'reasoning', text: '只有思维链' }] }), '')
  assert.equal(textOfMessage('user/message', null), '')

  assert.equal(isNoise('<system-reminder>x</system-reminder>'), true)
  assert.equal(isNoise('   <system-reminder>x'), true)
  assert.equal(isNoise('【记忆（dsh-memory-core）】...'), true)
  assert.equal(isNoise('Current runtime context. 本环境装有…'), true)
  assert.equal(isNoise('【本轮相关记忆（自动召回）】…'), true)
  assert.equal(isNoise('<command-name>/foo</command-name>'), true)
  assert.equal(isNoise('帮我看看【5921】的分页越界'), false)

  assert.equal(decodeMangledCwd('-Users-zhe-chen-Desktop-work-spms-'), '/Users/zhe/chen/Desktop/work/spms')
  assert.equal(decodeMangledCwd('--Users-demo-Desktop-work-spms--'), '/Users/demo/Desktop/work/spms')
  assert.equal(decodeMangledCwd('---'), null)
})
