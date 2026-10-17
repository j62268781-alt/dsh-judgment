# dsh-judgment · Judgment

A structured-judgment plugin for **DeepSeek Harness**: one call = one state + a batch of named
questions → a batch of probability answers.

**Language:** English (this file) · [中文](README.md)

> **It judges; your agent decides.** This plugin provides exactly one capability — batched
> probabilistic judgment — and **no loop**. Observation, addressing, thresholds, what to do when
> an answer is missing, and loop transitions all stay on the consumer's side.

---

## What this is

```
        ┌─────────────────────── dsh-judgment ───────────────────────────┐
        │  ctx.judgment: multi-protocol normalization · strict validation │
        │  credentials · audit ledger · metering · fingerprint            │
        └───┬──────────────────┬───────────────────┬─────────────────────┘
            │ direct Service    │ direct Service     │
   ┌────────▼────────┐ ┌───────▼────────┐ ┌────────▼─────────┐
   │ dsh-sidebar-    │ │ the LLM / your  │ │ any plugin that  │
   │ mobile's loop   │ │ own agent loop  │ │ holds a ctx      │
   └─────────────────┘ └────────────────┘ └──────────────────┘
```

One JEV call = **one state + a batch of named questions** → **a batch of probability answers**.
Once you see that, "open up judgment to X" becomes "express X's judgments as batched
probabilistic questions".

The three question primitives:

| Primitive | Meaning | Answer |
|---|---|---|
| `noul` | a single probability p ∈ [0,1] (yes/no) | `{ probability }` |
| `choice` | one pick among 2–255 mutually exclusive candidates | `{ optionId, probabilities }` — the **full distribution**, not just the argmax |
| `score` | 2–10 ordered levels | `{ value, probabilities }` — `value` is a **level position** and may be fractional |

**Why batching is mandatory**: the state is sent once per batch, so batching is roughly a
**38×** difference in cost versus asking one question at a time. Asking one question per call is
the natural way to write it, and it costs an order and a half of magnitude more.

---

## What works today (honest list)

| Capability | Status |
|---|---|
| `ctx.judgment` Service · two-layer config (connection × purpose) · config page (CRUD + key + **self-check button**) | ✅ works |
| `ask()` batched judgment · `health()` remote self-check | ✅ **working** (SystemOne; measured against a real endpoint at ~500 ms) |
| Two protocols: `system-one` (`noul`) · `openai-decisions` (`predicate`) | ✅ system-one verified live; openai-decisions implemented from the upstream reference but **not yet verified against a real endpoint** |
| Strict validation: answer-set equality / distribution completeness / normalization 0.02 / argmax 1e-6 / model snapshot | ✅ implemented — **reject on failure, never repair** (both protocols share one set of tolerances) |
| Structured validation detail (rule + candidate count + Σp + tolerance) · also recorded in the ledger | ✅ implemented (consumers decide **deterministically** how far to shrink before re-sampling) |
| Audit ledger (written before dispatch) · hourly quotas (per connection / per purpose) · metering | ✅ implemented; a failed ledger write **never blocks** a judgment (it logs) |
| Tool face (`judgment/llm-face`, optional component) | ⏳ not implemented (off by default) |

> ⚠️ **A plugin update needs a DSH restart**: the host half is a Node module, loaded once at process
> start; the client half takes effect on page refresh. If the self-check reports `HTTP 404` /
> `transport failure`, the host half is almost certainly still the old build.

`score`'s semantics were **calibrated against the real endpoint**: it returns the **expected value**
of the level distribution (a continuous position), not an integer index — 0.84 with 3 levels,
1.42 with 4, matching `Σ i·p_i` to the digit. So if you need a discrete level, take the mode of the
distribution; the provider never rounds for you.

---

## Install

```bash
# Local path (development; profile names live in ~/.dsh/profiles)
dsh plugin --profile <profile> add /absolute/path/to/dsh-judgment

# Or from GitHub (the repo root carries cordis.patch.yml, so it installs as a plugin package)
dsh plugin --profile <profile> add github:j62268781-alt/dsh-judgment
```

Then configure it under **Settings → 决策**. The plugin registers **zero tools** — it never puts
anything in front of the model, it only registers a Service. (A tool face is a separate,
off-by-default component.)

---

## Configuration: connection layer × purpose layer

The config page has two tabs; the same fields can be written by hand in the profile's
`cordis.patch.yml`:

