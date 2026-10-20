# dsh-judgment · 设计与实现的差异记录

> 这份文件回答一个问题：**最初的调研设计文档（`~/Downloads/jev-决策开放-调研与实现设计.md`）
> 与现在这堆代码之间，哪些结论被实测或工程现实改掉了、为什么、证据在哪。**
>
> 只记录**差异**，不复述设计；冲突之处**以本文件为准**。那份 104KB 的调研文档保留作
> "调研原始记录"——它的价值在证据链（上游源码行号、五个铁律的出处），不在结论的时效性。

---

## 一、被实测改掉的结论

### 1. `score` 的取值语义：从"级别下标"到**连续期望值**

| | |
|---|---|
| 原文档 | 只写了 `score`（2–10 级）与答案形状 `{ score, confidence, probabilities }`，**没有定义 `value` 的语义**；首版实现因此按"级别下标"理解 |
| 现在的结论 | `value` = 级别分布的**期望值** `Σ i·p_i`，是**连续位置**，可以落在两级之间；provider 绝不取整 |
| 证据 | 真机 P0′ 探针（`decision-model-preview`）：3 级返回 `0.84`，与 `0·0.45 + 1·0.26 + 2·0.29 = 0.84` **完全一致**；4 级返回 `1.42`，而 `Σ i·p_i = 1.41`，**误差 ≤0.01**（模型只给两位小数）。固件见 `tests/protocol.test.mjs` 的 `PROBE_3` / `PROBE_4` |
| 影响 | 契约 `ScoreAnswer.value` 的 TSDoc 已定稿为"连续期望值"；消费者需要离散级别时应取分布众数。**第二套协议（OpenAI-Decisions）的公开文档确认同一语义**（0 基级别的概率加权均值），所以换协议不用改读数方式 |

> ⚠️ 注意措辞：3 级那次是**逐位一致**，4 级那次是**误差 ≤0.01**。"逐位吻合"这个说法对 4 级不成立。

### 2. 凭据引用名：从"按厂商派生"到**自动分配**

| | |
|---|---|
| 原文档 | §13.4 的连接表里写 `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY`（按厂商派生名字） |
| 现在的结论 | 引用名由插件**自动分配**：`JUDGMENT_API_KEY_1`、`_2`…（取最小空号），用户不需要起名 |
| 为什么改 | ① **删除连接必须先清密钥**，否则序号被回收后新连接会读到上一把遗留 key；② 手写配置里同一个引用名可能被两条连接共用，语义混乱；③ 页面上的密钥输入框要能"保存后不回显"，自动命名让 UI 少一个字段 |
| 影响 | 密钥仍然**永不进配置**：引用名同时是凭据服务里的键，也是环境变量名（`JUDGMENT_API_KEY_1=sk-...` 可在启动前注入，只读且不可覆盖） |

### 3. 工具面 `judgment/llm-face`：**决定不做**

| | |
|---|---|
| 原文档 | §13.5 规划 `judgment/llm-face`（默认关）：注册 3 个语义窄工具（`judge` / `check` / `compare`）+ 1 份 skill |
| 现在的结论 | **不实现**。`judgment/provider` 保持**零工具**，只注册 `ctx.judgment` 服务 |
| 为什么改 | 工具面会把"领域选择"重新塞回 provider（谁可以问、问什么、阈值多少），与 §13.2 的"绝不"列冲突；内核本来就有 bash/工具生态，消费者自己封装更合适。零工具让 provider 是**纯能力提供者**，第三方替换与 `HostModelJudge` 对齐都更简单 |

### 4. `HostModelJudge`：归属确认，**provider 不内置**

| | |
|---|---|
| 原文档 | §13.3 明确它**消费者内置、零依赖**，且是"必需的兜底" |
| 现在的结论 | 与文档一致：**provider 不实现它**；只把配方写进 README（消费方自己写约百行 `Judge`：`ask` 里调主模型 → 喂**同一套校验语义** → 失败即拒；可 vendored `src/provider/wire.ts`） |
| 补充 | `dsh-agent-browser` 建设性提过"希望 dsh-judgment 发布这个 adapter"，我们按契约拒绝：它会消耗主模型 token（改变"判断层不花主模型 token"的定位），且需要 `ctx.llm`，一旦内置 provider 就不再是零工具的纯能力提供者。若要官方维护，应是**单独的 opt-in 包** |

### 5. 设置页 ↔ host 的通路：**不需要 typert 代码生成**

| | |
|---|---|
| 原文档 | 未涉及（grep `typert` / `codegen` 无命中） |
| 现在的结论 | host 半用 `TypertRemoteService` + `@Remote`；Gateway 走**运行期 SRC fallback**，按装饰器 marker 现推 descriptor，**没有代码生成步骤**。客户端半手写 `descriptor()` + `ctx.remote.$mount(...)`，wire 名 = host 方法的参数名，实参个数必须与 `parameters.length` 相等 |
| 踩过的坑 | ① `ctx.remote.judgment` **属性访问会抛** `cannot get property "remote.judgment" without inject`，必须用 `ctx.get('remote.judgment')`；② `scripts/verify-remote.mjs` 存在的意义就是把客户端**真实发出的 args** 喂给 host 交叉验证线契约（这两类错都只在真机上炸） |
| 另一条硬约束 | **host 半改了必须重启 DSH**（Node 侧模块，进程启动时加载一次）；客户端半刷新页面即生效 |

