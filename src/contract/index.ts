/**
 * dsh-judgment · 能力契约（入口 `dsh-judgment/contract`）
 *
 * 「它判断，消费者决定。」本文件只描述**结构化判断**这一项能力：
 * 一次调用 = 一份状态 + 一批命名问题 → 一批概率答案。它不含循环、不含领域知识、
 * 不含任何默认值。
 *
 * # 三条模块纪律（§13.9，唯一不能省的部分）
 *
 * 1. **零 import**：本文件不得 import 任何模块——含 `node:*`、含 provider 内部文件。
 * 2. **零运行时值**：只导出 `type` / `interface`。没有 `const` / `enum` / `class` /
 *    `function`。消费者一律 `import type`，编译期擦除后**不引入任何运行时代码**。
 *    （因此 `JudgmentError` 在这里是「错误的形状」，运行期的类与类型守卫属于
 *    根入口 `"."`，见其 TSDoc。）
 * 3. **单向依赖**：`provider → contract`。contract 永不反向引用。
 *
 * 将来若要把 contract 提成独立包，只是把本目录搬出去并在原路径留一个 re-export
 * 垫片，消费者只改一个 import 路径（§13.9「拆分预案」）。
 *
 * # 消费者用法（无硬依赖，§13.3 第 2 层）
 *
 * ```ts
 * import type { ApiVersion, Judge } from 'dsh-judgment/contract'
 *
 * const EXPECTED: ApiVersion = 1          // 本地常量即版本契约，契约里没有运行时常量
 * const judge = ctx.get('judgment') as Judge | undefined   // 调用点惰性解析，缺失不抛错
 * if (!judge || judge.apiVersion !== EXPECTED) return useHostModelJudge()
 * ```
 *
 * `HostModelJudge`（消费者内置、零依赖）实现同一个 `Judge`，所以消费者的循环代码
 * 只有一份，只换 judge（§13.3 第 3 层）。
 */

/* ─────────────────────────── 版本与服务名 ─────────────────────────── */

/**
 * 契约版本。**字面量联合类型，不是运行时常量**（§13.9）。
 *
 * 消费者在自己代码里写 `const EXPECTED: ApiVersion = 1`；契约升版把新值加进这个
 * 联合类型时，消费者会**编译报错**直到更新——这正是想要的强制点。运行期只需
 * `judge.apiVersion === EXPECTED`。
 *
 * 当前版本：`1`。
 */
export type ApiVersion = 1 | 2

/**
 * Service 名（类型别名只是记录；**运行期耦合就是这个字面量**）。
 *
 * 消费者写 `ctx.get('judgment')`。名字依据 §13.10 的四条命名约束：
 * 不暗示自己做决定、不带 `provider` 字样、不含厂商名、名词优先。
 */
export type JudgmentServiceName = 'judgment'

/* ─────────────────────────── 基元 ─────────────────────────── */

/** 可 JSON 序列化的值。契约自有定义，不引用任何模块。 */
export type JudgmentJson =
  | null
  | boolean
  | number
  | string
  | readonly JudgmentJson[]
  | { readonly [key: string]: JudgmentJson }

/**
 * `state`：**调用方自定义形状的不透明载荷**，字符串或任意可 JSON 序列化对象（§2.1）。
 *
 * 这是本能力最灵活的地方——浏览器送 a11y/DOM 摘要、手机送 UI tree 摘要、
 * 裁剪域送 transcript 分级拟合，provider 不理解其中任何一个字段。
 */
export type JudgmentState = string | JudgmentJson

/**
 * 提问文本：字符串，或可 JSON 序列化的对象/数组（由协议适配层负责序列化）。
 * 不接收 `null` / 数字 / 布尔——空值请显式写 `null` 到允许空值的字段里。
 */
export type JudgmentText =
  | string
  | readonly JudgmentJson[]
  | { readonly [key: string]: JudgmentJson }

/* ─────────────────────────── 三种问题原语（§2.1） ─────────────────────────── */

/**
 * `noul`：单一概率判定 p ∈ [0,1]（"这件事成立吗"）。
 * 上游两套协议分别叫 `noul` 与 `predicate`（§12.6），归一到这一个原语。
 */
