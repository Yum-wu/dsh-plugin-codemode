# dsh-plugin-codemode

[![npm version](https://img.shields.io/npm/v/dsh-plugin-codemode.svg)](https://www.npmjs.com/package/dsh-plugin-codemode)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: DeepSeek Harness](https://img.shields.io/badge/Platform-DeepSeek%20Harness-black.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Tests: Passing](https://img.shields.io/badge/Tests-7%2F7%20Pass-brightgreen.svg)]()
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
> *"Put deterministic things in code, non-deterministic in LLM."*

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
- **🔄 Universal Tool Proxy**: Access all DSH built-in tools (`read`, `edit`, `pwsh`, `glob`) and MCP tools (`mcp__github__*`, `mcp__tavily__*`) via `tools.<tool_name>(args)`.
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

### 2. Multi-MCP Composition
```javascript
// Fetch latest issues via GitHub MCP and summarize with web search
const issues = await tools.mcp__github__list_issues({ owner: 'foo', repo: 'bar' });
console.log(`Fetched ${issues.length} issues`);

const topIssues = issues.slice(0, 3).map(i => ({
  number: i.number,
  title: i.title,
  author: i.user?.login
}));

return topIssues;
```

---

## 🚀 Installation & Setup

### Option A: Install from npm (Recommended)

In your DSH profile directory (e.g. `~/.dsh/profiles/web`):
```bash
pnpm add dsh-plugin-codemode
# or: npm install dsh-plugin-codemode
```

### Option B: Install from Source (Development)
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

### Enable in Profile Patch (`cordis.patch.yml`)
Add to `~/.dsh/profiles/web/cordis.patch.yml`:
```yaml
- insert:
    - id: plugin-codemode
      name: 'dsh-plugin-codemode'
      config:
        toolName: 'codemode'
        engine: 'vm'             # 'vm' (default) or 'quickjs'
        maxResultChars: 50000
        timeoutMs: 60000
        injectGuidance: true
```

### 3. Restart DSH
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

---

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
Runs the test suite verifying:
- Parallel `Promise.all` multi-tool execution.
- Recursive invocation guards.
- Isolation boundaries (no Node process/require leaks).
- Output truncation and formatting.
- Infinite loop timeout aborts.

---

## 📄 License

MIT © [Yum-wu](https://github.com/Yum-wu)