### 6. 配额：实现与文档一致，但**语义收窄**

| | |
|---|---|
| 原文档 | §13.2 / §13.6：逐连接、逐用途配额归 provider；turn 级熔断归消费者 |
| 现在的结论 | 分层不变 ✅，但**收窄为"本地护栏，不是账户额度"** |
| 为什么 | ① 本地计数只覆盖**本插件**的调用；账户额度是所有用同一把 key 的东西加起来 —— 页面显示"12/60"而账户已用 90% 是**虚假的安全感**；② 撞墙时服务端返回 429，已映射为类型化 `rate-limited`（可重试），信号本来就清楚；③ **多实例共用同一账本时可能低估**：计数在各进程内存里，启动播种一次，之后只累加自己的请求 |
| 由此做的决定 | **不做配额可视化**（从路线图移除）；本地配额的价值只剩一条：**多个消费者共用一把 key 时，别让其中一个（比如写错的循环）把预算烧穿**。`ledger` 保留，因为它是与账户**互补**的对账凭证 |

### 7. `status().usable`：不能拿"凭据快照"当判据（真机 bug）

| | |
|---|---|
| 原文档 | §13.3 第 4 项"降级必须显式可见"，没有细化到字段语义 |
| 踩到的 bug | `credentialPresent` 只在 `readCredential()`（即**真的发包之后**）才更新；而用户在页面填密钥是**直接写凭据服务**的，本 Service 收不到通知。于是 `usable = baseUrl && credentialPresent` 会把一条**实际可用**的连接判成"用途不可用"——消费方（dsh-agent-browser）据此拒绝开启功能，属于**假否定** |
| 现在的结论 | ① `[Service.init]` 启动时**播种**凭据存在性（只问 `describe()`，**不读密钥值**；服务异常时保持未知，不写 false）；② `usable` 只反映**零 I/O 可确认**的部分（用途能解析到一条地址非空的连接）；③ 凭据事实由 `connections[].credentialPresent` 单独给出，真没密钥时调用返回类型化 `not-configured` |
| 证据 | 真机：修复前 `DashScope` 报 `credentialPresent: false` 但 `health()` 通（263ms）；修复后**未调用任何方法前**即为 `true` |

### 8. 插件打包（文档未覆盖）：**peer 依赖绝不能写精确版本**

| | |
|---|---|
| 事故 | peer 里写 `"@deepseek-ai/dsh-typert-protocol": "0.2.0-rc.2"`；app 升到 `0.2.1-rc.1` 后，运行期判定 `incompatible-version` → **bundle 的 rows 变 0 → 整个插件不被组合**（设置页整块消失、host 半不加载），不是"少个功能" |
| 现在的结论 | host 侧 seam 的 peer 只允许**区间**（`>=` / `^` / `*`）；devDependencies 可钉精确版本（构建可复现）但要与 app 实际运行的内核对齐（现为 cordis 4.0.5 / cosmokit 1.8.6 / schemastery 3.18.5 / dsh-* 0.2.1-rc.1） |
| 防复发 | `tests/package.test.mjs`：peer 不许出现精确版本；`dsh.bundle.patch` 指向的文件必须存在（同类故障的另一个入口） |

### 9. 第二套协议（`openai-decisions`）：证据链换了来源，修掉 3 处错假设

| | |
|---|---|
| 原文档 | 只有 `dsh-jev-plugin` 的**源码级证据**（§12.6），没有官方文档 |
| 现实 | 官方文档站对脚本抓取返回 **403**；改用两份可交叉验证的独立来源：promptfoo 的 `openai:decisions` provider 文档（2026-10-19 更新）+ 一个**真调两家 API** 的对比项目（给出端点 `POST /v1/decisions`、模型 `gpt-6-luna`、$0.10/1M 仅输入计费） |
| 据此修掉 | ① `score` 是 0 基级别的**概率加权均值**（不是下标）；② `levels.label` 是**级别名**（原实现把下标当 label，方向反了）；③ 分布项的键字段（`value` 或 `index`）与可选的 `label` 都要**宽容读**——原实现把 `label` 当必填、只认 `value`，真机会整批误拒 |
| 仍然未知 | 只有真机能定：分布项键名到底是哪个、非拒答答案是否带 `type`、响应是否回显 `model`（代码对三者宽容读取、语义照严）。**不能**说它"已验证" |

---

## 二、实现里新增、原文档没有的东西