export interface NoulQuestion {
  readonly kind: 'noul'
  /** 判定命题本身，如「任务目标已达成：当前页面与历史显示的就是所求结果」。 */
  readonly prompt: JudgmentText
  /** 可选的判据，用于把命题的 true/false 两侧分别说清（上游 `criteria.true/false`）。 */
  readonly criteria?: {
    readonly true?: JudgmentText | null
    readonly false?: JudgmentText | null
  }
}

/**
 * `choice`：从 2–255 个互斥候选中**单选**，答案是**完整概率分布**而非仅 argmax。
 *
 * 候选上限 255 是上游实测的协议硬边界（`jev-browser/src/questions.ts`
 * "Choice cardinality is bounded at 255"）。语义上互斥但**可互相替代**的候选
 * 出现分散分布时，**不是不确定**——分布形态的解读属于领域，provider 不做阈值门控
 * （§2.4、§13.2）。
 */
export interface ChoiceQuestion {
  readonly kind: 'choice'
  readonly prompt: JudgmentText
  /**
   * 候选映射：键 = 候选 id（答案与分布的键空间），值 = 候选说明或 `null`。
   * 键必须非空且唯一；个数必须落在 {@link JudgmentLimits.choiceOptions} 内。
   */
  readonly options: Readonly<Record<string, JudgmentText | null>>
}

/**
 * `score`：在 2–10 个**有序**级别上打分。
 * 答案是级别位置 + 完整概率分布；位置 ∈ [0, `levels.length`−1]（**可为小数**），
 * 分布键为级别下标的十进制字符串。
 */
export interface ScoreQuestion {
  readonly kind: 'score'
  readonly prompt: JudgmentText
  /**
   * 有序级别（下标即级别值）。个数必须落在 {@link JudgmentLimits.scoreLevels} 内，
   * 每个元素为级别说明或 `null`。
   */
  readonly levels: readonly (JudgmentText | null)[]
}

/** 三种问题原语的联合。 */
export type JudgmentQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

/**
 * 问题批次：**命名问题映射**（键 = 问题 id，协议里就是答案的键）。
 *
 * 一次请求问 N 个问题是本能力的经济杠杆——状态随每一批问题只发一次，
 * 批量相比逐个提问约 38 倍量级差异（§1.2 发现 3、§5.3）。
 * 问题 id 必须非空且唯一；批次必须非空。
 */
export type JudgmentQuestions = Readonly<Record<string, JudgmentQuestion>>

/**
 * 协议硬边界（数字的类型表达）。provider 在**发包前**按此校验；
 * 调用方可据此预校验，避免一次注定被拒的请求。
 */
export interface JudgmentLimits {
  readonly choiceOptions: { readonly min: 2; readonly max: 255 }
  readonly scoreLevels: { readonly min: 2; readonly max: 10 }
}

/* ─────────────────────────── 答案形状 ─────────────────────────── */

/** 概率：有限数且 ∈ [0,1]。 */
export type Probability = number

/** choice 答案的键空间 = 候选 id。 */
export type ChoiceOptionId = string

/** score 答案的键空间 = 级别下标的十进制字符串（`'0'`、`'1'`…）。 */
export type ScoreLevelKey = `${number}`

/**
 * 完整概率分布：**键集合与候选集合完全一致**，且 Σp = 1（容差见
 * {@link ValidationTolerance.normalization}）。
 *
 * 由 provider 严格校验后产出。消费者**不得自行构造或"修复"**它——
 * 概率协议里"修复"一个不自洽的分布等于用猜测覆盖证据（§2.5 第 5 条、§9.5）。
 */
export type NormalizedDistribution<K extends string = string> = Readonly<Record<K, Probability>>

/**
 * 协议附带的服务信号。两者都是**可选**，且 provider **绝不合成**：
 * 协议没给就留空——合成一个 confidence 正是"返回默认值"（§13.2 铁律）。
 */
export interface AnswerSignals {
  /** 协议自报置信度（TypeSafe 的 `confidence`）。缺失表示协议未提供。 */
  readonly confidence?: Probability
  /** 协议自报的图例/量纲（`legend`），原样透传的不透明 JSON。 */
  readonly legend?: JudgmentJson
}

/** `noul` 答案：概率 p ∈ [0,1]，不附分布。 */
export interface NoulAnswer extends AnswerSignals {
  readonly kind: 'noul'
  readonly probability: Probability
}

