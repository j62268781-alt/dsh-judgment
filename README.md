# dsh-judgment · 决策

面向 **DeepSeek Harness** 的结构化判断插件：一次调用 = 一份状态 + 一批命名问题 → 一批概率答案。

**语言：** 中文（本文件） · [English](README.en.md)

> **它判断，消费者决定。** 本插件只提供「批量概率判定」这一项能力，**不提供循环**——
> 观察、寻址、阈值门控、缺答案时的取舍、loop 转移，全部留在消费者（你的 agent）那一侧。

---

## 这是什么

```
        ┌─────────────────────── dsh-judgment ───────────────────────┐
        │  ctx.judgment：多协议归一化 · 严格校验 · 凭据 · 审计 · 计量 · 指纹 │
        └───┬──────────────────┬───────────────────┬────────────────────────┘
            │ Service 直调      │ Service 直调       │
   ┌────────▼────────┐ ┌───────▼────────┐ ┌────────▼─────────┐
   │ dsh-sidebar-    │ │ LLM / 你自己的   │ │ 任何拿到 ctx 的   │
   │ mobile 的循环    │ │ agent 循环       │ │ 插件             │
   └─────────────────┘ └────────────────┘ └──────────────────┘
```

一次 JEV 调用 = **一份状态 + 一批命名问题** → **一批概率答案**。理解这一点之后，
「把判断能力开放出去」就变成「如何把领域判断表达成批量概率问题」。

当前已实现的三种问题原语：

| 原语 | 语义 | 答案 |
|---|---|---|
| `noul` | 单个概率 p ∈ [0,1]（是/否） | `{ probability }` |
| `choice` | 2–255 个互斥候选单选 | `{ optionId, probabilities }`（**完整分布**，不只是 argmax） |
| `score` | 2–10 个有序级别 | `{ value, probabilities }`（`value` 是**级别位置**，可为小数） |

**为什么必须批量**：状态随每一批问题只发一次，批量相比逐个提问约 **38 倍**量级差异。
「一次问一个问题」是很自然的写法，但它会让成本高一个半数量级。

---

## 现在能用什么（诚实清单）

| 能力 | 状态 |
|---|---|
| `ctx.judgment` Service · 两层配置（连接 × 用途）· 配置页（增删改 + 密钥 + **自检按钮**） | ✅ 可用 |
| `ask()` 批量判断 · `health()` 远端自检 | ✅ **已跑通**（SystemOne，真端点实测 500ms 量级） |
| 两套协议：`system-one`（`noul`）· `openai-decisions`（`predicate`） | ✅ system-one 真网实测；openai-decisions 按**两份独立公开文档**逐条核对（并修掉 3 处错误假设），**仍无真机** |
| 严格校验：答案集合一致 / 分布完整 / 归一化 0.02 / argmax 1e-6 / 模型名快照 | ✅ 已实现，**失败即拒不修复**（两套协议共用同一份容差） |
| 校验失败的结构化定位（规则 + 候选数 + Σp + 容差）· 并记进 ledger | ✅ 已实现（消费者据此**确定性**决定缩多少候选重采） |
| 审计 ledger（发包前落库）· 逐小时配额（连接层 / 用途层）· 计量 | ✅ 已实现；落盘失败**不阻断判断**（只记日志） |
| 工具面（`judgment/llm-face`，可选组件） | ⏳ 未实现（默认关） |

> ⚠️ **插件更新后要重启 DSH**：host 半是 Node 侧模块，进程启动时加载一次；客户端半改了刷新页面即生效。
> 自检若报 `HTTP 404` / `transport failure`，基本就是 host 半还没重载。

`score` 的语义是**实测校准**过的：它返回的是级别分布的**期望值**（连续位置），不是整数下标 ——
3 级时 `0.84`、4 级时 `1.42`，与 `Σ i·p_i` 逐位吻合。所以需要离散级别时请取分布的众数，
provider 绝不替你四舍五入。

---

## 安装

