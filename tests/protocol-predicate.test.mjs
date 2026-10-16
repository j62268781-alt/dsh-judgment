/**
 * OpenAI-Decisions（`predicate`）协议单元测试。
 *
 * ⚠️ 与 `protocol.test.mjs` 不同：**这里没有真实端点固件**——手上没有这条连接与密钥，
 * 所以固件是按上游可运行实现（`/tmp/jev-survey/dsh-jev-plugin/packages/jev/src/wire.ts`
 * 的 `protocolBody` / `parseProtocolResponse`）逐条写出来的。它钉住的是**形状与纪律**，
 * 不是"实测通过"。等有一条真实连接，用 `pnpm probe` 打一次再回填（文件末尾列了待验证点）。
 *
 * 重点：第二套协议的四处结构性差异（状态字段 / 问题容器 / 答案容器 / 分布表示）
 * 都能被同一套归一化 schema 吃掉 —— 这正是 P0′ 要回答的问题。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeResponse, encodeBody } from '../lib/provider/openai-decisions.js'
import { ARGMAX_TOLERANCE, NORMALIZATION_TOLERANCE } from '../lib/provider/wire.js'
import { decodeResponse as decodeSystemOne } from '../lib/provider/system-one.js'

const MODEL = 'luna-preview'
const QUESTIONS = {
  reachable: { kind: 'noul', prompt: '端点可用' },
  action: { kind: 'choice', prompt: '下一步？', options: { a0: 'A', a1: 'B' } },
  certainty: { kind: 'score', prompt: '把握？', levels: ['小', '大'] },
}

/* ─────────────────────────── 编码（四处差异） ─────────────────────────── */

test('编码：状态进 `input` 且非字符串要序列化；问题是数组且用 `name`', () => {
  const body = encodeBody(MODEL, { task: 'x' }, QUESTIONS)
  assert.equal(body.model, MODEL)
  assert.equal(body.input, '{"task":"x"}', '对象状态要 JSON.stringify 成字符串')
  assert.ok(Array.isArray(body.questions), '这个问题容器是数组，不是对象')
  assert.deepEqual(body.questions.map((question) => question.name), ['reachable', 'action', 'certainty'])

  assert.equal(encodeBody(MODEL, '已经是字符串', QUESTIONS).input, '已经是字符串')
})

test('编码：noul → `predicate`，有判据时把 {instructions, criteria} 整体序列化', () => {
  const plain = encodeBody(MODEL, 's', { n: { kind: 'noul', prompt: '命题' } }).questions[0]
  assert.deepEqual(plain, { name: 'n', type: 'predicate', instructions: '命题' })

  const judged = encodeBody(MODEL, 's', {
    n: { kind: 'noul', prompt: '命题', criteria: { true: '成立侧', false: '不成立侧' } },
  }).questions[0]
  assert.equal(judged.type, 'predicate')
  assert.deepEqual(JSON.parse(judged.instructions), {
    instructions: '命题',
    criteria: { true: '成立侧', false: '不成立侧' },
  })
})

test('编码：choice → `choices[{value,description}]`，score → `levels[{label,description}]`', () => {
  const [noul, choice, score] = encodeBody(MODEL, 's', QUESTIONS).questions
  assert.equal(noul.type, 'predicate')
  assert.deepEqual(choice, {
    name: 'action', type: 'choice', instructions: '下一步？',
    choices: [{ value: 'a0', description: 'A' }, { value: 'a1', description: 'B' }],
  })
  assert.deepEqual(score, {
    name: 'certainty', type: 'score', instructions: '把握？',
    levels: [{ label: '0', description: '小' }, { label: '1', description: '大' }],
  })

  // 空说明整字段不发，别送空串去污染判据。
  const sparse = encodeBody(MODEL, 's', {
    c: { kind: 'choice', prompt: 'p', options: { a0: null } },
    s: { kind: 'score', prompt: 'p', levels: [null, '有说明'] },
  }).questions
  assert.deepEqual(sparse[0].choices, [{ value: 'a0' }])
  assert.deepEqual(sparse[1].levels, [{ label: '0' }, { label: '1', description: '有说明' }])
})

/* ─────────────────────────── 解码 ─────────────────────────── */

