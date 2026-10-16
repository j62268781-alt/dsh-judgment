/**
 * SystemOne 协议层单元测试：**固件是真实端点回的原样 JSON**（2026 P0′ 探针，
 * `decision-model-preview` @ live-turing 网关），不是编出来的。
 *
 * 这里钉住三件容易漂移的事：
 * 1. 请求体形状（三个原语各自的 `criteria` 形态）；
 * 2. 响应里 `score` 是**连续位置**（= 分布期望值），不是整数下标；
 * 3. 严格校验：任何结构问题整批拒绝，且**拒绝时仍留住已经花掉的计量**。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ARGMAX_TOLERANCE, NORMALIZATION_TOLERANCE, ResponseRejected, decodeResponse, encodeBody, knownUsage,
} from '../lib/provider/system-one.js'
import { validateRequest } from '../lib/provider/request.js'

const MODEL = 'decision-model-preview'

/** 探针 #1：三种原语一次批内问完（noul + choice + score）。 */
const PROBE_3 = {
  model: MODEL,
  answers: {
    reachable: { type: 'noul', noul: 0.98 },
    action: { type: 'choice', choice: 'a2', confidence: 0.18, probabilities: { a0: 0.35, a1: 0.19, a2: 0.46 } },
    certainty: {
      type: 'score', score: 0.84,
      legend: { 0: '很小', 1: '一般', 2: '很大' },
      probabilities: { 0: 0.45, 1: 0.26, 2: 0.29 },
      confidence: 0.58,
    },
  },
  usage: { input_tokens: 99, output_tokens: 0 },
  request_id: 'c3739b4b-33ed-910b-bdae-f602d311af43',
  latency_ms: 53.2,
}

const QUESTIONS_3 = {
  reachable: { kind: 'noul', prompt: '这个判断端点当前可达并正常服务' },
  action: { kind: 'choice', prompt: '下一步做什么？', options: { a0: '再发一次', a1: '改问 score', a2: '收工' } },
  certainty: { kind: 'score', prompt: '把握多大？', levels: ['很小', '一般', '很大'] },
}

/** 探针 #2：4 级 score，用来交叉验证"score = Σ i·p_i"。 */
const PROBE_4 = {
  model: MODEL,
  answers: {
    s: {
      type: 'score', score: 1.42,
      legend: { 0: '极低', 1: '低', 2: '高', 3: '极高' },
      probabilities: { 0: 0.19, 1: 0.33, 2: 0.36, 3: 0.12 },
      confidence: 0.72,
    },
  },
  usage: { input_tokens: 27, output_tokens: 0 },
}

/* ─────────────────────────── 编码 ─────────────────────────── */

test('请求体形状：三个原语各自的 criteria 形态与实测一致', () => {
  const body = encodeBody(MODEL, { task: 'x' }, QUESTIONS_3)
  assert.deepEqual(body, {
    model: MODEL,
    state: { task: 'x' },
    questions: {
      reachable: { type: 'noul', instructions: '这个判断端点当前可达并正常服务' },
      action: { type: 'choice', instructions: '下一步做什么？', criteria: { a0: '再发一次', a1: '改问 score', a2: '收工' } },
      certainty: { type: 'score', instructions: '把握多大？', criteria: ['很小', '一般', '很大'] },
    },
  })
})

test('请求体：noul 的 criteria 只在给了的时候才发', () => {
  const withCriteria = encodeBody(MODEL, 'state', {
    n: { kind: 'noul', prompt: '命题', criteria: { true: '成立侧', false: null } },
  })
  assert.deepEqual(withCriteria.questions.n, {
    type: 'noul', instructions: '命题', criteria: { true: '成立侧', false: null },
  })
  const without = encodeBody(MODEL, 'state', { n: { kind: 'noul', prompt: '命题' } })
  assert.deepEqual(without.questions.n, { type: 'noul', instructions: '命题' })
})

test('state 可以是纯字符串（实测接受），不必是对象', () => {
  assert.equal(encodeBody(MODEL, '纯字符串状态', QUESTIONS_3).state, '纯字符串状态')
})

/* ─────────────────────────── 解码：真实固件 ─────────────────────────── */

test('解码探针 #1：三种原语全部还原，含 confidence / legend / usage / request_id', () => {
  const decoded = decodeResponse(PROBE_3, QUESTIONS_3, MODEL)
  assert.equal(decoded.model, MODEL)
  assert.deepEqual(decoded.usage, { inputTokens: 99, outputTokens: 0 })
  assert.equal(decoded.requestId, 'c3739b4b-33ed-910b-bdae-f602d311af43')

  assert.deepEqual(decoded.answers.reachable, { kind: 'noul', probability: 0.98 })
  assert.equal('confidence' in decoded.answers.reachable, false, 'noul 没给 confidence 就不能合成一个')
  assert.deepEqual(decoded.answers.action, {
    kind: 'choice', optionId: 'a2', confidence: 0.18,
    probabilities: { a0: 0.35, a1: 0.19, a2: 0.46 },
  })
  assert.deepEqual(decoded.answers.certainty, {
    kind: 'score', value: 0.84, confidence: 0.58,
    legend: { 0: '很小', 1: '一般', 2: '很大' },
    probabilities: { 0: 0.45, 1: 0.26, 2: 0.29 },
  })
})