```yaml
- id: judgment/provider
  name: dsh-judgment
  config:
    connections:                    # connection layer: one (protocol, baseUrl, model, credential) tuple
      typesafe-main:
        protocol: system-one        # system-one | openai-decisions (protocol identity is explicit, never inferred from the URL)
        baseUrl: https://api.typesafe.ai/v1/systemone
        model: typesafe/jev-1.13    # pin an exact version; avoid aliases that drift
        credentialRef: JUDGMENT_API_KEY_1
        timeoutMs: 10000
    purposes:                       # purpose layer: consumers only ever name a purpose
      browser.action: { connection: typesafe-main }
      compaction.retain: { connection: typesafe-main }
    defaultConnection: ''           # used when a call names no purpose; left empty with exactly one
                                    # connection configured, that connection is used
```

**What a "purpose" is for**: it is the consumer's **stable name**, decoupling "I need this kind
of judgment" from "which connection / model / key serves it". Your code says `browser.action`;
switching vendors, models, or keys is a config edit and touches no consumer code.
An unknown purpose name is an **error** — it never silently falls back to another connection.
Several purposes may share one connection; one purpose points at exactly one connection.

---

## Where the key lives

Key values are **never written into configuration**. The credential reference name *is* the
environment variable name (that is how the DSH credential service is designed), so there are two
routes:

| Route | How | What the page shows |
|---|---|---|
| Type it on the page | Settings → 决策 → connection → key (password field, **never echoed back**) | "已配置 · 来源 file" (configured · source: file) |
| Environment variable | set `JUDGMENT_API_KEY_1=sk-xxx` before launching DSH (or put it in a dotenv) | "由启动环境提供（只读）" (provided by the launch environment, read-only), input locked |

Precedence: **launching environment > stored file > project dotenv > user dotenv**.
The launching-environment layer is read-only and cannot be overwritten; the stored file never
displaces it.

The reference name is allocated for you (`JUDGMENT_API_KEY_1`, `_2`, …, taking the lowest free
number), so you never have to remember it. Deleting a connection **clears its key first** —
numbers get recycled, and otherwise the next connection would read a stale key.

> ⚠️ Both environment variables and dotenv are captured **at launch**: adding or changing one
> while DSH is running is not observed. Set it before starting DSH.

---

## Consuming it

```ts
import type { ApiVersion, Judge } from 'dsh-judgment/contract'

const EXPECTED: ApiVersion = 1                          // the version contract is this local constant
const judge = ctx.get('judgment') as Judge | undefined   // optional dependency: undefined, never throws
if (!judge || judge.apiVersion !== EXPECTED) return useFallbackJudge()

const state = { page: 'a11y snapshot …' }                // an opaque payload whose shape you choose
const questions = {
  action: {
    kind: 'choice',
    prompt: 'Which single action best advances the task?',
    options: { e0: 'Click Search', e1: 'Type in the box' },
  },
  goal_done: { kind: 'noul', prompt: 'The task goal has been achieved' },
  retain: { kind: 'score', prompt: 'How much of this must be kept verbatim?', levels: ['drop', 'truncate', 'keep'] },
}

const result = await judge.ask(state, questions, { purpose: 'browser.action' })

for (const [id, answer] of Object.entries(result.answers)) {
  // A question with no judgment comes back as `abstain` — it is NOT a missing key.
  // Whether to keep or abort is your domain's call.
  if (answer.kind === 'abstain') continue
  if (answer.kind === 'choice') console.log(id, answer.optionId, answer.probabilities)
}

// Invariant: an address is only valid for the snapshot that produced it.
// Compare fingerprints before acting and drop the decision when they differ.
const now = judge.fingerprint(state, questions, { purpose: 'browser.action' })
if (now !== result.fingerprint) return 'stale_state'
```

Every result carries its provenance: `answers` · `fingerprint` · `usage` (tokens / latency /
estimated cost / complete-or-not) · `provider` (protocol identity) · `connection` ·
`model` (**the model snapshot the response returned**).

The contract entry `dsh-judgment/contract` is **types only**: zero `import`, zero runtime
values. With `import type` it is erased at compile time, so **nothing of this plugin enters your
runtime**. It pins the `Judge` interface, the three primitives, the answer shapes, the validation
tolerances, and the shape of `JudgmentError` — provider implementations, third-party
replacements, and the `HostModelJudge` fallback all align to it.

### Purpose preset: `browser.action`