/** `choice` 答案：选中的候选 + 完整分布（`optionId` 必须与分布 argmax 一致）。 */
export interface ChoiceAnswer extends AnswerSignals {
  readonly kind: 'choice'
  readonly optionId: ChoiceOptionId
  readonly probabilities: NormalizedDistribution<ChoiceOptionId>
}

/**
 * `score` 答案：级别位置 + 完整分布。
 *
 * `value` 是**协议自报的位置**，实测等于级别分布的期望值 `Σ i·p_i`
 * （P0′ 探针：3 级时 0×0.45+1×0.26+2×0.29 = 0.84；4 级时 0×0.19+1×0.33+2×0.36+3×0.12 = 1.41，
 * 响应分别为 0.84 / 1.42）。所以它**可以是小数**，∈ [0, `levels.length`−1]，
 * **不保证是整数下标**——需要离散级别时请用 `probabilities` 的众数或自己定取整规则；
 * provider 绝不四舍五入（取整就是替消费者"修复"，§2.5）。
 */
export interface ScoreAnswer extends AnswerSignals {
  readonly kind: 'score'
  readonly value: number
  readonly probabilities: NormalizedDistribution<ScoreLevelKey>
}

/**
 * 显式弃答（typed abstain）：协议层**结构合法地**没有给出判断。
 *
 * 这是"判断"与"没有判断"的分界线，也是降级方向的交接点：
 *
 * - **provider 只在这里交出"没有答案"，决策留给消费者**。缺答案该"全保留"还是
 *   "中止"按领域相反（裁剪域 vs 动作域，§13.1），provider 无权选择方向，也
 *   **绝不用默认值填空**（§13.2 铁律）。
 * - provider **不得**因为自己的策略弃答：没有阈值、没有低置信度门（§13.2「绝不」列、
 *   §2.4）。弃答只反映协议说了什么。
 *
 * 反例提醒：**答案缺失（集合不一致）不是弃答，而是非法响应**——集合必须完全一致，
 * 失败即拒**不修复**（§2.5 第 5 条、§9.5）。
 */
export interface AbstainAnswer {
  readonly kind: 'abstain'
  readonly reason: AbstainReason
}

/** 弃答原因。只描述协议行为，不含任何领域或阈值判断。 */
export type AbstainReason =
  /** 协议层显式拒绝（如 SystemOne 的 `{type:'refusal'}`）。 */
  | 'refusal'
  /** 协议返回了结构合法但没有判断内容的答案。 */
  | 'no-answer'

/** 单个问题的答案 —— 要么是判断，要么是显式弃答。 */
export type JudgmentAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer | AbstainAnswer

/**
 * 答案批次：键 = 问题 id。**集合必须与 {@link JudgmentQuestions} 完全一致**：
 * 少一个键或多一个键都是非法响应（抛 {@link JudgmentError}，不修复）；
 * 某个问题确实没有判断时，它的值必须是 {@link AbstainAnswer} 而不是缺失。
 */
export type JudgmentAnswers = Readonly<Record<string, JudgmentAnswer>>

/**
 * 「集合一致」的**类型级表达**：当问题批次是字面量已知形状时（`as const`），
 * `ask` 的返回类型会逐键映射，消费者零 cast 拿到精确键集与判别联合：
 *
 * ```ts
 * const questions = { action: {…}, goal_done: {…} } as const satisfies JudgmentQuestions
 * const result = await judge.ask(snapshot, questions)   // Q 被推断
 * result.answers.action.kind                            // 精确到 'choice' | 'noul' | 'abstain'
 * ```
 *
 * 实现方在响应校验通过后需要一次 `as`（运行期集合一致由 provider 保证，
 * 类型只是把它前移到编译期）。
 */
export type JudgmentAnswersFor<Q extends JudgmentQuestions> = {
  readonly [K in keyof Q]: JudgmentAnswer
}

/* ─────────────────────────── 校验规则的类型表达（§0.4 / §12.5） ─────────────────────────── */

/**
 * 严格校验的规则清单。四个上游仓库**各自独立**收敛到同一纪律（§13.2），
 * 所以校验必须留在 provider：留给消费者就会出现多份实现并必然漂移。
 *
 * **失败即拒，不修复**——拒绝整批 →（可选）原样重试一次（新采样，计入预算）→
 * 升级给大脑（§9.5）。"`no-repair`" 是纪律本身，写在下面而不是当作可选项。
 */