const REPLY = {
  answers: [
    { name: 'reachable', type: 'predicate', probability: 0.9 },
    { name: 'action', type: 'choice', choice: 'a1', confidence: 0.62, probabilities: [
      { value: 'a0', probability: 0.31, label: 'A' },
      { value: 'a1', probability: 0.69, label: 'B' },
    ] },
    { name: 'certainty', type: 'score', score: 0.8, confidence: 0.55, probabilities: [
      { value: 0, probability: 0.2, label: '0' },
      { value: 1, probability: 0.8, label: '1' },
    ] },
  ],
  usage: { input_tokens: 51, output_tokens: 0 },
}

test('解码：三种原语都归一化到同一套答案形状（数组分布 → 对象分布）', () => {
  const decoded = decodeResponse(REPLY, QUESTIONS, MODEL)
  assert.deepEqual(decoded.answers.reachable, { kind: 'noul', probability: 0.9 })
  assert.deepEqual(decoded.answers.action, {
    kind: 'choice', optionId: 'a1', confidence: 0.62,
    probabilities: { a0: 0.31, a1: 0.69 },
  })
  assert.deepEqual(decoded.answers.certainty, {
    kind: 'score', value: 0.8, confidence: 0.55,
    probabilities: { 0: 0.2, 1: 0.8 },
  })
  assert.deepEqual(decoded.usage, { inputTokens: 51, outputTokens: 0 })
  assert.equal(decoded.model, MODEL, '协议没回显 model 时退回配置里的模型名')
})

test('模型名：回显了就必须与配置一致（`-latest` 别名例外）', () => {
  const echoed = decodeResponse({ ...REPLY, model: MODEL }, QUESTIONS, MODEL)
  assert.equal(echoed.model, MODEL)
  assert.throws(
    () => decodeResponse({ ...REPLY, model: 'someone-else' }, QUESTIONS, MODEL),
    (error) => error.validation.rule === 'model-name',
  )
  assert.throws(
    () => decodeResponse({ ...REPLY, model: '' }, QUESTIONS, MODEL),
    (error) => error.validation.rule === 'model-name',
  )
  const alias = decodeResponse({ ...REPLY, model: 'luna-2026-01' }, QUESTIONS, 'luna-latest')
  assert.equal(alias.model, 'luna-2026-01')
})

test('拒答与 null 都是 abstain 值，不是异常', () => {
  const decoded = decodeResponse({
    ...REPLY,
    answers: [
      { name: 'reachable', type: 'refusal' },
      null,
      REPLY.answers[2],
    ],
  }, QUESTIONS, MODEL)
  assert.deepEqual(decoded.answers.reachable, { kind: 'abstain', reason: 'refusal' })
  assert.deepEqual(decoded.answers.action, { kind: 'abstain', reason: 'no-answer' })
  assert.equal(decoded.answers.certainty.kind, 'score')
})

/* ─────────────────────────── 严格校验 ─────────────────────────── */

function rejects(payload, expectedRule, note, questions = QUESTIONS) {
  assert.throws(
    () => decodeResponse(payload, questions, MODEL),
    (error) => {
      assert.equal(error.validation.rule, expectedRule, `${note}：应 ${expectedRule}，实际 ${error.validation?.rule}`)
      return true
    },
    note,
  )
}

test('答案容器必须是数组，且集合与问题完全一致', () => {
  rejects({ answers: { reachable: { type: 'predicate', probability: 0.5 } } }, 'answer-set-equality', '不是数组')
  rejects({ answers: REPLY.answers.slice(0, 2) }, 'answer-set-equality', '少一个答案')
  rejects({ answers: [...REPLY.answers, { name: 'extra', type: 'predicate', probability: 0.5 }] }, 'answer-set-equality', '多一个答案')
  rejects({ answers: [...REPLY.answers, REPLY.answers[0]] }, 'answer-set-equality', '同一 name 重复')
  rejects({ answers: [{ name: 'nope', type: 'predicate', probability: 0.5 }, ...REPLY.answers.slice(1)] }, 'answer-set-equality', '未提问的 name')
  rejects({}, 'answer-set-equality', '完全没有 answers')
})