The recommended configuration for "action domain" consumers (the preset name comes from
`dsh-agent-browser`'s live calibration):

```yaml
purposes:
  browser.action: { connection: typesafe-main }
```

**Keep candidate counts at or below 16.** Six samples per target
(`decision-model-preview`, compact state ~2.9k tokens):

| Candidate cap | Hit rate | Strict-validation rejection | tokens/call |
|---|---:|---:|---:|
| 10 | 5/5 | 0/6 | 2,879 |
| 16 | 4/5 | 0/6 | 3,026 |
| 40 | 3/5 | **6/6** | 3,689 |

With many candidates the model **systematically under-normalizes** (measured Σp = 0.95–0.98,
positively correlated with candidate count) and trips `distribution-normalized`. That is
**not** a reason to loosen the tolerance — loosening means "repairing the answer", replacing
evidence with a guess — it is a reason for the **consumer** to shrink candidates. Latency
reference: a single `ask` takes 210–350 ms.

### What a validation failure looks like (deterministic consumer decisions)

```ts
try {
  await judge.ask(state, questions, { purpose: 'browser.action' })
} catch (error) {
  if (error instanceof JudgmentError && error.code === 'invalid-response') {
    const { rule, questionId, optionCount, sum, tolerance } = error.validation ?? {}
    // e.g. retry with half the candidates. Re-sampling is the consumer's decision; the
    // provider never retries on its own.
    const nextCap = optionCount === undefined ? 16 : Math.max(4, Math.floor(optionCount / 2))
  }
}
```

`rule` is one of the seven validation rules; `optionCount` / `sum` / `tolerance` are
**numbers** (present only when determinable — nothing is invented, e.g. `distribution-complete`
carries no `sum`). So consumers never have to scrape numbers out of `message`. Read
`tolerance` **at runtime**; do not hard-code it — it is fixed by the contract but may change
across contract versions.

Those numbers are also written to the audit ledger (`validationSum` / `validationOptionCount`),
so calibrations like "more candidates, worse normalization" can be **recomputed from the
ledger** instead of taken on faith.

### On `HostModelJudge`: why this plugin does not ship it

The contract describes it (a host-model fallback implementing the same `Judge` for when there
is no Jev connection). It belongs on the **consumer** side, for two reasons:

1. It spends main-model tokens, which changes this plugin's "judgment layer costs no
   main-model tokens" positioning — it must be an explicit consumer opt-in;
2. It needs `ctx.llm` — once the provider depends on the host model it is no longer a
   zero-tool capability provider.

So the recipe is: write a ~100-line `Judge` yourself (call the host model inside `ask`, feed the
distribution through **the same validation semantics**, reject instead of repairing).
`ProtocolId` already reserves `'host-model'` for ledger provenance. To reuse the validation
core, `src/provider/wire.ts` (MIT) can be vendored. If an official implementation is wanted,
it should be a **separate opt-in package**, not part of this plugin.

---

## Development

```bash
pnpm install
pnpm build            # host (tsc) + client (esbuild → lib/client.js)
pnpm test             # Service / contract / client handoff / pure logic / react-dom render
pnpm typecheck        # contract compiled with exactOptionalPropertyTypes + noUncheckedIndexedAccess
pnpm verify:contract  # enforces the contract's zero-import, zero-runtime-value discipline
pnpm verify:served    # asks the running DSH whether this plugin's client half is composed and live
pnpm probe            # live probe: one real request through the protocol modules (reads the local profile + credential)
pnpm live             # live integration: boots a minimal service and calls ask() / health() end to end
pnpm verify:remote    # verifies the Remote path behind the config page's self-check button (both halves, plus a wire-contract cross-check)
```

Layout:

```
src/contract/index.ts   the single frozen surface (types only, zero dependencies)
src/index.ts            entry ".": registers ctx.judgment
src/config.ts           the two-layer config (schemastery)
src/provider/           error type · fingerprint
client/                 the config page (JSX only; esbuild wraps it into one window.__ModuleLoader__ file)
tests/                  service / contract / client handoff / pure logic / render
```

Design rules, all written up in the contract's TSDoc: **a validation failure rejects — it never
"repairs"** (repairing an inconsistent probability distribution means covering evidence with a
guess); **the provider never returns a default**, no judgment is `abstain`; and **the loop stays
with the consumer** — the safe direction reverses by domain (a missing answer means "keep
everything" when trimming and "abort" when acting).

---

## Roadmap

1. **Live calibration for `openai-decisions`** — the protocol is implemented with unit fixtures, but
   there is no connection or key for it on hand. Once one exists, run `pnpm probe` and backfill the
   three open questions (does the response echo `model`; is `score` a level index or an expected
   value like SystemOne's; what exactly does a refusal look like).
2. **Quota visibility** — quotas only speak when they reject (`quota-exceeded`); the contract's
   `ConnectionStatus` / `PurposeStatus` carry no usage field yet, so the page cannot show
   "12/60 this hour".
3. **Tool face (`judgment/llm-face`, optional component)** — three semantically narrow tools plus
   one skill, off by default, never exposing raw state/questions.

---

## License

MIT
