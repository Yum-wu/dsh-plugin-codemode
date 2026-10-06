# dsh-plugin-codemode

[![npm version](https://img.shields.io/npm/v/dsh-plugin-codemode.svg)](https://www.npmjs.com/package/dsh-plugin-codemode)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: DeepSeek Harness](https://img.shields.io/badge/Platform-DeepSeek%20Harness-black.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Tests: Passing](https://img.shields.io/badge/Tests-10%2F10%20Pass-brightgreen.svg)]()
[![Engine: Dual (V8 VM + QuickJS)](https://img.shields.io/badge/Engine-Dual%20(V8%20VM%20%2B%20QuickJS)-orange.svg)]()

> **English** | [中文说明](README.zh.md)

**Pi-style Code Mode (Programmatic Tool Calling) for DeepSeek Harness (DSH).**  
Turn verbose O(N) multi-turn ReAct loops into a single O(1) JavaScript orchestration script executed in an isolated memory sandbox.

---

## ⚡ The Benchmark: Hard Numbers

Tested against **all 17 real markdown documents** in the repository's `docs/` folder (including a 131 KB operational ledger, totaling **215,011 raw characters**). The task: scan all documents, filter by keywords (`JEV`, `Polymarket`, `Architecture`), extract titles & line metrics, and return a sorted Top-5 summary JSON.

| Metric | Traditional ReAct Loop | Code Mode (Sandbox Orchestration) | Measured Improvement |
|---|---|---|---|
| **Data Loaded into Context** | 215,011 chars | **676 chars** | **99.7% Reduction** (318:1 distillation) |
| **Estimated Input Tokens** | ~67,191 tokens | **~211 tokens** | **99.7% Saved** (67k tokens spared) |
| **Agent / LLM Turns** | 19 round trips | **1 turn** | **94.7% Fewer Turns** (18 turns eliminated) |
| **Local I/O & Compute Time** | 3.94 ms | **2.76 ms** | Parity (sub-3ms execution) |
| **End-to-End Elapsed Time** | ~47.5 s (at 2.5s / LLM turn) | **~2.5 s** | **19× Faster** (94.7% latency drop) |
| **Computation Accuracy** | Prone to LLM counting hallucinations | Native JS `Array.filter().sort()` | **100% Deterministic & Accurate** |

> *Reproduce locally: `node tests/benchmark-codemode-vs-react.mjs`*

---

## 💡 Why Code Mode?

Modern LLM agents suffer from tool explosion and context pollution:
1. **Context Bloat**: Reading 20 files fills the transcript with 200k tokens of raw data. The model loses track, forgets system instructions, or triggers expensive context compaction.
2. **High Latency**: Every single tool call requires a full round trip of network latency and model inference.
3. **Calculation Flaws**: Asking LLMs to count lines, sort arrays, or calculate statistics over huge text chunks often yields subtle hallucinations.

### The Code Mode Paradigm
> *"Put deterministic things in code, non-deterministic in LLM."* — Hacker News Community Consensus on Code Mode

Inspired by **Pi 1.0 (Earendil)**'s Code Mode architecture and Cloudflare's production agent rewrite:
- **[Pi.dev 1.0 Official Codemode Docs](https://pi.dev/docs/latest/codemode)**: Established the Programmatic Tool Calling paradigm via memory-isolated sandboxing and deferred tool exposure.
- **[Cloudflare / CamelAI Case Study](https://x.com/Vercantez/article/2082138839888589200)**: Rewrote agents from heavy VM containers to Pi Code Mode in Durable Objects, reporting an order-of-magnitude reduction in latency and token costs.
- **Hacker News Discussion ([#49019301](https://news.ycombinator.com/item?id=49019301))**: Highlighted that orchestrating multi-tool workflows via local sandboxed code delivers up to a **99.2% cost reduction** compared to traditional ReAct loops.

With Code Mode, the agent writes a concise JavaScript async function. The script executes inside an isolated sandbox, concurrently calls registered host and MCP tools, filters out unnecessary data in memory, and **only returns the final distilled result** to the conversation context.

---

## 🏗 Architecture

```text
┌──────────────────────────────────────────────────────────┐
│                   DeepSeek Harness (DSH)                 │
│                                                          │
│  ┌──────────────────────┐      ┌──────────────────────┐  │
│  │ LLM Conversation     │      │   ctx.tools / MCP    │  │
│  │ (Main Context)       │      │  (read, pwsh, mcp..) │  │
│  └──────────┬───────────┘      └──────────▲───────────┘  │
│             │ script                       │             │
│             ▼                              │ invoke      │
│  ┌─────────────────────────────────────────┴──────────┐  │
│  │ dsh-plugin-codemode (Cordis Extension)             │  │
│  │                                                    │  │
│  │  ┌──────────────────────────────────────────────┐  │  │
│  │  │ Dual-Engine Sandbox (Isolated Context)       │  │  │
│  │  │                                              │  │  │
│  │  │  • V8 VM Sandbox (Default): native speed,    │  │  │
│  │  │    zero memory caps, unconstrained concurrency│  │  │
│  │  │  • QuickJS-WASM: WebAssembly memory sandbox   │  │  │
│  │  │                                              │  │  │
│  │  │  - Proxy bridge: tools.<name>(args)          │  │  │
│  │  │  - Supports Promise.all concurrency          │  │  │
│  │  │  - Hard timeout guard (default 60s)          │  │  │
│  │  │  - Recursion & leak prevention               │  │  │
│  │  └──────────────────────────────────────────────┘  │  │
│  └──────────────────────────┬─────────────────────────┘  │
│                             │ distilled output only      │
│                             ▼                            │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Return to LLM: [Logs] + [Return Value]             │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## ✨ Features

- **🚀 Dual-Engine Execution**:
  - **V8 VM Engine (`engine: 'vm'`, Default)**: Aligns with DSH's official PTC workflow architecture. Zero overhead, handles multi-megabyte payloads, native microsecond performance.
  - **QuickJS-WASM Engine (`engine: 'quickjs'`)**: Strict WebAssembly memory isolation, zero Node/OS footprint.
- **🔄 Universal Tool Proxy & Dynamic Introspection**:
  - Access all DSH built-in tools (`read`, `edit`, `pwsh`, `glob`) and MCP tools (`mcp__github__*`, `mcp__cua*`, `mcp__tavily__*`) via `tools.<tool_name>(args)`.
  - **Zero-Token Tool Discovery**: Introspect tools dynamically at runtime without polluting system prompts or wasting context tokens:
    - `tools.list()`: Returns the full array of registered tool names in memory.
    - `tools.help('namePattern')`: Inspects parameters and JSON Schemas on-demand inside the sandbox, cutting system prompt bloat by over 90%.
- **🛡 Hard-Safety Protections**:
  - Configurable hard timeout (default 60,000 ms) kills infinite loops automatically.
  - Recursion blocker prevents scripts from invoking `codemode` inside `codemode`.
  - Result truncator caps output at 50,000 characters to prevent accidental prompt floods.
- **📦 Zero-Patch, 100% Reversible**: Pure dynamic Cordis extension. Modifies zero core DSH runtime files.

---

## 📖 Example Scripts

### 1. Parallel File Scan & Distillation
```javascript
// Scan 10 files simultaneously and extract matching headers
const files = await tools.glob({ path: 'src', pattern: '**/*.ts' });
const results = await Promise.all(files.slice(0, 10).map(async (file) => {
  const code = await tools.read({ file_path: file });
  const exportedFns = code.match(/export (?:async )?function \w+/g) || [];
  return { file, count: exportedFns.length, functions: exportedFns };
}));

// Sort by number of exports and return top 3
return results.sort((a, b) => b.count - a.count).slice(0, 3);
```

### 2. Zero-Token Dynamic Introspection & On-Demand MCP Execution
```javascript
// Discover tools dynamically without polluting the prompt with 140+ tool schemas
const available = tools.list();
console.log(`Discovered ${available.length} active tools`);

// Inspect parameters on-demand only when needed
const issueHelp = tools.help('github__list_issues');
console.log(issueHelp);

// Fetch latest issues via GitHub MCP and summarize in memory
const issues = await tools.mcp__github__list_issues({ owner: 'deepseek-ai', repo: 'deepseek-harness' });
const topIssues = issues.slice(0, 3).map(i => ({
  number: i.number,
  title: i.title,
  author: i.user?.login
}));

return topIssues;
```

---

## 🚀 Installation & Setup

### Option A: `dsh plugin add` (Recommended)

```bash
dsh plugin add dsh-plugin-codemode
```

The package declares `dsh.bundle.patch` (`cordis.patch.yml`), so the host row is inserted
into your profile automatically — nothing to hand-edit. Restart DSH and the `codemode`
tool appears.

### Option B: Install from npm manually

In your DSH profile directory (e.g. `~/.dsh/profiles/web`):
```bash
pnpm add dsh-plugin-codemode
# or: npm install dsh-plugin-codemode
```

Then add the row yourself to `~/.dsh/profiles/web/cordis.patch.yml`:
```yaml
- insert:
    - id: plugin-codemode
      name: 'dsh-plugin-codemode'
      config:                  # 全部可选;省略即用默认值
        toolName: 'codemode'
        engine: 'vm'           # 'vm' (default) or 'quickjs'
        maxResultChars: 50000
        timeoutMs: 60000
        injectGuidance: true
```

### Option C: Install from Source (Development)
```bash
git clone https://github.com/Yum-wu/dsh-plugin-codemode.git
cd dsh-plugin-codemode
npm install
npm run build
```

Link into your DSH web profile (`~/.dsh/profiles/web/package.json`):
```json
{
  "dependencies": {
    "dsh-plugin-codemode": "link:C:/Users/Yum/Desktop/dsh-plugin-codemode"
  }
}
```
Then add the row from Option B.

### Restart DSH
Restart the DSH service from your desktop management console. The agent will immediately receive the `codemode` tool declaration and execution guidance.

---

## ⚙️ Configuration Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `toolName` | `string` | `'codemode'` | Name of the tool declared to the LLM. |
| `engine` | `'vm' \| 'quickjs'` | `'vm'` | Execution engine: high-throughput V8 VM or WASM sandbox. |
| `maxResultChars` | `number` | `50000` | Maximum length of distilled output returned to context. |
| `timeoutMs` | `number` | `60000` | Hard deadline per script before auto-termination. |
| `injectGuidance` | `boolean` | `true` | Injects Code Mode orchestration tips into system prompt. |
| `collapseTopLevelTools` | `boolean` | `false` | When on, **only whitelisted tools stay visible at the top level**; the rest vanish from the model’s view. |
| `allowedTopLevelTools` | `string[]` | `DEFAULT_CORE_TOOLS` (37 items) | The whitelist. ⚠ **Full-replacement semantics** (not additive) — see warning below. |

> ⚠️ **`allowedTopLevelTools` REPLACES the default, it does not extend it.** The implementation is `new Set(config.allowedTopLevelTools || DEFAULT_CORE_TOOLS)` — once you set this array, `DEFAULT_CORE_TOOLS` is **ignored entirely**.
> Tools you leave out **disappear from the top level silently**: no error, no warning, nothing in the logs. The model simply cannot see them.
> Measured 2026-10-05: the old `DEFAULT_CORE_TOOLS` had only 11 entries while the runtime registered 36 non-MCP tools — 24 were swallowed, `subagent` among them. Now completed to 37 entries with a guard test. |

---

## 🧠 Auto Reasoning Effort — moved out (2026-10-05)

This plugin no longer implements reasoning-effort selection. It now lives in a standalone
plugin: **[dsh-auto-reasoning](https://github.com/Yum-wu/dsh-auto-reasoning)**.

**Why it moved.** The old code here mounted the platform hook `agent/request`, read
`agent/session` + `session/event`, called `ctx.llm.resolveModelInfo()` and registered a
host `/api` route — **not one line of it belonged to codemode's sandbox / tool-bridge /
truncator.** The hook position was right; the plugin identity was wrong.

**How the two are wired now.** The declaration row for `dsh-auto-reasoning` is shipped by the
**dsh-jev-preset** bundle (same insert group, second row), so installing the JEV preset brings
auto effort with it. codemode is not involved either way.

> ⚠️ **Remove `autoReasoning: true` from your profile's `cordis.patch.yml`.** The config key no
> longer exists, and cordis validates a whole entry at once — a leftover unknown key makes the
> entire `plugin-codemode` entry fail to activate, which shows up as *"the codemode tool
> vanished"*.

> ⚠️ **Do not add `auto: auto` to a model's `reasoningEfforts`.** That advice used to live in this
> README and it is **wrong**: `auto` is not a legal effort key (the legal set is
> `off/minimal/low/medium/high/xhigh/max`), and declaring it there makes the whole provider
> entry fail to activate — every model under it disappears from the picker. Verified against a
> real profile on 2026-10-04; a guard test now ships in DeepSeekHarness
> (`tests/11-cordis-efforts-schema.test.mjs`).


## 🛟 3-Level Zero-Risk Rollback Strategy

| Level | Scenario | Action | Recovery Time | Impact |
|---|---|---|---|---|
| **Level 1 (Soft Disable)** | Unstable model behavior | Add `disabled: true` to `plugin-codemode` in `cordis.patch.yml` and restart DSH. | < 15 seconds | Unregisters `codemode`, reverts to standard single-turn tools. |
| **Level 2 (Runtime Fallback)** | Script syntax or runtime error | Automatic: plugin catches errors and prompts model to fallback to native step-by-step tools. | 0 seconds (instant) | Session is never interrupted; graceful degradation. |
| **Level 3 (Physical Clean)** | Complete uninstall | Remove from `cordis.patch.yml` and `package.json`, delete directory. | < 15 seconds | 0 runtime traces, 0 configuration residues. |

---

## 🧪 Testing

```bash
npm test
```
Runs the unit suite (**10 cases**, `node --test test/*.test.js`):
- `sandbox.test.js` (4): basic evaluation and return values, `console.log`/`text()` capture, isolation (no Node process/filesystem leaks), hard timeout on infinite loops.
- `bridge.test.js` (3): `Promise.all` parallel tool execution, rejection of recursive `codemode` calls, oversized-output truncation.
- `apply-guard.test.js` (2): regression guards — `apply()` must never call `ctx.waterfall` (it is an emitter; doing so took the host down as fatal on 2026-10-03), and `apply()` no longer depends on the `llm`/`connection` services after auto-effort moved out.
- `bundle-declaration.test.js` (1): the `dsh.bundle.patch` declaration is parsed correctly by the host (skipped when no DSH runtime is present).

---

## 📄 License

MIT © [Yum-wu](https://github.com/Yum-wu)