test('类型必须对上：noul 在协议里叫 predicate，写成 noul 就是非法', () => {
  rejects(
    { answers: [{ name: 'reachable', type: 'noul', probability: 0.5 }, ...REPLY.answers.slice(1)] },
    'answer-shape', 'predicate 写成了 noul',
  )
  rejects(
    { answers: [{ name: 'reachable', type: 'predicate' }, ...REPLY.answers.slice(1)] },
    'answer-shape', 'predicate 缺 probability',
  )
  rejects(
    { answers: [REPLY.answers[0], { ...REPLY.answers[1], type: 'score' }, REPLY.answers[2]] },
    'answer-shape', 'choice 写成了 score',
  )
})

test('choice / score 的 confidence 必填（predicate 不要求）——与上游一致', () => {
  const noConfidence = REPLY.answers.map((answer, index) => index === 1 ? { ...answer, confidence: undefined } : answer)
  rejects({ answers: noConfidence }, 'answer-shape', 'choice 缺 confidence')
  const outOfRange = REPLY.answers.map((answer, index) => index === 2 ? { ...answer, confidence: 1.5 } : answer)
  rejects({ answers: outOfRange }, 'answer-shape', 'confidence 越界')
})

test('数组分布的每一项都要合法：value 类型、label 必填、不得重复、必须覆盖全集', () => {
  const withProbabilities = (index, probabilities) =>
    REPLY.answers.map((answer, i) => i === index ? { ...answer, probabilities } : answer)

  rejects({ answers: withProbabilities(1, [{ value: 0, probability: 0.5, label: 'x' }, { value: 'a1', probability: 0.5, label: 'y' }]) },
    'distribution-complete', 'choice 的分布项 value 用了数字')
  rejects({ answers: withProbabilities(2, [{ value: '0', probability: 0.5, label: 'x' }, { value: 1, probability: 0.5, label: 'y' }]) },
    'distribution-complete', 'score 的分布项 value 用了字符串')
  rejects({ answers: withProbabilities(1, [{ value: 'a0', probability: 0.5 }, { value: 'a1', probability: 0.5, label: 'y' }]) },
    'distribution-complete', '分布项缺 label')
  rejects({ answers: withProbabilities(1, [{ value: 'a0', probability: 0.5, label: 'x' }, { value: 'a0', probability: 0.5, label: 'y' }]) },
    'distribution-complete', '分布项重复')
  rejects({ answers: withProbabilities(1, [{ value: 'a0', probability: 1, label: 'x' }]) },
    'distribution-complete', '分布不完整')
  rejects({ answers: withProbabilities(1, [
    { value: 'a0', probability: 0.2, label: 'A' },
    { value: 'a1', probability: 0.9, label: 'B' },
  ]) }, 'distribution-normalized', 'Σp 偏离 1 超过容差')
  rejects({ answers: withProbabilities(1, [
    { value: 'a0', probability: 0.7, label: 'A' },
    { value: 'a1', probability: 0.3, label: 'B' },
  ]) }, 'argmax-consistent', '选中的不是分布众数')
})

/* ─────────────────────────── 两套协议共享同一套纪律 ─────────────────────────── */

test('容差只有一份：两套协议共用同一组常数（避免多份实现漂移）', () => {
  assert.equal(NORMALIZATION_TOLERANCE, 0.02)
  assert.equal(ARGMAX_TOLERANCE, 0.000001)
})

test('同一批问题、两套协议：线格式不同，归一化后的答案是同一形状', () => {
  const systemOneReply = {
    model: MODEL,
    answers: {
      reachable: { type: 'noul', noul: 0.9 },
      action: { type: 'choice', choice: 'a1', confidence: 0.62, probabilities: { a0: 0.31, a1: 0.69 } },
      certainty: { type: 'score', score: 0.8, confidence: 0.55, probabilities: { 0: 0.2, 1: 0.8 } },
    },
  }
  const viaSystemOne = decodeSystemOne(systemOneReply, QUESTIONS, MODEL)
  const viaPredicate = decodeResponse(REPLY, QUESTIONS, MODEL)
  for (const id of Object.keys(QUESTIONS)) {
    assert.deepEqual(viaPredicate.answers[id], viaSystemOne.answers[id], `问题 "${id}" 的归一化结果应逐字相同`)
  }
})