| 新增 | 说明 |
|---|---|
| 校验失败的**结构化数值** | `ValidationFailure` 带 `optionCount` / `sum` / `tolerance`（数字，能确定才给）。消费者据此**确定性**决定重采规模，不用从 `message` 正则抠数字。来自 `dsh-agent-browser` 的实测需求（40 候选时系统性欠归一 0.95–0.98） |
| 这些数值**记进 ledger** | `settled` 行追加 `validationSum` / `validationOptionCount` → "候选越多、Σp 越欠归一"这类校准可以**从账本复算** |
| `health()` 自检 + 页面按钮 | 真发一次最小请求；结果落成卡片上常驻的一行文案。注意 §13.2「不拥有独立验证通道」指的是**不替消费者验证动作是否成功**，连接探测不受此限 |
| `defaultConnection` 为空时取第一条连接 | 便利性：只配一条连接时不需要再指定用途连接 |
| 守卫测试与验证脚本 | `tests/package.test.mjs`（打包纪律）、`scripts/verify-served.mjs`（问运行中的应用客户端半是否生效）、`scripts/verify-remote.mjs`（交叉验证线契约）、`pnpm live` |

---

## 三、明确**不变**的部分（这些都还被尊重）

- **契约**是唯一冻结面：零 `import`、零运行时值、`apiVersion` 仍为 `1`，本期没有任何破坏性变更。
- **容差** `0.02` / `1e-6` 不动 —— 即使第三方实现（promptfoo）用 ±1pp，我们也不跟着漂：容差属于契约。
- **失败即拒、绝不修复**；provider **不重试**（重采 = 新采样，是消费者的决定）；**无默认值/兜底答案**。
- **loop 留在消费者**；观察 / 枚举 / 寻址 / 阈值 / 门控 / fallback 一律不进 provider。
- §2.5 的五条工程不变量（尤其第 1 条"地址只对产生它的快照有效"、第 5 条"概率分布必须严格校验"）。

---

## 四、消费方：谁在用 `ctx.judgment`、依赖哪些面

| 消费方 | 用到的面 | 证据 |
|---|---|---|
| **`dsh-agent-browser`**（同机，`../dsh-agent-browser`） | `ctx.get('judgment')`（可选依赖）· `apiVersion` · `status().purposes[].usable`（开启前门控）· 批量 `ask`（一次 3 问）· `code === 'invalid-response'`（当**新采样**处理）· 结构化 `validation` 数值（据此决定缩多少候选） | `README.md:4,153,208`；`src/index.ts:21` **从 `dsh-judgment/contract` `import type { Judge }`**；`peerDependencies.dsh-judgment` + `peerDependenciesMeta.optional = true`；`src/config.ts` 的用途名默认 `browser.action`；跨会话交接文档 `docs/HANDOFF-to-dsh-judgment.md` 与本仓库的回执 `docs/REPLY-from-dsh-judgment.md` |
| **`dsh-sidebar-mobile`**（同机，`../dsh-sidebar-mobile`） | — **暂无**：全仓库（不限扩展名）、已安装副本、`package.json` 描述、插件目录缓存里都**没有** `judgment` 引用 | `grep -rin judgment` 在仓库与 `~/.dsh/profiles/desktop/node_modules/dsh-sidebar-mobile` 都没有命中 |

**从消费方的用法里学到的两条**（已回灌进契约文档/README）：

1. **"服务在"不等于"能用"**。`dsh-agent-browser` 的 `judgmentAvailability()` 注释记录了真机教训：
   dsh-judgment 装好了、`ctx.judgment` 也在，但 profile 里**没给用途配连接** —— 面板显示"已就绪"，
   一开就失败。所以消费方必须同时检查 ① 服务在、② 目标用途 `usable`，缺一不可。
2. **`invalid-response` 是"新采样"信号，不是"重试"信号**。消费方据此缩候选（24→16→8）再问一次，
   provider 绝不自己重试 —— 这条边界被两个仓库同时遵守。

> 现状：真正在用的消费方**只有一个**。这也是"本地配额只在多个消费者共用一把 key 时才值钱"这个
> 判断的依据（见 §一.6）；等第二个消费方接进来，逐用途配额才开始有意义。

---

## 五、怎么验证上面这些说法

```bash
pnpm test             # 101 项：协议固件 / Service 决策逻辑 / ledger / 配置 / 客户端渲染 / 打包纪律
pnpm typecheck        # 含契约的 exactOptionalPropertyTypes + noUncheckedIndexedAccess
pnpm verify:contract  # 契约零 import、零运行时值
pnpm verify:remote    # 设置页「自检」走的 Remote 通路（两端都用本插件产物）
pnpm verify:served    # 问运行中的 DSH：客户端半是否已被 composer 并生效
pnpm live             # 真网：走完整 Service 打真端点（**不写**用户账本）
```

真机数据的出处都在提交信息里（`feat`/`fix` 的正文），例如 score 语义的两次校准、`usable`
假否定、peer 兼容事故、第二协议的 3 处修正。
