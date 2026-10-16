/**
 * 协议注册表：**协议身份 → 编解码器**（§12.6 要求协议身份显式、不由 URL 推断）。
 *
 * Service 只认这张表：表里有就发包，没有就以 `internal` 明确拒绝 ——
 * 绝不"猜一个最像的协议"去迎合端点。
 */

import type { JudgmentQuestions, JudgmentState } from '../contract/index.js'
import * as openaiDecisions from './openai-decisions.js'
import * as systemOne from './system-one.js'
import type { DecodedResponse } from './wire.js'

export interface ProtocolCodec {
  readonly id: string
  encodeBody(model: string, state: JudgmentState, questions: JudgmentQuestions): Record<string, unknown>
  decodeResponse(raw: unknown, questions: JudgmentQuestions, expectedModel: string): DecodedResponse
}

export const PROTOCOLS: Readonly<Record<string, ProtocolCodec>> = {
  'system-one': {
    id: 'system-one',
    encodeBody: systemOne.encodeBody,
    decodeResponse: systemOne.decodeResponse,
  },
  'openai-decisions': {
    id: 'openai-decisions',
    encodeBody: openaiDecisions.encodeBody,
    decodeResponse: openaiDecisions.decodeResponse,
  },
}

export function codecFor(protocol: string): ProtocolCodec | undefined {
  return PROTOCOLS[protocol]
}

/** 已接归一化层的协议身份（`status()` / 报错信息里用）。 */
export function implementedProtocols(): string[] {
  return Object.keys(PROTOCOLS)
}