export type ValidationRule =
  /** `state` 必须可 JSON 序列化。 */
  | 'state-serializable'
  /** 批次至少一个问题。 */
  | 'questions-nonempty'
  /** 问题 id 非空且唯一；`kind` 必须是三种原语之一。 */
  | 'question-identity'
  /** choice 候选数 ∈ [2,255]，候选 id 非空且唯一。 */
  | 'choice-arity'
  /** score 级别数 ∈ [2,10]。 */
  | 'score-arity'
  /** 答案键集合与问题键集合完全一致（缺 = 非法，不修复）。 */
  | 'answer-set-equality'
  /** 某个答案的结构与它的问题原语不匹配（类型、必备字段、取值域如 score 越出级别范围）。 */
  | 'answer-shape'
  /** 每个概率都是有限数且 ∈ [0,1]。 */
  | 'probability-range'
  /** 分布覆盖全部候选/级别，不多不少。 */
  | 'distribution-complete'
  /** |Σp − 1| ≤ normalization 容差。 */
  | 'distribution-normalized'
  /** choice 的 `optionId` 必须是分布众数（argmax 容差见下）。 */
  | 'argmax-consistent'
  /** 响应返回的模型名必须匹配预期（记录的是响应快照，见 {@link JudgmentResult.model}）。 */
  | 'model-name'

/**
 * 容差定稿（§13.2 / `bridge.mjs:95` 的源码级数值）。
 * 契约双方（provider 与任何替代实现）必须用同一组数字，否则严格校验会漂移。
 */
export interface ValidationTolerance {
  /** `|Σp − 1|` 的上限。 */
  readonly normalization: 0.02
  /** `p[argmax] − max(p)` 的上限，即 1e-6。 */
  readonly argmax: 0.000001
}

/** 一次校验失败的结构化定位（供审计与工具面直接展示）。 */
export interface ValidationFailure {
  readonly rule: ValidationRule
  /** 出问题的问题 id；批次级规则（如 state）不含此项。 */
  readonly questionId?: string
  /** 人类可读的细节。**不携带"修复后"的值**——失败不修复。 */
  readonly detail: string
  /**
   * 该答案涉及的候选/级别数量（能确定时）。
   *
   * 用途：消费者**确定性地**决定重采规模，而不是按固定阶梯猜——
   * 例如 `nextCap = max(4, Math.floor(optionCount / 2))`。
   *
   * 实测背景（`browser.action` / decision-model-preview，每目标 6 次采样）：
   * 候选 10 个时分布全部合法，16 个 0/6 非法，40 个 6/6 非法（系统性欠归一 0.95–0.98）。
   * 所以"缩到多少"是消费者的领域决策，provider 只负责把事实说清楚。
   */
  readonly optionCount?: number
  /**
   * 实测分布和（仅 `distribution-normalized`）：`Σp`。
   *
   * 与 {@link tolerance} 一起就能判断"差多少"、以及是否系统性——而不是从
   * `detail` 字符串里正则抠数字。
   */
  readonly sum?: number
  /**
   * 本次校验实际使用的容差（仅 `distribution-normalized`）。
   * **运行期读取这个值，不要在消费者里写死**：容差是契约定稿，
   * 但契约升版时它可能变，写死就会与 provider 漂移。
   */
  readonly tolerance?: number
}

/* ─────────────────────────── 调用选项：两层配置 / 预算 / 血缘 ─────────────────────────── */

/** 连接层标识，配置里的一条 `(protocol, baseUrl, model, credential)` 元组（§13.4）。 */
export type ConnectionId = string

/** 用途层名，如 `mobile.action` / `browser.action` / `compaction.retain`（§13.4）。 */
export type PurposeName = string

/**
 * 目标选择。**消费者只报用途名，不接触 endpoint / model / key**——
 * "手机用一个模型、浏览器用另一个"是配置问题而不是代码问题（§13.4）。
 *
 * provider 永不因"用途名不存在"而静默换连接：这正是必须显式可见的降级（§13.3 第 4 项）。
 */
export interface JudgmentTarget {
  /** 用途名。省略时用 provider 的默认连接。 */
  readonly purpose?: PurposeName
  /** 显式指定连接（高级用法，优先于 `purpose`）。 */
  readonly connection?: ConnectionId
}