```bash
# 本地路径（开发用；profile 名见 ~/.dsh/profiles）
dsh plugin --profile <profile> add /绝对路径/dsh-judgment

# 或从 GitHub 装（仓库根带 cordis.patch.yml，可直接作为插件包安装）
dsh plugin --profile <profile> add github:j62268781-alt/dsh-judgment
```

装完在 **设置 → 决策** 里配置。本插件**零工具**：它不会往模型面前塞任何工具，
只注册一个 Service（工具面是另一个可选组件，默认关）。

---

## 配置：连接层 × 用途层

配置页两个页签，字段也可以直接手写在 profile 的 `cordis.patch.yml`：

```yaml
- id: judgment/provider
  name: dsh-judgment
  config:
    connections:                    # 连接层：一个 (协议, 地址, 模型, 凭据) 元组 = 一条连接
      typesafe-main:
        protocol: system-one        # system-one | openai-decisions（协议身份显式，不由 URL 推断）
        baseUrl: https://api.typesafe.ai/v1/systemone
        model: typesafe/jev-1.13    # 请 pin 到具体版本，别用会漂移的别名
        credentialRef: JUDGMENT_API_KEY_1
        timeoutMs: 10000
    purposes:                       # 用途层：消费者只报用途名
      browser.action: { connection: typesafe-main }
      compaction.retain: { connection: typesafe-main }
    defaultConnection: ''           # 调用没给用途名时用它；留空且只配了一条连接时用那一条
```

**「用途」是干什么的**：它是给消费者的**稳定名字**，把「我要这类判断」和
「这判断具体走哪条连接 / 哪个模型 / 哪把密钥」解耦开。代码里写 `browser.action`，
换厂商、换模型、换密钥都只改配置，不动消费者一行代码。
未知用途名**直接报错**，绝不静默换一条连接。
多个用途可以共用一条连接；一个用途只能指向一条连接。

**第二套协议 `openai-decisions` 长这样**（端点是 `/v1/decisions`，模型 `gpt-6-luna`；
只按输入计费 $0.10 / 1M、输出免费，所以 `usage.outputTokens` 恒为 0 不必奇怪）：

```yaml
    connections:
      openai-decisions:
        protocol: openai-decisions          # 协议身份显式；不由 URL 推断
        baseUrl: https://api.openai.com/v1/decisions
        model: gpt-6-luna
        credentialRef: JUDGMENT_API_KEY_2
```

**两套协议的 `score` 语义是同一个**：0 基级别的**概率加权均值**（可落在两级之间），
所以消费者换协议不用改读数方式。

> **已知不支持的子集**：`openai-decisions` 官方允许 `input` 传消息数组（含 inline base64 图片，
> 最多 128 张），而本插件的 `state` 是 JSON、`input` 只会以**字符串**发出 —— 所以**不支持图像输入**。
> 需要视觉判断时请走主模型侧；这里只做纯文本的结构化判断。

---

## 密钥怎么给

密钥**永远不写进配置**。凭据引用名本身就是环境变量名（DSH 凭据服务的设计），
所以两条路都行：

| 方式 | 怎么做 | 页面表现 |
|---|---|---|
| 页面上填 | 设置 → 决策 → 连接 → 密钥（密码框，**保存后不回显**） | 显示「已配置 · 来源 file」 |
| 环境变量 | 启动 DSH 之前设 `JUDGMENT_API_KEY_1=sk-xxx`（或写进 dotenv） | 显示「由启动环境提供（只读）」，输入框锁住 |

优先级：**启动环境 > 存储文件 > 项目 dotenv > 用户 dotenv**。
启动环境那一层只读且不可覆盖；存储文件永远不覆盖启动环境。

引用名由插件自动分配（`JUDGMENT_API_KEY_1`、`_2`…，取最小空号），你不需要记它。
删除连接时会**先清除它的密钥**——序号会被回收，否则新连接会读到上一把遗留的 key。

> ⚠️ 环境变量与 dotenv 都是**启动时**取的快照：运行中新增 / 修改变量不会被读到，
> 必须在启动 DSH 之前设好。

