# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。中文为主，英文摘要见每节末尾。

## [0.1.0] — 2026-10-20

首个发布版本。**能力面已定稿**：一个 Service（`ctx.judgment`）、两层配置、一套冻结契约；
工具面与 `HostModelJudge` 都明确**不做**在 provider 里（见 `DESIGN.md` §一）。

### 新增

- **`ctx.judgment` Service**：`ask()` 批量判断（一次请求问多个命名问题）、`fingerprint()`
  快照指纹、`status()` 本地状态（同步、零 I/O）、`health()` 远端自检。
- **三种问题原语**：`noul`（是/否概率）、`choice`（2–255 候选 + 完整分布）、`score`（2–10 级）。
- **两层配置**：连接层 `(protocol, baseUrl, model, credentialRef, timeout, quota)` × 用途层
  （消费者只报用途名）；未知用途**直接报错**，绝不静默换连接。
- **两套协议**：`system-one`（TypeSafe Jev / `noul`）与 `openai-decisions`（`predicate`），
  共用同一套校验核心与容差。
- **严格校验（失败即拒，绝不修复）**：答案集合一致、分布完整、概率范围、归一化 0.02、
  argmax 一致 1e-6、模型快照匹配、答案形状。校验失败带**结构化数值**
  （`optionCount` / `sum` / `tolerance`），供消费者确定性决定重采规模。
- **审计 ledger**（发包前落库、响应后结算）：`request_id`、token、耗时、指纹、校验数值；
  落盘失败**不阻断**判断。
- **本地配额护栏**（逐连接 / 逐用途，默认 `0` 不限）。
- **设置页**：连接 / 用途两页签、密钥为密码框且保存后不回显、删除走官方确认弹窗、
  ⋯ 菜单里的「自检」+ 卡片常驻一行自检结果。
- **冻结契约** `dsh-judgment/contract`：零 `import`、零运行时值、`apiVersion = 1`。

### 真机验证

- `system-one` 对真实端点：`ask()` 178–500 ms、指纹与执行侧重算一致、`health()` 自检通过、
  `request_id` 可与网关日志对上。
- **`score` 的语义经实测定稿**：它是级别分布的**期望值**（连续位置），不是整数下标 ——
  3 级返回 `0.84`（与 `Σ i·p_i` 完全一致）、4 级 `1.42`（与 `1.41` 误差 ≤0.01）。

### 已知限制（诚实清单）

- **`openai-decisions` 没有真机验证**：协议已实现，并按两份独立公开文档逐条核对
  （promptfoo 的 provider 文档 + 一个真调两家 API 的对比项目），据此修掉三处错误假设；
  仍有三处只能等真机能定（分布项键名、非拒答是否带 `type`、是否回显 `model`），
  代码对三者"宽容读取、语义照严"。
- **不支持图像输入**（`state` 是 JSON、`input` 只发字符串；官方允许 inline base64 图片）。
- **本地配额不是账户额度**：只统计本插件调用；多实例共用同一账本时可能低估。因此**不做**
  用量可视化（理由见 README）。
- 工具面 `judgment/llm-face`、`HostModelJudge` **不在 provider 内**（后者归消费者侧，配方见 README）。

### 工程纪律

- 契约零 `import`、零运行时值（`pnpm verify:contract` 强制）。
- peer 依赖只允许区间：写在精确版本会让 app 升版时整插件被判 `incompatible-version`
  （`bundle` 的 rows 变 0，插件整块消失）；有专门守卫测试。
- 契约升版会让直接 `import type` 它的消费方**编译报错**——这是刻意的强制点。

---

**English summary** — First release. One Service (`ctx.judgment`) with batched `ask`, a
types-only frozen contract (`apiVersion = 1`), two wire protocols sharing one strict-validation
core (reject on failure, never repair), an audit ledger, optional local quota guardrails, a
settings page with self-check, and a bilingual README. `system-one` is verified against a real
endpoint; `openai-decisions` is cross-checked against two independent public documents but has
**no live verification**. Image input is not supported. Local quotas are guardrails, not account
quotas.
