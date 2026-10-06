# dsh-plugin-codemode 项目规则 (AGENTS.md)

> 目标：为 DeepSeek Harness (DSH) 提供原汁原味的 Pi 风格 Code Mode (Programmatic Tool Calling) 插件。  
> 运行方式：Cordis 插件，基于 QuickJS-WASM 内存沙箱，零外部网络/OS权限，支持 JS 脚本编排与工具拦截。

---

## 一、架构规范与工程铁律

1. **零侵入原则（最高铁律）**：
   - 本插件是纯外挂式 Cordis 插件，严禁改动 DSH 宿主核心运行时 (`~/.dsh/runtime/`) 或修改全局补丁。
   - 所有配置均通过 `~/.dsh/profiles/web/cordis.patch.yml` 以插件形式插入。
2. **纯内存沙箱**：
   - 使用 `@jitl/quickjs-wasm` 或 `quickjs-emscripten`，纯 WASM 内存执行。
   - 沙箱内严禁引入 Node.js 原生 `fs`、`net`、`child_process` 等 OS 接口。
   - 与外部唯一的通信渠道是宿主注入的 `tools.<name>(args)` 异步桥梁。
3. **数据截断与上下文保护**：
   - 沙箱运行期间的中间调用结果绝不直接进入主模型上下文。
   - 仅显式 `return` 的结构化值及 `console.log` 的提炼摘要返回主上下文。
   - 默认截断上限 50,000 字符。
4. **硬超时熔断**：
   - 单次脚本默认执行硬超时 60,000ms（可配置），超时强制销毁沙箱上下文并报错返回，杜绝死循环挂死宿主。
5. **顶层工具白名单是「整体替换」而非「追加」**：`collapseTopLevelTools: true` 时，暴露给模型的工具集 = `new Set(config.allowedTopLevelTools || DEFAULT_CORE_TOOLS)`。
   未列出的工具**从顶层静默消失**（不报错、不告警，模型只是看不见）。实测 2026-10-05：本数组只有 11 项，而运行时注册的非 MCP 工具 36 个 ⇒ **吞掉 24 个**，连 `subagent` 都在里面。
   - **改这个数组时必须同步三处**：`src/index.ts` 的 `DEFAULT_CORE_TOOLS`、目标 profile 的 `allowedTopLevelTools`、以及 DeepSeekHarness `tests/12-tool-whitelist.test.mjs` 的期望集。
   - ⚠ 本仓 `lib/` 是 **gitignored 的构建产物** —— 改完 `src/` 必须 `npm run build`，否则 profile 的 junction 仍指向旧代码。

---

## 二、工作区与文件规则

- **模块系统**：统一使用 Node.js 原生 ESM (`"type": "module"`), 源码使用 TypeScript。
- **文件编码**：所有 `.ts`, `.js`, `.json`, `.md` 必须为 **UTF-8（无 BOM）**；如涉及 `.ps1` 脚本则严格按全局规则保留 UTF-8 BOM。
- **构建输出**：编译到 `lib/` 目录，输出包含 `.d.ts` 与 `.js`。
- **单元测试**：使用 Node.js 内置 test runner (`node:test`) 或轻量测试框架，实现 100% 离线单测（通过 Mock 工具测试并发、过滤、错误捕获与截断）。

---

## 三、目录结构约定

```text
dsh-plugin-codemode/
├── AGENTS.md           # 本规则文件（基线）
├── README.md           # 英文/多语言介绍与使用文档
├── README.zh.md        # 中文使用与配置说明
├── package.json        # 项目依赖与 Cordis/DSH 声明
├── tsconfig.json       # TypeScript 配置 (ES2023 / NodeNext)
├── src/
│   ├── index.ts        # 插件主入口：定义 tool、声明 prompt section、生命周期
│   ├── sandbox.ts      # QuickJS WASM 内存沙箱实例管理与异步执行器
│   ├── tool-bridge.ts  # tools.* 动态 Proxy 代理与 DSH ctx.tools 执行桥接
│   ├── truncator.ts    # 输出收集、日志格式化与安全截断
│   └── types.ts        # 接口与配置 Schema 定义
└── test/                       # 共 10 例：`node --test test/*.test.js`
    ├── sandbox.test.js          # 4 例：基础求值 / console.log 捕获 / 隔离性(无 Node API 泄露) / 硬超时断开死循环
    ├── bridge.test.js           # 3 例：Promise.all 并发 / 拒绝自递归调用 / 超长输出截断
    ├── apply-guard.test.js      # 2 例：apply() 禁用 ctx.waterfall / auto 迁走后不再依赖 llm+connection
    └── bundle-declaration.test.js # 1 例：dsh.bundle.patch 声明被宿主正确解析(无运行时时 skip)
```

---

## 四、安全与回滚三阶梯

- **Level 1**：在 `cordis.patch.yml` 中设置 `disabled: true` 或注释插件声明，重启生效。
- **Level 2**：脚本抛错或超时，插件返回标准结构化 `isError`，模型自动 Fallback 至常规单步 ReAct。
- **Level 3**：物理删除 profile 中的依赖与软链，0 遗留。