---

## 消费者怎么用

```ts
import type { ApiVersion, Judge } from 'dsh-judgment/contract'

const EXPECTED: ApiVersion = 1                         // 版本契约就是本地这个常量
const judge = ctx.get('judgment') as Judge | undefined  // 可选依赖：缺失返回 undefined，不抛错
if (!judge || judge.apiVersion !== EXPECTED) return useFallbackJudge()

const state = { page: 'a11y 摘要……' }                    // 不透明载荷，形状由你定
const questions = {
  action: {
    kind: 'choice',
    prompt: '哪一步最能推进当前任务？',
    options: { e0: '点击「搜索」', e1: '在输入框输入' },
  },
  goal_done: { kind: 'noul', prompt: '任务目标已经达成' },
  retain: { kind: 'score', prompt: '这段输出要逐字保留多少？', levels: ['丢弃', '截断', '保留'] },
}

const result = await judge.ask(state, questions, { purpose: 'browser.action' })

for (const [id, answer] of Object.entries(result.answers)) {
  // 没有判断的问题以 abstain 出现，**不是缺键**：该保留还是该中止由你的领域决定
  if (answer.kind === 'abstain') continue
  if (answer.kind === 'choice') console.log(id, answer.optionId, answer.probabilities)
}

// 不变量：地址只对产生它的快照有效。执行前用指纹比对，不一致就丢弃。
const now = judge.fingerprint(state, questions, { purpose: 'browser.action' })
if (now !== result.fingerprint) return 'stale_state'
```

结果里带齐溯源：`answers` · `fingerprint` · `usage`（token / 耗时 / 估算成本 / 是否完整）·
`provider`（协议身份）· `connection` · `model`（**响应返回的模型快照**）。

契约入口 `dsh-judgment/contract` **只出类型**：零 `import`、零运行时值，
`import type` 之后编译期就被擦除，**运行期不引入本插件的任何代码**。
它固定了 `Judge` 接口、三种问题原语、答案形状、校验容差与 `JudgmentError` 的形状——
provider 实现、第三方替换、`HostModelJudge` 兜底都按它对齐。

### 用途预设：`browser.action`

"动作域"消费者的推荐配置（预设名来自 `dsh-agent-browser` 的实测校准）：

```yaml
purposes:
  browser.action: { connection: typesafe-main }
```

**候选数建议 ≤ 16**。同一目标各采样 6 次（`decision-model-preview`，紧凑状态 ~2.9k tokens）：

| 候选上限 | 命中率 | 严格校验拒绝率 | tokens/次 |
|---|---:|---:|---:|
| 10 | 5/5 | 0/6 | 2,879 |
| 16 | 4/5 | 0/6 | 3,026 |
| 40 | 3/5 | **6/6** | 3,689 |

模型在候选多时**系统性欠归一**（实测 Σp = 0.95–0.98，与候选数正相关），会撞上
`distribution-normalized`。这**不是放宽容差的理由**（放宽等于"修复答案"、等于用猜测
覆盖证据），而是**消费者该缩候选**的理由。延迟参考：单次 `ask` 210–350 ms。

### 校验失败长什么样（供消费者**确定性**决策）

```ts
try {
  await judge.ask(state, questions, { purpose: 'browser.action' })
} catch (error) {
  if (error instanceof JudgmentError && error.code === 'invalid-response') {
    const { rule, questionId, optionCount, sum, tolerance } = error.validation ?? {}
    // 例：缩到一半重采。重采 = 新采样，是消费者的决定；provider 不重试。
    const nextCap = optionCount === undefined ? 16 : Math.max(4, Math.floor(optionCount / 2))
  }
}
```

`rule` 是七条校验规则之一；`optionCount` / `sum` / `tolerance` 是**数字**
（能确定时才给，不知道就不编——`distribution-complete` 不含 `sum`）。
所以消费者不必从 `message` 里正则抠数字。**容差请运行期读 `tolerance`**，不要写死：
它是契约定稿，但契约升版时可能变。

