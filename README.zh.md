# dsh-plugin-codemode (中文文档)

[![npm version](https://img.shields.io/npm/v/dsh-plugin-codemode.svg)](https://www.npmjs.com/package/dsh-plugin-codemode)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: DeepSeek Harness](https://img.shields.io/badge/Platform-DeepSeek%20Harness-black.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Tests: Passing](https://img.shields.io/badge/Tests-7%2F7%20Pass-brightgreen.svg)]()
[![Engine: Dual (V8 VM + QuickJS)](https://img.shields.io/badge/Engine-Dual%20(V8%20VM%20%2B%20QuickJS)-orange.svg)]()

> [English](README.md) | **中文说明**

**面向 DeepSeek Harness (DSH) 的 Pi 风格 Code Mode（程序化工具编排）插件。**  
将传统单步 ReAct 的 O(N) 冗长往返，转换为单轮 O(1) 在隔离沙箱中执行的 JavaScript 编排脚本。

---

## ⚡ 实测数据对比（本仓 17 个真实文档实测）

测试样本为仓库 `docs/` 目录下全部 **17 个真实 Markdown 文档**（包含 131 KB 的大型运维台账 `known-issues.md`，原始总文本量 **215,011 字符**）。  
测试任务：多文件并发扫描，提取包含“JEV/Polymarket/架构/规则”关键因子的目标，在沙箱内完成行数统计、首段标题提取与降序排序，输出 Top 5 摘要。

| 评测维度 | 传统单步 ReAct 交互 | Code Mode (沙箱程序化编排) | 实测优化幅度 |
|---|---|---|---|
| **流入主上下文数据量** | 215,011 字符 | **676 字符** | **体积压缩 99.7%** (提炼比 318:1) |
| **估算消耗 Input Tokens** | ~67,191 tokens | **~211 tokens** | **Token 节省 99.7%** (减负 6.7 万 tokens) |
| **交互往返轮次 (Turns)** | 19 轮往返 | **1 轮完成** | **轮次减少 94.7%** (消除 18 轮往返) |
| **本地纯 I/O 及计算耗时** | 3.94 ms | **2.76 ms** | 基本持平（毫秒级极速） |
| **端到端总完成耗时** | ~47.5 秒 (按单轮推理 2.5s 计) | **~2.5 秒** | **提速 19 倍 (耗时缩短 94.7%)** |
| **中间计算与排序准确性** | 大上下文手算易遗漏幻觉 | JS 原生 Array 过滤排序 | **100% 确定性严格准确** |

> *本地复现命令：`node tests/benchmark-codemode-vs-react.mjs`*

---

## 💡 为什么需要 Code Mode？

传统大模型 Agent 在工具调用中存在三大痛点：
1. **上下文爆炸**：批量读取 20 个文件，产生 20 万 Token 原始脏数据塞满 Context，极易引发模型注意力漂移或强制压缩。
2. **高交互延迟**：每一个细碎的工具调用都必须等待一次网络传输和完整的模型推理往返。
3. **计算失真**：让模型在长序列 Prompt 中数行数、比大小或做排序，经常出现数数幻觉与逻辑疏漏。

### Code Mode 的核心设计哲学与官方背景
> *“确定性逻辑归代码，不确定性思考归大模型。”（Put deterministic things in code, non-deterministic in LLM — Hacker News 社区共识）*

深度对标 **Pi 1.0 (Earendil)** 官方 Code Mode 架构及 Cloudflare 生产实践：
- **[Pi.dev 1.0 官方 Codemode 文档](https://pi.dev/docs/latest/codemode)**：确立了基于内存沙箱与延迟暴露的程序化工具编排（Programmatic Tool Calling）标准。
- **[Cloudflare / CamelAI 生产案例](https://x.com/Vercantez/article/2082138839888589200)**：将 Agent 从沉重的 VM 容器迁移至 Pi Code Mode + Durable Objects，实现成本数量级下降与超低交互延迟。
- **Hacker News 核心研讨 ([#49019301](https://news.ycombinator.com/item?id=49019301))**：实测在多工具/多文件工作流中，沙箱化代码编排相较于传统 ReAct 对话往返最高可实现 **99.2% 的成本缩减**。

通过 Code Mode，模型只需要编写一段简短的 JavaScript 异步函数。脚本在受控沙箱内并行调用各类宿主和 MCP 工具，直接在内存完成过滤、清洗和排序，**仅将最终提炼的结构化数据返回会话历史**。

---

## 🏗 架构拓扑

```text
┌──────────────────────────────────────────────────────────┐
│                   DeepSeek Harness (DSH)                 │
│                                                          │
│  ┌──────────────────────┐      ┌──────────────────────┐  │
│  │ LLM 会话主上下文     │      │   ctx.tools / MCP    │  │
│  │ (Main Context)       │      │  (read, pwsh, mcp..) │  │
│  └──────────┬───────────┘      └──────────▲───────────┘  │
│             │ script                       │             │
│             ▼                              │ invoke      │
│  ┌─────────────────────────────────────────┴──────────┐  │
│  │ dsh-plugin-codemode (Cordis 动态插件)               │  │
│  │                                                    │  │
│  │  ┌──────────────────────────────────────────────┐  │  │
│  │  │ 双核隔离沙箱 (Dual-Engine Sandbox)           │  │  │
│  │  │                                              │  │  │
│  │  │  • V8 VM 引擎 (默认): 原生高速、无内存上限   │  │  │
│  │  │  • QuickJS-WASM: WebAssembly 纯内存隔离      │  │  │
│  │  │                                              │  │  │
│  │  │  - Proxy: 动态映射 tools.<tool_name>(args)   │  │  │
│  │  │  - 支持 Promise.all 真正并发                 │  │  │
│  │  │  - 60s 硬超时熔断机制                        │  │  │
│  │  │  - 拦截自我递归调用                          │  │  │
│  │  └──────────────────────────────────────────────┘  │  │
│  └──────────────────────────┬─────────────────────────┘  │
│                             │ 仅返回精炼结果             │
│                             ▼                            │
│  ┌────────────────────────────────────────────────────┐  │
│  │ 返回主上下文: [Logs] + [Return Value]              │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## ✨ 核心特性

- **🚀 双核沙箱支持**：
  - **V8 VM 引擎 (`engine: 'vm'`, 默认)**：与 DSH 官方工作流 PTC 架构对齐，0 额外内存开销，支持任意大文件吞吐与高并发。
  - **QuickJS WASM 引擎 (`engine: 'quickjs'`)**：轻量级 WebAssembly 纯内存沙箱，零 Node/OS 原生暴露。
- **🔄 全局透明工具代理与零开销自省**：
  - 原生映射 DSH 全部内置工具 (`read`, `edit`, `pwsh`, `glob`) 与 MCP 工具 (`mcp__github__*`, `mcp__cua*`, `mcp__tavily__*`)。
  - **零 Token 提示词底噪探查**：无需在对话上下文塞入上百个工具的臃肿 Schema：
    - `tools.list()`：秒级获取内存中已挂载的工具名称数组。
    - `tools.help('namePattern')`：在沙箱内存里按需自省参数定义与说明，节省 90% 以上系统提示词底噪。
- **🛡 坚固安全防护**：
  - 60 秒硬超时熔断机制，死循环自动销毁沙箱。
  - 递归调用拦截，禁止在脚本内套娃调用 `codemode` 自身。
  - 50,000 字符溢出保护，超长输出自动安全截断。
- **📦 零入侵可回滚**：不改动 DSH 任何系统核心文件，纯配置级外挂插件。

---

## 📖 典型脚本示例

### 1. 批量多文件并发扫描与提炼
```javascript
// 同时扫描 src 目录下所有文件并提取导出函数
const files = await tools.glob({ path: 'src', pattern: '**/*.ts' });
const results = await Promise.all(files.slice(0, 10).map(async (file) => {
  const code = await tools.read({ file_path: file });
  const exportedFns = code.match(/export (?:async )?function \w+/g) || [];
  return { file, count: exportedFns.length, functions: exportedFns };
}));

// 按导出数量降序排列，仅返回前 3 个
return results.sort((a, b) => b.count - a.count).slice(0, 3);
```

### 2. 零 Token 动态自省与按需 MCP 编排
```javascript
// 在沙箱内动态探测工具，无需向模型暴露 140+ 个繁复的 JSON Schema
const available = tools.list();
console.log(`当前活跃工具数: ${available.length}`);

// 仅在需要时按需查阅某个工具的入参文档
const prHelp = tools.help('github__list_pull_requests');
console.log(prHelp);

// 通过 GitHub MCP 拉取 PR 列表并在内存中提炼
const prs = await tools.mcp__github__list_pull_requests({
  owner: 'deepseek-ai',
  repo: 'deepseek-harness',
  state: 'open'
});

return prs.map(pr => ({
  number: pr.number,
  title: pr.title,
  user: pr.user?.login
}));
```

---

## 🚀 安装与启用

### 方式 A：通过 npm 安装（推荐）

进入你的 DSH profile 目录（如 `~/.dsh/profiles/web`）：
```bash
pnpm add dsh-plugin-codemode
# 或: npm install dsh-plugin-codemode
```

### 方式 B：源码本地开发安装
```bash
git clone https://github.com/Yum-wu/dsh-plugin-codemode.git
cd dsh-plugin-codemode
npm install
npm run build
```

在 DSH web profile 依赖中声明（`~/.dsh/profiles/web/package.json`）：
```json
{
  "dependencies": {
    "dsh-plugin-codemode": "link:C:/Users/Yum/Desktop/dsh-plugin-codemode"
  }
}
```

### 挂载到配置 (`cordis.patch.yml`)
编辑 `~/.dsh/profiles/web/cordis.patch.yml` 添加挂载项：
```yaml
- insert:
    - id: plugin-codemode
      name: 'dsh-plugin-codemode'
      config:
        toolName: 'codemode'
        engine: 'vm'             # 可选: 'vm' (默认) 或 'quickjs'
        maxResultChars: 50000
        timeoutMs: 60000
        injectGuidance: true
```

### 3. 重启 DSH
在桌面通过「服务管理台」点击重启服务即可。大模型将自动获得 `codemode` 工具及对应使用指引。

---

## ⚙️ 配置项参数

| 配置参数 | 数据类型 | 默认值 | 详细说明 |
|---|---|---|---|
| `toolName` | `string` | `'codemode'` | 注册并暴露给大模型的工具名称。 |
| `engine` | `'vm' \| 'quickjs'` | `'vm'` | 沙箱引擎选择：高速 V8 原生 VM 或 WASM 纯内存沙箱。 |
| `maxResultChars` | `number` | `50000` | 返回给模型主上下文的最大字符上限。 |
| `timeoutMs` | `number` | `60000` | 脚本单次执行的硬超时熔断时限（毫秒）。 |
| `injectGuidance` | `boolean` | `true` | 是否向模型系统提示词自动注入 Code Mode 编排指南。 |
| `autoReasoning` | `boolean` | `false` | 是否接管思考档位 (Auto Reasoning Effort)，**必须显式开启**，见下节。 |

---

## 🧠 自适应思考档位 (Auto Reasoning Effort)

把模型配置里的 `reasoningEffort` 写成哨兵值 **`auto`**，并在本插件配置里打开 **`autoReasoning: true`**，
插件会按当前任务的复杂度，在**该模型真实支持的档位阶梯**内投影出一个合法档位再发请求。

```yaml
# cordis.patch.yml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: opencodex
    model: google-antigravity/gemini-3.8-flash
    reasoningEffort: auto          # <- 哨兵
- id: plugin-codemode
  name: 'dsh-plugin-codemode'
  config:
    autoReasoning: true            # <- 不打开就完全不介入
```

两个条件缺一不可：只写 `auto` 而不开 `autoReasoning`，`auto` 会原样交给宿主并抛
`UNSUPPORTED_REASONING_EFFORT`；只开 `autoReasoning` 而档位不是 `auto`（用户手选过、
或会话 header 里已存着具体值），插件一律放行不碰。

| 要点 | 说明 |
|---|---|
| 生效位置 | 挂在 cordis 的 `agent/request` waterfall 上（`{global, prepend}`），返回值直接喂给 `llm.prepareCall`。 |
| 为什么不能挂 `llm/stream` | 那条流水线的 `options` 对 agent-loop 请求是 `deepFreeze` 的，且 cordis 的 `next(x)` 忽略实参，改不动。 |
| 档位来源 | `ctx.llm.resolveModelInfo(provider, model).reasoning.efforts`，即模型自己的阶梯，不硬编码。 |
| 评分口径 | 确定性关键词分级 1–10（`auto-reasoning.ts`）：并发/死锁/资金风控=9，推导/重构=7，常规开发=5，日常问答=2。 |
| 兜底 | 拿不到阶梯或 `resolveModelInfo` 抛错时，**省略** `reasoningEffort` 让模型用自己的默认档；绝不把 `auto` 交回宿主。 |
| 状态可见 | 只读路由 `GET /api/codemode.auto-effort`（走宿主共享 `/api` 通道，受同源鉴权保护），输入框底栏胶囊每 3s 轮询。 |

> ⚠️ `auto` **不是** DSH 的合法档位键（合法集合只有 `off/minimal/low/medium/high/xhigh/max`）。
> 单独在模型的 `reasoningEfforts` 里加 `auto: auto` 会让配置校验失败、整个 provider 插件不激活；
> 必须配合本插件才有意义。

---

## 🛟 三级零风险回滚策略

| 回滚级别 | 触发场景 | 操作步骤 | 恢复耗时 | 影响面 |
|---|---|---|---|---|
| **Level 1（秒级软禁用 - 推荐）** | 模型调用不稳定/预期外表现 | 在 `cordis.patch.yml` 该条目下设置 `disabled: true` 并重启 DSH。 | < 15 秒 | 立即注销 `codemode`，无缝恢复传统单步调用。 |
| **Level 2（运行时双轨降级）** | 脚本语法错或执行超时 | **全自动**：插件捕获报错并返回提示，模型自动实时降级至单步 ReAct。 | 0 秒 (实时) | 当前会话不中断，完全平滑过渡。 |
| **Level 3（物理彻底移除）** | 长期不再需要/清理环境 | 删除 `cordis.patch.yml` 与 `package.json` 中的配置条目及插件目录。 | < 15 秒 | 0 运行时痕迹，0 残留配置。 |

---

## 🧪 自动化测试验证

```bash
npm test
```
执行全量自动化单元测试：
- `Promise.all` 批量多工具并发执行验证。
- 递归调用自身拦截验证。
- 原生安全沙箱隔离性检验（绝无 Node 进程/文件等宿主权限泄露）。
- 输出长文本安全截断与格式化。
- 死循环超时强制中断。

---

## 📄 开源协议

MIT © [Yum-wu](https://github.com/Yum-wu)