/**
 * 单次调用的预算上限；provider 另有逐连接 / 逐用途配额（§13.6）。
 *
 * **可执行性（诚实说明）**：`maxMs` 在**发包前**生效——provider 用它收窄这次请求的超时；
 * `maxTokens` / `maxUsd` **只能事后比对**（发包前无法知道端点怎么分词，也没有价目表），
 * 超出预算的那次调用照常返回答案，但会被记进审计 ledger 的 `budgetExceeded`——
 * "已经花掉的钱"没有事后取消这回事。配额（`quota`）才是**发包前**拦截成本的手段。
 *
 * **turn 级熔断不在 provider**——它不知道 turn 边界，挂 `agent/turn-stopping`
 * 属于消费者（§3.3 边界 4、§13.6）。
 */
export interface JudgmentBudget {
  readonly maxTokens?: number
  readonly maxMs?: number
  readonly maxUsd?: number
}

/**
 * 审计血缘：把这次调用链到会话 / 运行 / 步骤（§12.5 `JevOperationLink`）。
 * provider 的发包前落库 ledger 用它做可重放定位。
 */
export interface JudgmentAttribution {
  readonly sessionId?: string
  readonly runId?: string
  readonly stepId?: string
  readonly inputVersion?: string
}

/** `ask` 的选项。全部可选——`ask(state, questions)` 是主路径（§0.3）。 */
export interface AskOptions extends JudgmentTarget {
  /** 取消信号。取消按 `JudgmentError`(`cancelled`) 返回，不返回部分答案。 */
  readonly signal?: AbortSignal
  readonly budget?: JudgmentBudget
  readonly attribution?: JudgmentAttribution
}

/** `health()` 的选项。 */
export interface HealthOptions extends JudgmentTarget {
  readonly signal?: AbortSignal
}

/** `fingerprint()` 的选项——连接身份是指纹的输入之一（§12.5 / §12.6）。 */
export interface FingerprintOptions extends JudgmentTarget {}

/* ─────────────────────────── 结果：answers + fingerprint + usage + provider + model ─────────────────────────── */

/**
 * 计量。**缺项不得当作 0**：`inputTokens`/`outputTokens` 缺失即"未知"，
 * `complete` 明确告知这批计数是否完整（上游 `usageComplete` 纪律，§12.5）。
 * 输出免费、输入约 $0.042/M（§2.2），所以 `estimatedCostUsd` 主要由输入 token 决定。
 */
export interface JudgmentUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  /** 本次调用的墙钟耗时。 */
  readonly latencyMs: number
  /** 估算成本（USD）。协议/定价未知时省略，**不填 0**。 */
  readonly estimatedCostUsd?: number
  /** 计数是否完整；false 表示有缺项，消费者不得按 0 记账。 */
  readonly complete: boolean
}

/**
 * 协议身份。**绑定在连接上、显式选择，不由 URL 推断**（§12.6 原文
 * "Resolve the explicitly selected protocol; custom URLs do not change its identity"）。
 *
 * 已知取值 + 开放扩展：第三方实现（jevos / AnyJev / vllm-jev 等）与
 * `HostModelJudge` 各占一个。
 */
export type ProtocolId =
  /** TypeSafe SystemOne（协议里的 `noul`）。 */
  | 'system-one'
  /** OpenAI-Decisions / Luna（协议里的 `predicate`）。 */
  | 'openai-decisions'
  /** 消费者内置的宿主模型兜底判定。 */
  | 'host-model'
  | (string & {})

/**
 * 指纹的不透明标识。**消费者只比较，不构造、不解析**（§10.2 的 token 定位）。
 *
 * 计算输入 = 规则版本 + 脱敏版本 + 连接身份 + 请求体（§12.5 的"指纹三件套"，
 * 直接抄，不重写）；**不含**本次尝试的血缘（`inputVersion` 属于 ledger，不属于指纹），
 * 所以执行侧算出的指纹与答案携带的指纹可以逐字比较。
 */
export type Fingerprint = string & { readonly __fingerprintBrand: unique symbol }

/** 一次判断的溯源：指纹 + 计量 + 协议 + 连接 + 模型快照。 */
export interface JudgmentProvenance {
  /** 本次请求的指纹；执行侧在动作前用它比对当前快照（不变量 1、§10.2）。 */
  readonly fingerprint: Fingerprint
  readonly usage: JudgmentUsage
  /** 协议身份（§12.6）。 */
  readonly provider: ProtocolId
  /** 实际使用的连接层标识。 */
  readonly connection: ConnectionId
  /**
   * **响应返回的模型快照**（不是配置里的别名）——`jev-latest` 是移动别名，
   * 必须 pin 并记录快照才能做版本对比（§13.4）。
   */
  readonly model: string
}