test('score 是连续位置（分布期望值），**原样保留不取整**', () => {
  const three = decodeResponse(PROBE_3, QUESTIONS_3, MODEL).answers.certainty
  const mean3 = 0 * 0.45 + 1 * 0.26 + 2 * 0.29
  assert.equal(three.value, 0.84, '不能把 0.84 取整成 1')
  assert.ok(Math.abs(three.value - mean3) < 0.01, `0.84 应约等于 Σ i·p_i = ${mean3}`)
  assert.notEqual(three.value, Math.round(three.value), '它确实不是整数')

  const questions4 = { s: { kind: 'score', prompt: '确定性？', levels: ['极低', '低', '高', '极高'] } }
  const four = decodeResponse(PROBE_4, questions4, MODEL).answers.s
  const mean4 = 0 * 0.19 + 1 * 0.33 + 2 * 0.36 + 3 * 0.12
  assert.equal(four.value, 1.42)
  assert.ok(Math.abs(four.value - mean4) < 0.01, `1.42 应约等于 Σ i·p_i = ${mean4}`)
})

test('容器：分布键按候选顺序重排，且是普通对象（可直接深比）', () => {
  const decoded = decodeResponse(PROBE_3, QUESTIONS_3, MODEL)
  assert.deepEqual(Object.keys(decoded.answers.action.probabilities), ['a0', 'a1', 'a2'])
})

/* ─────────────────────────── 解码：abstain ─────────────────────────── */

test('结构合法地"没有判断" → abstain（值），不是异常', () => {
  const questions = { n: { kind: 'noul', prompt: '命题' }, m: { kind: 'noul', prompt: '命题2' } }
  const decoded = decodeResponse(
    { model: MODEL, answers: { n: null, m: { type: 'refusal' } } },
    questions,
    MODEL,
  )
  assert.deepEqual(decoded.answers.n, { kind: 'abstain', reason: 'no-answer' })
  assert.deepEqual(decoded.answers.m, { kind: 'abstain', reason: 'refusal' })

  const flag = decodeResponse({ model: MODEL, answers: { n: { refusal: 'policy' }, m: { type: 'noul', noul: 0.5 } } }, questions, MODEL)
  assert.equal(flag.answers.n.reason, 'refusal')
})

/* ─────────────────────────── 严格校验：失败即拒 ─────────────────────────── */

function rejects(payload, questions, expectedRule, note) {
  assert.throws(
    () => decodeResponse(payload, questions, MODEL),
    (error) => {
      assert.ok(error instanceof ResponseRejected, `${note}：应抛 ResponseRejected，实际 ${error}`)
      assert.equal(error.validation.rule, expectedRule, `${note}：规则应为 ${expectedRule}，实际 ${error.validation.rule}`)
      assert.ok(error.validation.detail.length > 0, `${note}：必须给出人类可读细节`)
      return true
    },
    note,
  )
}

const Q = QUESTIONS_3

test('答案键集合必须与问题完全一致（缺一个 / 多一个都拒）', () => {
  const { reachable, action } = PROBE_3.answers
  rejects({ model: MODEL, answers: { reachable, action } }, Q, 'answer-set-equality', '少一个答案')
  rejects(
    { model: MODEL, answers: { ...PROBE_3.answers, extra: { type: 'noul', noul: 0.5 } } },
    Q, 'answer-set-equality', '多一个未提问的答案',
  )
  rejects({ model: MODEL }, Q, 'answer-set-equality', '完全没有 answers')
})

test('答案结构问题一律拒：类型不符 / 概率缺失 / 选中的候选不存在 / score 越界', () => {
  rejects(
    { model: MODEL, answers: { ...PROBE_3.answers, reachable: { type: 'choice', noul: 0.5 } } },
    Q, 'answer-shape', '答案类型与问题原语不符',
  )
  rejects(
    { model: MODEL, answers: { ...PROBE_3.answers, reachable: { type: 'noul' } } },
    Q, 'answer-shape', 'noul 缺概率',
  )
  rejects(
    { model: MODEL, answers: { ...PROBE_3.answers, action: { ...PROBE_3.answers.action, choice: 'a9' } } },
    Q, 'answer-shape', '选中了不存在的候选',
  )
  rejects(
    { model: MODEL, answers: { ...PROBE_3.answers, certainty: { ...PROBE_3.answers.certainty, score: 5 } } },
    Q, 'answer-shape', 'score 越出级别范围',
  )
  rejects(
    { model: MODEL, answers: { ...PROBE_3.answers, action: { type: 'choice', choice: 'a2' } } },
    Q, 'distribution-complete', 'choice 缺完整分布（契约要求分布是必填）',
  )
})