这些数值也会记进审计 ledger（`validationSum` / `validationOptionCount`），
于是"候选越多、Σp 越欠归一"这类校准可以**从账本复算**，不靠手记。

### 关于 `HostModelJudge`：为什么本插件不内置

契约里描述了它（实现同一个 `Judge` 的"宿主模型兜底"，没有 Jev 连接时降级）。
它**归属消费者侧**，不在 provider 内，理由两条：

1. 它消耗主模型 token，会改变本插件"判断层不花主模型 token"的定位，必须是消费者显式 opt-in；
2. 它需要 `ctx.llm`——provider 一旦依赖主模型，就不再是"零工具的纯能力提供者"。

所以做法是：消费者自己写一个约百行的 `Judge`（`ask` 里调主模型，把分布喂给**同一套校验语义**，
失败即拒），`ProtocolId` 里已留 `'host-model'` 以便账本溯源。需要复用校验核心的话，
`src/provider/wire.ts`（MIT）可以直接 vendored 过去。
如果确实想要官方维护，那也应该是一个**单独的 opt-in 包**，而不是塞进本插件。

---

## 开发

```bash
pnpm install
pnpm build            # Host(tsc) + 客户端(esbuild → lib/client.js)
pnpm test             # Service / 契约 / 客户端交接 / 纯逻辑 / react-dom 渲染
pnpm typecheck        # 含契约的 exactOptionalPropertyTypes + noUncheckedIndexedAccess
pnpm verify:contract  # 强制契约零 import、零运行时值
pnpm verify:served    # 问运行中的 DSH：本插件的客户端半是否已被 composer 并生效
pnpm probe            # 真网探针：用协议模块打一次真实端点（直接读本机 profile 与凭据）
pnpm live             # 真网集成：boot 最小服务，走完整 Service 调 ask() / health()
pnpm verify:remote    # 验证设置页「自检」走的 Remote 通路（两端都用本插件产物 + 交叉校验线契约）
```

目录：

```
src/contract/index.ts   唯一冻结面（仅类型，零依赖）
src/index.ts            入口 "."：注册 ctx.judgment
src/config.ts           两层配置（schemastery）
src/provider/           错误类型 · 指纹
client/                 配置页面（统一 JSX，esbuild 打成 window.__ModuleLoader__ 单文件）
tests/                  服务 / 契约 / 客户端交接 / 纯逻辑 / 渲染
```

设计要点（都写在契约的 TSDoc 里）：**校验失败即拒、绝不"修复"**——"修复"一个不自洽的
概率分布等于用猜测覆盖证据；**provider 永不返回默认值**，没有判断就是 `abstain`；
**loop 必须留在消费者**——同一协议的安全方向按领域相反（裁剪域缺答案 = 全保留，
动作域缺答案 = 中止）。

---

## 下一步（路线图）

1. **`openai-decisions` 的真网校准**：协议已实现，并按**两份独立公开文档**逐条核对过
   （promptfoo 的 `openai:decisions` provider 文档 + 一个真调两家 API 的对比项目），
   本轮据此修掉三处错误假设（`score` 是 0 基级别的**概率加权均值**、`levels.label` 是级别名、
   分布项的键字段与 `label` 都要宽容读）。**仍缺真机**——手上没有那条连接与密钥。
   剩下只有三处要真机确认：分布项键名是 `value` 还是 `index`、非拒答答案是否带 `type`、
   响应是否回显 `model`（代码对三者都取"宽容读取、语义照严"）。
2. **配额可视化**：现在配额只在被拒时以 `quota-exceeded` 说话；契约的 `ConnectionStatus` /
   `PurposeStatus` 里还没有用量字段，所以页面看不到"本小时 12/60"。
3. **工具面（`judgment/llm-face`，可选组件）**：3 个语义窄工具 + 1 份 skill，默认关，
   绝不暴露原始 state/questions。

---

## 许可

MIT