/**
 * `ask` 的结果。与 §0.4 的字段一一对应：answers + fingerprint + usage + provider + model。
 *
 * 结果里**没有**"默认答案"这一项：没有判断的问题以 {@link AbstainAnswer} 显式出现，
 * 该保留还是该中止由消费者按领域决定（§13.1、§13.2 铁律）。
 *
 * 类型参数 `Q` 让答案键集**在类型层面**跟随问题批次（集合一致）；
 * 省略时退化为通用的 `Record<string, …>`。
 */
export interface JudgmentResult<Q extends JudgmentQuestions = JudgmentQuestions>
  extends JudgmentProvenance {
  /** 键集合与请求的问题批次完全一致。 */
  readonly answers: JudgmentAnswersFor<Q>
}

/* ─────────────────────────── 类型化失败 ─────────────────────────── */

/** 失败发生的阶段——决定消费者该如何反应（重试 / 改配置 / 升级给大脑）。 */
export type JudgmentPhase =
  /** 解析用途名 / 连接 / 凭据引用。 */
  | 'resolve'
  /** 发包前校验请求（零成本拒绝）。 */
  | 'validate-request'
  /** 网络收发。 */
  | 'dispatch'
  /** 响应严格校验（集合 / 归一化 / argmax / 模型名）。 */
  | 'validate-response'
  /** 计量。 */
  | 'meter'

/**
 * 类型化失败的稳定标识。**provider 只抛这些**，且**永不返回默认值**（§13.2 铁律）。
 *
 * 注意 `invalid-response` 与弃答的分工：协议结构合法地"没有判断"是
 * {@link AbstainAnswer}（值），结构非法才是这里（异常）。
 */
export type JudgmentErrorCode =
  /** 调用方问题/状态不合规，发包前拒绝。 */
  | 'invalid-request'
  /** 响应未通过严格校验。**不修复**，整批拒绝（§9.5）。 */
  | 'invalid-response'
  /** 没有可用连接或凭据引用。 */
  | 'not-configured'
  /** 用途名未配置。**不得静默换连接**（§13.3 第 4 项）。 */
  | 'unknown-purpose'
  /** 连接标识不存在。 */
  | 'unknown-connection'
  /** 凭据被拒（401/403）。 */
  | 'unauthorized'
  /** 被限流（429）。 */
  | 'rate-limited'
  /** 超时。 */
  | 'timeout'
  /** 网络不可达或 5xx。 */
  | 'unavailable'
  /** 逐连接 / 逐用途配额耗尽。 */
  | 'quota-exceeded'
  /** 调用被 `signal` 取消。 */
  | 'cancelled'
  /** provider 内部错误。 */
  | 'internal'

/** 失败的形状（`status()` / `health()` 也用它，不只是异常）。 */
export interface JudgmentFailure {
  readonly code: JudgmentErrorCode
  readonly phase: JudgmentPhase
  /** 人类可读信息。**不得包含凭据明文。** */
  readonly message: string
  /** 建议性提示：仅表示"重试可能成功"，重试与否属于消费者的循环决策（§13.2）。 */
  readonly retryable: boolean
  /** 严格校验失败时的结构化定位。 */
  readonly validation?: ValidationFailure
}

/**
 * 类型化失败的**形状**（契约内不含运行期值，所以这里不是 class）。
 *
 * 本类型**不 `extends Error`**：`Error.message` 是可写属性，与
 * {@link JudgmentFailure} 的 `readonly message` 不同构，同一接口无法同时继承两者。
 * 运行期的 `class JudgmentError extends Error implements JudgmentError`
 * 与 `isJudgmentError()` 守卫属于根入口 `"."`（唯一可含运行时代码的入口），
 * 因此 `err instanceof Error` 在运行期仍为真；provider 的类名与本类型同名时，
 * 在 provider 侧给类型起别名即可。
 *
 * 全部失败都走 `throw`；`abstain` 不走异常（它是答案的一种）。
 */
export interface JudgmentError extends JudgmentFailure {
  readonly name: 'JudgmentError'
  /** 失败发生在指纹计算之后时，携带指纹以便审计对齐。 */
  readonly fingerprint?: Fingerprint
  /** 失败前已发生的计量（如拒绝响应时仍保留 usage，§12.5）。 */
  readonly usage?: JudgmentUsage
}