test('分布：键集合、概率取值范围、归一化、argmax 一致性', () => {
  const base = PROBE_3.answers.action
  rejects(
    { model: MODEL, answers: { ...PROBE_3.answers, action: { ...base, probabilities: { a0: 0.5, a1: 0.5 } } } },
    Q, 'distribution-complete', '分布少一个键',
  )
  rejects(
    { model: MODEL, answers: { ...PROBE_3.answers, action: { ...base, probabilities: { a0: 0.5, a1: 1.4, a2: -0.9 } } } },
    Q, 'probability-range', '概率超出 [0,1]',
  )
  rejects(
    { model: MODEL, answers: { ...PROBE_3.answers, action: { ...base, probabilities: { a0: 0.5, a1: 0.2, a2: 0.2 } } } },
    Q, 'distribution-normalized', 'Σp 偏离 1 超过 0.02',
  )
  rejects(
    { model: MODEL, answers: { ...PROBE_3.answers, action: { ...base, choice: 'a1' } } },
    Q, 'argmax-consistent', '选中的不是分布众数',
  )

  // 容差边界：Σp 偏 0.019 必须放过，偏 0.021 必须拒。
  const near = decodeResponse(
    { model: MODEL, answers: { ...PROBE_3.answers, action: { ...base, probabilities: { a0: 0.35, a1: 0.19, a2: 0.479 } } } },
    Q, MODEL,
  )
  assert.ok(Math.abs(0.35 + 0.19 + 0.479 - 1) < NORMALIZATION_TOLERANCE)
  assert.equal(near.answers.action.optionId, 'a2')
  assert.ok(ARGMAX_TOLERANCE < NORMALIZATION_TOLERANCE)
})

test('模型快照：缺失即拒；与配置不一致即拒；`-latest` 别名允许解析到具体版本', () => {
  rejects({ answers: PROBE_3.answers }, Q, 'model-name', '响应没有 model')
  rejects({ model: 'someone-else', answers: PROBE_3.answers }, Q, 'model-name', '响应换了模型')
  const aliased = decodeResponse(
    { model: 'jev-1.13', answers: PROBE_3.answers }, Q, 'typesafe/jev-latest',
  )
  assert.equal(aliased.model, 'jev-1.13', '别名允许快照不同，但记录的是快照')
})

test('计量：缺项不当作 0；非法计数被忽略；拒绝时用 knownUsage 留住已花的钱', () => {
  const partial = decodeResponse({ model: MODEL, answers: PROBE_3.answers, usage: { input_tokens: 99 } }, Q, MODEL)
  assert.deepEqual(partial.usage, { inputTokens: 99 })
  const broken = decodeResponse(
    { model: MODEL, answers: PROBE_3.answers, usage: { input_tokens: -1, output_tokens: 1.5 } },
    Q, MODEL,
  )
  assert.deepEqual(broken.usage, {})

  const raw = { model: MODEL, answers: { reachable: { type: 'noul', noul: 2 } }, usage: { input_tokens: 42, output_tokens: 7 } }
  assert.throws(() => decodeResponse(raw, Q, MODEL), ResponseRejected)
  assert.deepEqual(knownUsage(raw), { inputTokens: 42, outputTokens: 7 })
  assert.equal(knownUsage(undefined), undefined)
})

/* ─────────────────────────── 发包前校验 ─────────────────────────── */

test('请求侧校验：合法批次通过，各类不合规都被点名', () => {
  assert.equal(validateRequest('state', QUESTIONS_3), undefined)

  assert.equal(validateRequest(Number.NaN, QUESTIONS_3).rule, 'state-serializable')
  assert.equal(validateRequest({ task: 'x' }, {}).rule, 'questions-nonempty')
  assert.equal(validateRequest('s', { ' ': { kind: 'noul', prompt: 'p' } }).rule, 'question-identity')
  assert.equal(validateRequest('s', { a: { kind: 'wat', prompt: 'p' } }).rule, 'question-identity')
  assert.equal(validateRequest('s', { a: { kind: 'noul', prompt: '   ' } }).rule, 'question-identity')
  assert.equal(validateRequest('s', { a: { kind: 'choice', prompt: 'p', options: { only: 'x' } } }).rule, 'choice-arity')
  assert.equal(
    validateRequest('s', { a: { kind: 'choice', prompt: 'p', options: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, 'x'])) } }).rule,
    'choice-arity',
  )
  assert.equal(validateRequest('s', { a: { kind: 'score', prompt: 'p', levels: ['one'] } }).rule, 'score-arity')
  assert.equal(
    validateRequest('s', { a: { kind: 'score', prompt: 'p', levels: Array.from({ length: 11 }, () => 'x') } }).rule,
    'score-arity',
  )
  assert.equal(validateRequest('s', { a: { kind: 'noul', prompt: 'p', criteria: { true: 5 } } }).rule, 'question-identity')

  // 边界正是协议硬边界：2 个候选合法、255 个合法。
  assert.equal(validateRequest('s', { a: { kind: 'choice', prompt: 'p', options: { x: 'x', y: null } } }), undefined)
  assert.equal(validateRequest('s', { a: { kind: 'score', prompt: 'p', levels: ['a', 'b'] } }), undefined)
})