/* ─────────────────────────── 状态与健康 ─────────────────────────── */

/** 单条连接的可见状态。`credentialRef` 是**引用名，永远不是密钥值**（§13.2）。 */
export interface ConnectionStatus {
  readonly connection: ConnectionId
  readonly protocol: ProtocolId
  readonly model: string
  /** 归一化后的 endpoint；不含凭据、query、hash。 */
  readonly baseUrl?: string
  readonly credentialRef?: string
  /**
   * 最近一次观察到的"凭据是否已设值"——**本地快照，不是实时值**。
   *
   * 播种于插件启动，之后由每次 `ask()` / `health()` 刷新。在页面里填密钥**不会**通知
   * provider，所以刚配好时这里可能短暂为 `false`（真机踩过）。
   *
   * 因此它**不参与** {@link PurposeStatus.usable} 的判定：拿它做门控会产生假否定。
   * 真正的凭据问题会在调用时以 `not-configured` 显式返回。
   */
  readonly credentialPresent: boolean
  /** 最近一次 `health()` 探测**成功**过这条连接（本地记忆，不是实时探测）。 */
  readonly verified?: boolean
  /** 上面那次成功的时刻（ISO 8601）。 */
  readonly verifiedAt?: string
}

/** 单个用途的可见状态。`usable` 为 false 时必须给出 {@link failure}。 */
export interface PurposeStatus {
  readonly purpose: PurposeName
  readonly connection?: ConnectionId
  /**
   * 这个用途**零 I/O 可确认**的部分是否就绪：指向的连接存在，且地址非空。
   *
   * 刻意**不包含**"凭据已就绪"——那是本地快照（见
   * {@link ConnectionStatus.credentialPresent}），掺进来会把可用配置判成不可用。
   * 所以 `usable: true` 的准确含义是"这个用途能解析到一条配置完整的连接"，
   * 而不是"这一次调用一定会成功"。
   */
  readonly usable: boolean
  readonly failure?: JudgmentFailure
}

/**
 * `status()` 的返回：**本地状态，零 I/O、零网络**。
 *
 * `configured` 与 `remoteVerified` 必须分开——"本地显示已配置不代表密钥已验证"
 * （§13.3 第 4 项，上游 `jev_status` 的 `configured` vs `remoteVerified: false`）。
 * provider 缺席 / 未配置 / 连接失败必须在 UI 与工具返回里**显式可见**，不能静默退化。
 */
export interface JudgeStatus {
  readonly apiVersion: ApiVersion
  /** 连接 + 凭据引用可解析（不代表远端可用）。 */
  readonly configured: boolean
  /** 最近一次 `health()` 探测成功过。 */
  readonly remoteVerified: boolean
  readonly connections: readonly ConnectionStatus[]
  readonly purposes: readonly PurposeStatus[]
  /** 当前为何不可用；可用时省略。 */
  readonly failure?: JudgmentFailure
}

/**
 * `health()` 的返回：**活的远端探测**。
 *
 * 与 `status()` 的分工：这里是"能不能真的问出去"。探测**可能是一次真实请求**，
 * 因此同样受计量与审计约束（发包前落库，§12.5），`recordId` 指向那条 ledger 记录。
 *
 * 预期的连通性失败**不抛异常**，而是 `ok: false` + `failure`——它是诊断结果，
 * 不是判断失败。
 */
export interface JudgeHealth {
  readonly ok: boolean
  readonly connection: ConnectionId
  readonly protocol: ProtocolId
  /** 探测响应返回的模型快照。 */
  readonly model?: string
  readonly baseUrl?: string
  readonly latencyMs: number
  /** ISO 8601 时间戳。 */
  readonly checkedAt: string
  /** 审计 ledger 记录 id。 */
  readonly recordId?: string
  readonly usage?: JudgmentUsage
  readonly failure?: JudgmentFailure
}

/* ─────────────────────────── 能力接口 ─────────────────────────── */

/**
 * 结构化判断能力。**它判断，消费者决定**（§13.1）。
 *
 * # 消费者的循环，provider 不碰
 *
 * provider 绝不拥有：观察/候选枚举 · 寻址/坐标换算 · 阈值/白名单/门控 ·
 * **fallback 语义** · loop 转移/停止条件 · 独立验证通道 · turn 级预算熔断（§13.2）。
 * 同一协议的安全方向**按领域反转**（裁剪域缺答案 = 全保留；动作域缺答案 = 中止），
 * 所以任何把 loop 收进 provider 的设计都会迫使它认识领域，从而不再是能力提供者。
 *
 * # 消费者可以依赖的四件事
 *
 * 1. **严格校验后才返回**：集合一致 / 分布完整且归一化 / argmax 一致 / 模型名匹配，
 *    失败即抛 {@link JudgmentError}（`invalid-response`），**不修复**。
 * 2. **没有默认值**：没有判断的问题以 {@link AbstainAnswer} 出现。
 * 3. **一次 `ask` = 一次请求**：provider 不静默重试（"重试 = 新采样"，§10.2），
 *    所以每次调用的计量与 ledger 记录都是精确的一次。
 * 4. **溯源齐全**：{@link JudgmentProvenance} —— 指纹 + 计量 + 协议 + 连接 + 模型快照。
 *
 * # 两种实现，同一接口（§13.3 第 3 层）
 *
 * `RemoteJudge`（provider，批量概率判定）与 `HostModelJudge`（消费者内置，零依赖，
 * 把代码枚举好的候选交给宿主 LLM）——降级只换 judge，循环代码不变。
 */
export interface Judge {
  /**
   * 契约版本。消费者比对本地 `EXPECTED`，不兼容时降级而不是崩溃（§13.3 第 2 层）。
   */
  readonly apiVersion: ApiVersion

  /**
   * 协议硬边界的运行期真值来源（可选）。
   * provider 实现**应当**提供，以免调用方与 provider 的边界数字漂移。
   */
  readonly limits?: JudgmentLimits

  /**
   * 一次批量判断：`ask(state, questions)`（§0.3 定稿签名）。
   *
   * - **恰好一次请求**，不静默重试；重试是消费者的新采样决策。
   * - 结构合法但"没有判断"的问题 → {@link AbstainAnswer}（值，不抛）。
   * - 结构非法 / 传输失败 / 凭据问题 / 配额耗尽 → 抛 {@link JudgmentError}。
   * - 类型参数 `Q` 由 `questions` 推断，答案因此逐键精确（集合一致）；实现方在
   *   响应校验通过后需要一次 `as`。
   *
   * @param state 不透明状态载荷；随每一批问题重复发送，所以**状态规模是成本的主要变量**（§5.1）。
   * @param questions 命名问题批次，至少一个。
   * @param options 用途 / 连接 / 预算 / 血缘 / 取消信号。
   */
  ask<Q extends JudgmentQuestions>(
    state: JudgmentState,
    questions: Q,
    options?: AskOptions,
  ): Promise<JudgmentResult<Q>>

  /**
   * 计算"当前快照"的指纹，供**执行侧在动作前比对**（不变量 1：地址只对产生它的快照有效）。
   *
   * 为什么在接口上：`ask` 返回的 {@link JudgmentResult.fingerprint} 与这里算出的值
   * 可以直接比较，从而把"执行前重新确认新鲜度"从约定变成结构保证（§10.2）。
   * 指纹配方（规则版本 + 脱敏版本 + 连接身份 + 请求体）属于 provider（§13.2），
   * 消费者**不要自己重算或缓存配方**，否则就是多份实现必然漂移。
   *
   * **纯本地、同步、零 I/O**：不读凭据明文、不发网络请求。
   * 同一 `(state, questions, 连接身份)` → 同一指纹；规则或脱敏版本变化时指纹自然作废。
   */
  fingerprint(
    state: JudgmentState,
    questions: JudgmentQuestions,
    options?: FingerprintOptions,
  ): Fingerprint

  /**
   * 本地状态快照（零 I/O）：`configured` / `remoteVerified` / 逐连接与逐用途可用性。
   * 降级必须显式可见——调用方据此决定是走 `HostModelJudge` 还是提示用户配置（§13.3）。
   */
  status(): JudgeStatus

  /**
   * 远端健康探测：验证连接、凭据、协议与模型名真的可用。
   *
   * 探测**可能产生真实请求**（受计量与审计约束）。预期失败以 `ok: false` 返回，不抛异常；
   * 因为"已配置"不等于"已验证"（§13.3 第 4 项）。
   */
  health(options?: HealthOptions): Promise<JudgeHealth>
}
