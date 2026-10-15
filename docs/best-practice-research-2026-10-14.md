# dsh-plugin-codemode 调研报告:最佳实践 / 官方文档 / 核心论文 / 社区经验 / 同类开源项目

- 日期:2026-10-14(修订版 2 —— **推翻了修订版 1 的 P0-1 修法建议**)
- 靶子:`dsh-plugin-codemode` v0.1.1(`C:/Users/Yum/Desktop/dsh-plugin-codemode`)
- 方法:三源检索(知乎全网 / exa+tavily / AnySearch)+ 一手源直取(官方文档、npm 包源码、arXiv、论文)+ **本机 PoC 实跑**
- 证据分级:**[官方]** = 一手官方文档/论文/源码原文;**[实测]** = 本机可复现的 PoC 输出;**[社区]** = 第三方博客/知乎/HN;**[未证实]** = 仅搜索片段、未取到原文

---

## 0. 结论先行

方向正确 —— Code Mode 已是 2025-2026 主流范式,Cloudflare 与 Anthropic 独立收敛到同一结论。但当前实现有 **3 个 P0,两个引擎各有一处致命伤**:

| 优先级 | 引擎 | 问题 | 一句话 |
|---|---|---|---|
| **P0-1** | `vm`(默认) | **不是安全边界** | 10 条逃逸向量实测 **7 条成功**,拿到宿主 `process`;Node 官方文档明令禁止 |
| **P0-2** | `vm`(默认) | **硬超时杀不死 `await` 死循环** | README 写 "kills infinite loops automatically",实测**挂死**,25s 看门狗都不触发 |
| **P0-3** | `quickjs` | **第 3 次跨沙箱工具调用即崩进程** | 实测:1 周期通过 / 2 周期通过 / **3 周期未捕获 WASM 崩溃** |

> ⚠ **修订版 1 的错误已纠正**:上一版建议「默认引擎改 quickjs」——**该建议是错的**。实测证明 quickjs 路径跑不了任何 3 步工具工作流。两个引擎都不能单独用,必须先修 P0-3 再谈切换默认值。这正是「产出结论的人不得同时充当验证者」的价值:换个测试形状,上一版的建议就站不住了。

---

## 0b. ✅ 修复结果(2026-10-14 同日完成并实测)

三个 P0 **全部修复**,每个都有护栏测试 + 功能回归双证据。

| ID | 修复内容 | 修复前证据 | 修复后证据 |
|---|---|---|---|
| **P0-1** | ① 宿主只留一个**只收发字符串**的通道;② sandbox 全局改 `Object.create(null)`;③ `console`/`text`/`tools` 全部在 context **内部**构造 | `test/escape.test.js` **3 pass / 8 fail** | **11 pass / 0 fail** |
| **P0-2** | 宿主通道每次调用**让出一个宏任务**并复查 deadline | await 紧循环**永久挂死**;15s 看门狗也不触发 | 紧循环 **811ms 终止**;同步死循环 812ms 报超时;正常脚本 16ms 不受影响 |
| **P0-3** | 把 `qvm.newAsyncifiedFunction(async …)` 换成 **手动 `newPromise` + pump loop** | `test/quickjs-tool-loop.test.js` **整个测试进程消失** | **6 pass / 0 fail** |

**全量套件**:修复前 `10 tests / 9 pass / 1 skip` → 修复后 **`37 tests / 37 pass / 0 fail / 0 skip`**(新增 27 例护栏)。

### 0b-2. 第二轮:把剩下的也修掉

| ID | 问题 | 修复前证据 | 修复后证据 |
|---|---|---|---|
| **P0-2 残留** | 纯 `await Promise.resolve()` 紧循环(**不调用任何工具**)饿死宏任务队列 —— 同进程内**没有任何**定时器能触发 | 20s 看门狗未返回,进程挂死 | 新增 `hardIsolation` 配置:沙箱跑进 **worker thread**,宿主用 `worker.terminate()` 硬杀。`test/worker-isolation.test.js` **10/10 通过**,三种死循环形状全部在看门狗内被杀 |
| **P1** | `maxResultChars` **只约束返回值那一段**,`[Logs]` 段完全不受限 —— `for(...) console.log(...)` 可轻松产出数百 KB,绕过 README 承诺的 50,000 字符上限 | 读 `truncator.ts` 源码确认 | 收口改为作用于**整段输出** |
| **P2** | `test/bundle-declaration.test.js` **在装了 DSH 的机器上也静默 skip** | 本机实测 `skipped: 1` | 根因:`start-dsh.ps1` 是 **UTF-16LE(`FF FE` BOM)**,测试按 utf8 读 → 全是 U+FFFD → 正则匹配不到 `$dshEntry`。改为 **BOM 感知读取**;并把「没装 DSH → skip」与「装了却派生不出 → **响亮失败**」分开。现在真跑宿主 `bundlePatchPaths`,**1/1 通过** |

⚠ **`hardIsolation` 插件缺省值仍为 `false`** —— 但 2026-10-15 已在**活的 DSH 进程内完成装配级实测**,原先「无法在活 DSH 里验证 worker 入口路径」的顾虑**已证伪**:正常脚本跑通、纯 `await` 紧循环 60.25s 被 `worker.terminate()` 硬杀且**会话未挂**。完整证据见 **§0b-3**。本机 web profile 已覆盖为 `true`;缺省值是否改成 `true` 仍留给你拍。

### 仍未修的(诚实列出)
- **`node:vm` 仍不是安全边界**:10 条已知向量被堵住 ≠ 无未知向量。Node 官方口径不变。
- **`hardIsolation` 插件缺省值仍为关闭**(本机 web profile 已显式覆盖为 `true`)。缺省取舍见上一条。
- **未量化 `hardIsolation` 的实际启动开销** —— 2026-10-15 结论:**在现有工具面下不可分离测量**,依据见 §0b-3-B。

**vm 功能回归 8/8 通过**(修复未破坏功能):返回值+工具调用 / `console.log` 捕获 / 并行工具调用 / `tools.list()` / `tools.help()` / 工具抛错被捕获 / 宿主内建(`Math`/`Date`/`Array.sort`/`Set`)仍可用 / 顶层 `await`。

### P0-3 根因(本轮实测锁定)
不是「3 个周期」这条规则本身,而是 **`newAsyncifiedFunction` 的 asyncify 机制在多次挂起之间破坏 QuickJS 引用计数**。对照实验:

```
asyncified  => 通过 0 / 崩溃 4     (Aborted: p->ref_count == 0, quickjs.c:5512)
manual      => 通过 4 / 崩溃 0     (newPromise + executePendingJobs 泵送)
```

⚠ **对 §2 P0-3 的表述更正**:原文写「≥3 次挂起/恢复周期即崩」——那是**相关性**不是机制。同配置重复跑 6 次得到 **6/6 全崩**,说明它是**确定性**崩溃,先前那次「proxy ×3 通过」是噪声。正确表述是:**asyncified 路径下顺序工具调用确定性崩溃**,与周期数的关系只是暴露概率的表象。

### 仍未修的(诚实列出)
- **`node:vm` 仍不是安全边界**:10 条已知向量被堵住 ≠ 无未知向量。Node 官方口径不变。
- **`hardIsolation` 插件缺省值仍为关闭**(本机 web profile 已显式覆盖为 `true`)。缺省取舍见 0b-2 的说明。
- **未量化 `hardIsolation` 的实际启动开销** —— 结论是**在现有工具面下不可分离测量**,依据见 §0b-3-B。

### 0b-3. 第三轮:活 DSH 装配级实测 + README 数字复核(2026-10-15)

**A. `hardIsolation: true` 在活的 DSH 进程内实测**

背景:worker 路径此前只在**仓内单测**里验过(`test/worker-isolation.test.js` 10/10),而单测覆盖的是沙箱函数、**不覆盖插件在 DSH 内的装配**(`new Worker(WORKER_ENTRY)` 的入口路径是否能在真实进程里解析到)。本轮在运行中的 DSH(运行时 `dsh-0.2.0-rc.2`,web profile)上补齐。

配置面:`~/.dsh/profiles/web/cordis.patch.yml` **L44** = `hardIsolation: true`(同块 L34 `timeoutMs: 60000`);`~/.dsh/logs/dsh-err-*.log` 无 `did not activate` / `disabling profile plugin row`;宿主进程确于 05:16:50 重启。

| # | 验证项 | 方法 | 结果 |
|---|---|---|---|
| ① | 正常路径(worker 内执行) | `1+1`、`[0..999]` 求和、`tools.list()` | `2` / `499500` / 360 工具 |
| ② | **危险路径(核心)** | 纯 `await` 紧循环 `while(true){ await Promise.resolve(); }` | **60.25s** 后被硬杀,返回 `Script execution exceeded hard timeout limit of 60000ms (worker terminated)`;**会话未挂** |
| ③ | 工具消息往返桥 | `tools.pwsh()` + `tools.read()` + `tools.glob()` 各一次 | 全通,586ms —— 走 `worker-entry.ts:52` 的 `executeTool` postMessage 往返,而非 `workerData` 同步快照 |
| ④ | **路径唯一性(排除同进程)** | grep `worker terminated` | 全文**仅 `worker-sandbox.ts:57`** 一处;同进程三处(`sandbox.ts:24/62/157`)**均无**此后缀 |

② 的 **60.25s** 与源码 `worker-sandbox.ts:53-60` 的 `setTimeout(…, timeoutMs + 250)` 精确吻合(60000 + 250);④ 证明 ② 走的确实是 worker 路径而非同进程路径 —— 两条独立证据同时成立。③ 是此前未覆盖的缺口:step ① 只用到 `workerData` 同步快照,往返桥坏掉时 `tools.*` 会全失效而 ① 照样通过。

**B. worker 启动开销:结论是「不可分离测量」**

原计划量化开启 `hardIsolation` 的每次调用代价,实测后判定**在现有工具面下做不到**,依据:

- **正常返回**时 harness 显示的耗时来自 **worker 内** runner 的 `wallTimeMs`(`worker-entry.ts:75` → `sandbox.ts`),**不含** spawn。实测:最小脚本 `return 1` 被报为 `0.00s`。
- **超时返回**时 `wallTimeMs` 取宿主侧 `Date.now() - startTime`(`worker-sandbox.ts:58`),但该路径由 `setTimeout(…, 60000 + 250)` 触发,读到的恒等于看门狗常量,**不含** spawn 信息。
- ⇒ 要测必须给 `worker-entry` 增加一条回传宿主 `startTime` 的字段(改代码),本轮未做。

**C. README benchmark 数字复核(§9-7 已闭)**

用 `DeepSeekHarness/tests/benchmark-codemode-vs-react.mjs` 在 DSH 仓根重跑:

| 指标 | 传统 ReAct | Code Mode | 提升 |
|---|---|---|---|
| 上下文数据量 | 414,346 字符 | 677 字符 | **99.8%**(612:1) |
| 估算 tokens | ~129,483 | ~212 | **99.8%** |
| 交互轮次 | 19 | 1 | −18 轮 |
| 端到端 | ~47.5 s | ~2.5 s | 19× (**建模值**) |

README 旧数字(215,011 字符 / 67,191 tokens / 99.7% / 318:1)是**同一语料的早期快照** —— `known-issues.md` 已从 131 KB 长到 **282,842 字符**。两处表述错误已修:① 「the repository's `docs/`」指的不是本插件仓,而是 **DeepSeekHarness 仓**(该仓 `docs/` 恰好 17 个 md,总 413,795 字符);② 复现命令缺仓名。两版 README(`README.md` / `README.zh.md`)已同步更新,并注明绝对值是**时点快照**、端到端耗时是**建模值**。

---

## 1. 现状基线 [实测]

### 1.1 仓内规模
| 项 | 值 |
|---|---|
| 版本 | `0.1.1`,`type: module`,`main: lib/index.js` |
| 源码 | `src/index.ts` 9991B、`src/sandbox.ts` 8218B、`src/tool-bridge.ts` 5502B、`src/types.ts` 3003B、`src/truncator.ts` 1514B |
| 测试 | 4 文件 10 例 |
| 关键依赖 | `quickjs-emscripten` **0.31.0** |
| 调研笔记 | **零**(本报告是仓内第一份) |
| remote | `https://github.com/Yum-wu/dsh-plugin-codemode.git` |

### 1.2 测试实跑(`npm test`)
```
ℹ tests 10   ℹ pass 9   ℹ fail 0   ℹ skipped 1   ℹ duration_ms 792.9
```
跳过的那 1 例是 `dsh.bundle.patch 声明被宿主正确解析` —— 报 **"未找到 DSH 运行时"**。即在纯仓内环境,**声明校验这条护栏是失效的**(CI 里会静默跳过,不会红)。

### 1.3 README 声称的能力
- 215,011 字符 → 676 字符(**99.7% 削减**)
- 19 轮 → 1 轮;~47.5s → ~2.5s(**19×**)
- L101:`Configurable hard timeout (default 60,000 ms) **kills infinite loops automatically**.`
- L264:`hard timeout on infinite loops` 列为已测能力
- L5:`executes the generated JavaScript in **secure, isolated sandboxes**`

三条声称里,**两条实测为假**(见 §2)。第三条(99.7% 削减)未复核。

---

## 2. 🔴 P0 级问题(全部实测坐实)

### P0-1:默认 `vm` 引擎不是安全边界

#### 官方原文 [官方]
> **"The `node:vm` module is not a security mechanism. Do not use it to run untrusted code."**
> — https://nodejs.org/api/vm.html

Simon Willison 的沙箱选型报告对 ShadowRealm / vm 类方案的评价(同一结论的独立来源)[社区]:
> *"Same V8 isolate, same process. **This is the weakest possible isolation level.** The sandbox boundary is enforced by JavaScript-level Proxy wrappers, **not by V8 engine separation**."*

#### 本插件代码路径 [实测]
`src/sandbox.ts`:
- **L72-99** `executeInVmSandbox` 把**宿主 realm 的** `Promise / JSON / Math / Date / Array / Object / String / Number / Boolean / RegExp / Map / Set / parseInt / parseFloat / isNaN / isFinite` 直接塞进 sandbox 对象
- **L101** `vm.createContext(sandbox)`
- **L103-106** `new vm.Script(wrapped, { filename: 'codemode:main', lineOffset: -1 })`
- **L108-110** `runInContext(context, { timeout: timeoutMs })`
- **L274-281** `executeCodeModeScript`:`if (options.engine === 'quickjs')` 走 QuickJS,**否则默认走 vm**
- `src/types.ts` L35 注释原文:`'vm' (V8 原生高速隔离沙箱，默认)`

#### PoC 结果 [实测]
10 条逃逸向量,**7 条 ESCAPED**,全部拿到同一个 `pid=32356`(宿主进程):

| 向量 | 结果 |
|---|---|
| `this.constructor.constructor` | **ESCAPED** |
| `Object.constructor` | **ESCAPED** |
| `JSON.constructor.constructor` | **ESCAPED** |
| `Promise.constructor.constructor` | **ESCAPED** |
| `JSON.parse('{}').constructor.constructor` | **ESCAPED** |
| **`(await tools.read({})).constructor.constructor`** | **ESCAPED** ← 数据通道 |
| `globalThis.constructor.constructor` | **ESCAPED** |
| `(function(){}).constructor` | THREW: process is not defined |
| `[].constructor.constructor` | THREW |
| `''.constructor.constructor` | THREW |

**规律(可推导,非猜测)**:凡**来自宿主 realm** 的对象(`this`、`Object`、`JSON`、`Promise`、以及**任何工具返回值**)都能逃;沙箱内**自建**的对象(`{}`、`[]`、`''`、函数字面量)不能。

第 6 条是本插件最危险的一条:`src/tool-bridge.ts` 的 `unwrapToolResult(res)` **把宿主对象直接交回沙箱**(`invokeToolInternal` 只用 `JSON.parse(JSON.stringify(args))` 深拷贝**入参**,返回值没做同等待遇)。⇒ **每一次工具调用都是一条逃逸通道**,模型不需要构造任何精巧 payload。

#### 逃逸后影响面 [实测]
```json
{"pid":32356,"argv0":"D:\\Node.js\\node.exe","envKeyCount":80,
 "canReadEnvValues":true,"hasKill":true,"hasExit":true,
 "hasBinding":"function","hasDlopen":"function","mainModule":"absent(ESM)"}
```
- **80 个环境变量可读**(含任何 `*_API_KEY`、`DSH_SECRET_*`)
- `process.kill` / `process.exit` / `process.binding` / `process.dlopen` **全部可用**
- `mainModule` 缺失仅因是 ESM,**不构成缓解**

#### 为什么这条是 P0
DSH 里 codemode 的定位是**执行模型生成的代码**。模型生成的代码 = **不可信代码**(受提示词注入影响)。按 Node 官方口径,当前默认配置下**不存在隔离**。

同类事件已有实证:
- [社区] **CSA research note「AI Coding Agent Sandbox Escapes: The Trust Handoff Flaw」** —— 原文:*"none of the disclosed issues broke the sandbox itself; each instead exploited a gap between what the sandbox restricts and what a trusted component **outside** the sandbox later reads, runs, or scans."* Pillar 研究员的概括:*the agent "**stays inside the box and follows every rule**," but writes a file — a hook configuration, a virtual environment interpreter, a Git config entry, a task definition — that some other, unsandboxed component later trusts.*
  - 该报告还点名:`Cursor` / `Codex CLI` / `Gemini CLI` / `Antigravity` 的 agentic / auto-run 模式需立即打补丁
  - 关联 CVE:`CVE-2026-50548` / `CVE-2026-50549`(Cursor,CVSS 3.1 **9.8**,Cato Networks 披露,合称 DuneSlide)
  - 核心判据:*"a sandbox is only as strong as the assumptions made by everything downstream of it"*
- [社区] **cymulate「Configuration-Based Sandbox Escape (CBSE) in AI Coding Tools」** —— 标题已定名:*"a recurring vulnerability class across multiple AI coding tools"*
- [社区] Semantic Kernel 两个 CVE(`CVE-2026-25592` / `CVE-2026-26030`,2026-05-07 微软公开):**提示词注入 → 主机级 RCE**,入口是 `eval()` 注入
- [社区] pillar.security「The Week of Sandbox Escapes」

⚠ **注意区分**:上述 CVE 讲的是「trust handoff」(沙箱没破,是下游信任了沙箱产出的文件);本插件的 `unwrapToolResult` 是**沙箱本身破了**。**本插件的问题更靠前、更基础** —— 它不需要下游配合。

---

### P0-2:vm 路径的硬超时杀不死 `await` 型死循环

#### README 声称
L101:`Configurable hard timeout (default 60,000 ms) **kills infinite loops automatically**.`

#### 实测:挂死 [实测]
PoC,`timeoutMs: 500`,vm 路径:
```js
let i = 0;
while (true) { i++; if (i % 1000 === 0) { try { await tools.read({ i }); } catch (e) { break; } } }
```
- job `pwsh-24`:**>180s 未返回**
- job `pwsh-26`:**>60s 未返回**
- 脚本内**自带的 15s 看门狗 `setTimeout` 也未触发**
- 复核(修正字段名后,`_tmp-C2_vm_await_loop.mjs`):**20s 看门狗未返回** ⇒ 稳定复现

#### 根因(读源码坐实)
`src/sandbox.ts` 有**两道**超时,两道都挡不住:
1. **L108-109** `runInContext(context, { timeout: timeoutMs })` —— vm 的 `timeout` **只约束同步执行**。脚本一旦进入 `await`,该守卫即失效。
2. **L112-117** `Promise.race([runPromise, new Promise((_, reject) => setTimeout(() => reject(...), timeoutMs))])` —— **`setTimeout` 是宏任务**。

`await tools.read(...)` 的 promise 立即 settle ⇒ **微任务队列永不清空** ⇒ 宏任务(setTimeout 回调)**永远排不上**。15s 看门狗同时哑掉,正是这个机制的直接证据。

#### 为什么现有测试没抓到 [实测]
`test/sandbox.test.js` L64-86 的超时用例:
```js
test('Sandbox - hard timeout handles infinite loops', async () => {
  const outcome = await executeInQuickJsSandbox({   // ← 注意:走的是 QuickJS 路径
    script: `async function sleep(ms){ return new Promise(()=>{}); } await sleep(1000); return 'unreachable';`,
    bridge: dummyBridge, timeoutMs: 500,
  });
```
三个错位:
1. 它测的是 **QuickJS** 路径,**不是默认的 vm 路径** —— 默认路径零覆盖
2. 它测的是**永不 resolve 的 promise**,不是**立即 resolve 的 await 循环**(后者才触发微任务饥饿)
3. 该用例**实测确实通过**(544ms,`Script execution exceeded hard timeout limit of 500ms`)⇒ 制造了「超时已覆盖」的假象

**测试通过 ≠ 能力成立**:用例形状与真实失败模式不重合。

---

### P0-3(新):QuickJS 路径第 3 次跨沙箱工具调用即崩进程

#### 实测矩阵 [实测]
PoC:`executeInQuickJsSandbox({ script, bridge, timeoutMs: 5000 })`,bridge 返回 `'ok'` / `{ok:true}` / `42`。

| 用例 | 挂起/恢复周期数 | 工具调用数 | 结果 |
|---|---|---|---|
| `tools.read()` ×1 | 1 | 1 | ✅ 通过 42ms |
| `tools.read()` ×2 | 2 | 2 | ✅ 通过 55ms |
| `Promise.all` ×3 | 1 | 3 | ✅ 通过 41ms |
| `Promise.all` ×5 | 1 | 5 | ✅ 通过 36ms |
| `seq + par×5` | 2 | 6 | ✅ 通过 52ms |
| **`tools.read()` ×3** | **3** | **3** | ❌ **进程崩溃** |
| **`seq + par×2`** | **3** | **4** | ❌ **进程崩溃** |
| **`seq + par×2 + seq`** | **3** | **4** | ❌ **进程崩溃** |
| `tools.read()` ×4 | 4 | 4 | ❌ 进程崩溃 |
| `tools.read()` ×5 | 5 | 5 | ❌ 进程崩溃 |
| **无工具的 100 次 `await Promise.resolve()`** | 0 | 0 | ✅ 通过 35ms |

**规律(6 个数据点精确吻合)**:**≥3 次跨 WASM 边界的 suspend/resume 周期 → 未捕获崩溃**。与**总调用数无关**(并行 5 次 = 1 周期,通过),与**返回值类型无关**(string/object/number 表现完全一致)。

#### 崩溃形态 [实测]
```
wasm://wasm/00415c3e:1

RuntimeError: memory access out of bounds
    at wasm://wasm/00415c3e:wasm-function[629]:0x6990b
    ...
Node.js v24.19.0
```
- 报错在 **WASM 层**,不是 JS 层
- **未被 `executeInQuickJsSandbox` 的 try/catch 捕获**(PoC 里显式包了 try/catch,输出里没有 `CAUGHT` 前缀)⇒ **宿主进程直接死**
- 首次触发时报的是另一种错:`RuntimeError: table index is out of bounds`
- 环境:`quickjs-emscripten` **0.31.0**,Node **v24.19.0**

#### 影响
**QuickJS 模式下,任何需要 3 步以上工具编排的脚本会直接杀死 DSH 进程。** 而 Code Mode 的**全部价值**就在多步编排(README 自己主打「19 轮 → 1 轮」)。⇒ **quickjs 路径在当前实现下不可用**,不是「慢一点」,是「用不了」。

#### 为什么现有测试没抓到 [实测]
`test/sandbox.test.js` 里 `dummyBridge.executeTool` **从来没有在沙箱内被 await 过** —— 4 个用例里它只作为占位符传入。`test/bridge.test.js` 的 `Promise.all parallel tool execution` 测的是 **tool-bridge 层**,不经过 quickjs 沙箱。
⇒ **「QuickJS 沙箱内顺序调用工具」这条路径零覆盖**,10 个绿测试掩盖了它。

---

## 3. 同类开源项目横向对比 [实测元数据]

| 项目 | ★ | license | 最后 push | 沙箱方案 | 工具发现方式 |
|---|---|---|---|---|---|
| **`dsh-plugin-codemode`**(本插件) | — | MIT | 2026-10-07 | `node:vm`(默认)/ QuickJS 0.31.0 | 全量类型注入 |
| **`@cloudflare/codemode`** v0.5.4(在 `cloudflare/agents` 仓 `packages/codemode`) | 5827(整仓) | MIT | 2026-10-14 | `DynamicWorkerExecutor`(Workers 动态 worker)/ `IframeSandboxExecutor`(浏览器) | **`codemode.search` + `codemode.describe`** |
| **`huggingface/smolagents`** | 29836 | Apache-2.0 | 2026-10-06 | 本地 Python 解释器(E2B/Docker 可选) | 工具签名全量注入 |
| **`xingyaoww/code-act`**(ICML 2024 官方仓) | — | — | — | Python 解释器 | 全量 |
| **`yousuf64/runbyte-mcp`** | 12 | **无 license** | 2026-03-09 | — | 声称 98.7% token 削减 |
| **`cloudflare/mcp`** | 949 | Apache-2.0 | 2026-10-13 | Cloudflare Dynamic Worker Loader | 派生 typed connector |

### 3.1 `@cloudflare/codemode` 架构(值得抄的参照物)[官方]

npm 包实测:`@cloudflare/codemode@0.5.4`,MIT,44 文件。**运行时依赖只有 2 个**(`acorn ^8.17.0` + `@types/json-schema`),peer 是 `@modelcontextprotocol/sdk` / `ai` / `@tanstack/ai` / `zod`。

**三层分离**(`docs/index.md` 原文表):
| 层 | 是什么 | 状态 |
|---|---|---|
| **Executor** | 一次性在隔离沙箱跑一段代码(`DynamicWorkerExecutor` / `IframeSandboxExecutor`) | **无状态,可替换** |
| **Connectors** | 把外部服务(MCP / OpenAPI / AI SDK / 自定义)桥进沙箱当全局变量的类 | 持有连接与凭证 |
| **Runtime** | `runtime.tool()` 给模型;`pending`/`approve`/`reject`/`rollback` 给应用 | **Durable,可跨休眠存活** |

**关键设计声明**(均为官方文档原文):
- **沙箱无网络访问**:*"The sandbox has **no network access**. Model code cannot `fetch`; every effect goes through a connector … or through `codemode.step`."*
- `globalOutbound: null // default — fully isolated`
- **四方法 SDK**:*"discover, learn, do-once, reuse"* = `search` / `describe` / `step` / `run`
- **`requiresApproval: true` 是审批的全部接口面**:*"Mark only what needs a human — everything else executes immediately and is still recorded in the durable log."*
- **approve 后靠 replay 续跑**:*"On approval the execution **continues via replay**"* —— 代码在审批点暂停,审批后**像什么都没发生一样继续**
- **`codemode.step` = 显式副作用边界**:*"the closure runs inside the sandbox, the result is recorded in the log, and on replay the closure is **skipped**"*
- **尺寸上限**:单条记录值 1 MB 序列化(`MAX_DURABLE_VALUE_BYTES`),**超限不是截断而是整跑失败** —— *"Truncating a logged value is never an option — replay would feed resumed code corrupted data"*;但**最终结果**超限不失败(因为 replay 不需要它)
- **日志不污染上下文**:*"the durable call log … is never part of the model's context"*
- **审计面**:`runtime.executions(limit?)` = *"the audit trail for developer UIs"*
- 另有 `DEFAULT_MAX_EXECUTIONS = 50`、`DEFAULT_PAUSED_TTL_MS`
- **浏览器面 CSP 默认**:`default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval';`

### 3.2 与本插件的对照(差在哪)
| 维度 | 本插件 | Cloudflare | 差评 |
|---|---|---|---|
| 隔离 | `node:vm`(官方声明不可用) | 独立 Worker / iframe | 🔴 **本质差距** |
| 工具发现 | 全量注入上下文 | `search`/`describe` 结果**进代码不进上下文** | 🟡 可借鉴 |
| 审批 | 无 | `requiresApproval` + durable replay | 🟡 可借鉴 |
| 副作用边界 | 无 | `codemode.step` + 日志 + rollback | 🟡 可借鉴 |
| 网络 | 靠不注入 fetch(逃逸后无意义) | 沙箱级 `globalOutbound: null` | 🔴 依赖 P0-1 |
| 截断 | `maxResultChars` 50000 **静默截断** | 超限**失败**并让模型改走文件引用 | 🟢 语义不同(见 §7) |

⚠ **不是所有差异都该抄**。Cloudflare 的 durable replay 是为「审批可能等几小时 + agent 会休眠」设计的,DSH 单机插件没有 Durable Object,照抄是过度工程。见 §7。

---

## 4. 官方事实汇总(一手源)

### 4.1 Cloudflare
- docs:https://developers.cloudflare.com/agents/tools/codemode/ —— 一个 code-execution tool;工具暴露为 **typed methods**;progressive discovery 走 `codemode.search()`/`codemode.describe()`;surfaces = Durable runtime(connectors/**approvals**/**replay**/**snippets**)、AI SDK、TanStack AI、**Browser(isolated iframe)**、MCP、OpenAPI
- blog:https://blog.cloudflare.com/code-mode/ (2025-09-26) —— 核心论断 *"LLMs are better at writing code to call MCP, than at calling MCP directly"*,理由是训练集里代码量远大于 tool call

### 4.2 Anthropic
https://www.anthropic.com/engineering/code-execution-with-mcp (2025-11-04):
- **150,000 → 2,000 tokens = 98.7% 节省**
- 做法:生成 `./servers/<server>/<tool>.ts` **文件树**,agent 靠**列目录 + 读文件按需加载**工具定义
- 原则:*"load tools on demand, filtering data before it reaches the model"*
- 文中明确提到与 Cloudflare 的同类发现(独立收敛)

### 4.3 Node.js
https://nodejs.org/api/vm.html —— 见 P0-1 原文。

### 4.4 Simon Willison 的沙箱选型研究 [社区·高可信]
来源:`https://simonwillison.net/2026/Mar/22/javascript-sandboxing-research/` → 正文在 `github.com/simonw/research/tree/main/javascript-sandboxing-research`
⚠ **该报告自述为 AI 生成**(原文:*"This is an AI-generated research report. All text and code in this report was created by an LLM"*),故标 **[社区·高可信]** 而非 [官方]。研究日期 2026-03-22。

**横向对比表(原文摘录)**:

| 方案 | CPU/超时 | 文件系统 | 网络 | 执行速度 | 安全记录 | 维护状态 |
|---|---|---|---|---|---|---|
| **isolated-vm** | ✅ timeout + **cpuTime 追踪** | ✅ 默认不暴露 | ✅ 默认不暴露 | V8 JIT 原生 | **Strong(V8 级边界)** | ⚠ **维护模式** |
| **vm2** | ⚠ 仅 timeout | ⚠ 尝试过(历史上被绕过) | ⚠ 同上 | V8 JIT 原生 | **Very poor(20+ CVE)** | ❌ **2023-07 弃用**,2025-10 复活但仍 fragile |
| **quickjs-emscripten / quickjs-ng** | ✅ **interrupt handler** | ✅ 无 syscall 接口 | ✅ 无 syscall 接口 | ⚠ **解释器,慢 10-50×** | **Strong(WASM 边界)** | ✅ Active |
| **ShadowRealm** | ❌ **无** | ⚠ 无 API 但**非安全保证** | ⚠ 同上 | V8 JIT 原生 | N/A(非安全工具) | Stage 2.7 提案 |
| **Deno 权限模型 / Node `--permission`** | ❌ 需外部实现 | ✅ **按路径细粒度** | ✅ **按域名细粒度** | V8 JIT 原生 | Good(Rust 运行时) | Active |

**该报告的落地建议(原文)**:
- **半可信代码**(如已知开发者的插件):用**内建纵深防御** ——
  `Worker thread` + `execArgv: ['--permission']` + `vm module` + `resourceLimits`
  *"No third-party dependencies needed. Good performance (V8 JIT compilation)."*
- **不可信代码**(用户提交的脚本):用 **`isolated-vm`**(性能最好,真 V8 isolate)或 **`quickjs-emscripten`**(隔离最强,WASM 边界),**并配 worker threads 做崩溃隔离**
- **最高安全**:进程级 / 容器级隔离

**Node Permission Model 可用开关**(原文表):`--permission`、`--allow-fs-read[=path]`、`--allow-fs-write[=path]`、`--allow-child-process`、`--allow-worker`、`--allow-addons`、`--allow-wasi`

> 📌 **对本插件的直接意义**:
> 1. 「**半可信代码**」那一档的建议 —— `Worker thread + --permission + vm + resourceLimits` —— 正好是本插件的位置:模型生成的代码,不是恶意用户脚本,但**必须假定会被提示词注入**。且**零第三方依赖**,改动量最小。
> 2. `quickjs-emscripten` 被判为「隔离最强」,**本插件已经在用它** —— P0-3 是**集成 bug,不是选型错误**。
> 3. 「**Combine with worker threads for crash isolation**」这句直接命中 P0-3:把沙箱放进 worker thread,崩的是 worker 不是主进程。

---

## 5. 核心论文

### 5.1 CodeAct(ICML 2024)—— 本范式的学术源头
- 论文:arXiv **2402.01030**,DOI `10.5555/3692070.3694124`,官方仓 `xingyaoww/code-act`
- 标题:*Executable Code Actions Elicit Better LLM Agents*

**摘要原文(2026-10-14 直取 arXiv 页面)** [官方]:
> *"This work proposes to use executable Python code to consolidate LLM agents' actions into a unified action space (CodeAct). Integrated with a Python interpreter, CodeAct can execute code actions and dynamically revise prior actions or emit new actions upon new observations through multi-turn interactions. Our extensive analysis of **17 LLMs** on **API-Bank** and a newly curated benchmark shows that CodeAct outperforms widely used alternatives (**up to 20% higher success rate**)."*

⚠ **数字更正**:摘要只写了 **"up to 20% higher success rate"**。
- 「**30% fewer steps**」**不在摘要里** —— 那是 Medium 二手解读的说法(https://medium.com/@mingyang.heaven/codeact-when-llms-execute-code-instead-of-text),**未从论文正文核实**。修订版 1 把它并列为论文结论是**不严谨的**,已降级。
- 若要引用到 README,请只引摘要那句,并注明 "up to"。

### 5.2 安全侧
- **CSA research note「AI Coding Agent Sandbox Escapes: The Trust Handoff Flaw」**(2026-07-22)—— 已取到正文关键段(见 P0-1),标 **[社区]**
- cymulate「Configuration-Based Sandbox Escape (CBSE) in AI Coding Tools」—— 页面为 WordPress 重导航,**正文未取到**,标 **[未证实]**
- pillar.security「The Week of Sandbox Escapes」—— **未取到正文**,标 **[未证实]**

---

## 6. 社区经验与争议

### 6.1 中文社区(知乎,authority 全为 4)
| 标题 | 链接 | 要点 |
|---|---|---|
| Function Calling 该退休了,新神的名字叫 Code Mode | zhuanlan.zhihu.com/p/2086052135326717147 | *"Tool Discovery + Code Execution 会越来越重要"*;MCP 解决「怎么接进来」,Code Mode 解决「接进来后怎么高效组合」,**两者互补不替代** |
| Code Mode - 一个更好的 MCP | zhuanlan.zhihu.com/p/2008509465314494254 | 传统路径每次调用花**两个 roundtrip**(MCP 调用 + LLM 推理),且消息来回占用大量 context |
| 从函数调度到代码生成:MCP 工具调用模式的范式转移 | zhuanlan.zhihu.com/p/1985463248074585716 | 给出 `asyncio.gather` 并行取数的代码样例 |
| 智体 Harness 工程:综述(上) | zhuanlan.zhihu.com/p/2041527501567027027 | 2024-2026 沙箱基础设施演化成**七大类**,按「工作负载 × 应用场景」划分 |
| Agent 能力评测的难点与坑 | zhuanlan.zhihu.com/p/2077824471705114203 | **安全边界评测是三者中最不成熟的一环** —— 「判断 agent 是否逃出沙箱」连共识框架都没有 |
| When prompts become shells: Semantic Kernel 两个 CVE | zhuanlan.zhihu.com/p/2071953199989265493 | 提示词注入 → 主机级 RCE,入口 `eval()` |
| 从沙箱逃逸到 AI「蠕虫」,OpenAI 上线新站披露多起智能体失控事件 | ithome.com/1/008/079.htm | OpenAI 对齐失效报告站,9 起事件 |

### 6.2 争议
- **Simon Willison 的批评**(经搜索片段,标 [社区]):Anthropic 那篇**只给方案不给可执行代码**。
- **反方声音**:知乎问题「Claude 才发 Skill,现又发新技术…」下的高赞答认为 *"大家都在卷工具调用能力…本质上都是在用自然语言当编程语言"*,而自然语言冗余度极高 —— 这**支持** Code Mode 方向。
- **本插件独有的反证**:`codemode` 沙箱内 **`setTimeout` 未定义**(本轮实测 `Script failed: setTimeout is not defined`,vm 与 quickjs 皆然)。模型写的任何计时/轮询逻辑直接崩。这不是 bug,但**必须在工具描述里显式告知模型**。

---

## 7. 可落地改进项(按优先级)

> ✅ **本节 P0-1 / P0-2 / P0-3 三条已于 2026-10-14 同日修复完成** —— 实际采用的方案是
> **就地加固现有两个引擎**,而不是本节原先设想的「换引擎 / 加 worker」。修复内容与证据见 **§0b**。
> 下面保留原始分析,供理解取舍;未采纳的路径(worker thread 兜底、`isolated-vm`、
> `--permission`)**仍是有价值的下一步**,尤其用于兜住 §0b 列出的 P0-2 残留。

> ⚠ 修订版 1 把「默认引擎改 quickjs」列为 P0-1a。**该建议已作废** —— quickjs 路径跑不了 3 步工具编排(P0-3)。下面是修正后的方案。

### P0-1:让默认路径获得真隔离

**推荐路径 A(改动最小,零新依赖)** —— 采纳 Simon Willison 的「半可信代码」档:
```
Worker thread  +  execArgv: ['--permission']  +  vm  +  resourceLimits
```
- `--permission` 默认阻断**所有**能力,再按需开 `--allow-fs-read` 等
- `resourceLimits` 给内存/CPU 上限
- **worker thread 同时解决 P0-2 与 P0-3 的进程存活问题**(崩的是 worker,不是 DSH 主进程)
- 零第三方依赖 —— 全在 Node 内建能力里

**推荐路径 B(隔离最强)** —— `isolated-vm`:
- V8 级边界,有 **`timeout` + `cpuTime` 追踪**(直接治 P0-2)
- ⚠ 但**处于维护模式**,且是 native addon(要编译,Windows 上装包风险)
- 若采纳,必须**同时放进 worker thread**

**路径 C(继续用 quickjs,但修集成)**:见 P0-3。

**无论走哪条,必做的三件事**:
1. **`unwrapToolResult` 返回值做结构化克隆后再入沙箱** —— 掐断 P0-1 里最实用的那条通道
2. **不要往 sandbox 塞宿主 realm 的内建对象**(`src/sandbox.ts` L72-99)。当前塞了 `Object`/`JSON`/`Promise` 等,**每一个都是一条逃逸路径**
3. **把 10 条逃逸向量固化成 `test/escape.test.js`**,断言「全部 THREW」。这条护栏比任何文档都值钱 —— 它能防止未来某次「顺手把 `JSON` 塞进去」把洞重新打开

### P0-2:修 vm 路径超时
1. `Promise.race` 的 `setTimeout` **结构性失效**(微任务饥饿),必须换掉 —— 走 `isolated-vm` 的 `cpuTime`、或 Node `worker.terminate()`、或进程级 kill
2. **补 `await` 型死循环的护栏测试**,用例形状必须与真实失败模式重合(本轮 PoC 脚本可直接改用例)
3. 把现有那条「hard timeout」用例**改到默认引擎上跑**,并**新增** await 循环形状 —— 当前它测的是 quickjs + 永不 resolve 的 promise,**与默认路径和真实失败模式都不重合**

### P0-3:修 QuickJS 崩溃
1. **先复现再修**:`test/quickjs-tool-loop.test.js`,断言「顺序 3 次 `await tools.x()` 不崩且返回正确」
2. 怀疑方向:**跨 WASM 边界的 handle 未 dispose** —— 每次 suspend/resume 泄漏,第 3 次爆表。查 `src/sandbox.ts` 里 `newPromise`/`newFunction`/`quickjsHandle` 的 `dispose()` 配对
3. **兜底方案**:把 quickjs 跑在 **worker thread** 里 —— 即使仍崩,死的是 worker 不是 DSH 主进程(这也是 Simon Willison 报告里 "Combine with worker threads for crash isolation" 那句的用法)
4. ⚠ 修好前,**不要把 `engine` 默认值改成 `quickjs`**

### P0-4:README 表述
- L101 `kills infinite loops automatically` —— 修好前**必须改**
- L5 `secure, isolated sandboxes` —— 同上
- 当前是**声称了实测为假的能力**,比没有声明更糟 —— 用户会据此放心跑不可信代码

### P1(值得借鉴,但不是照抄)

| 项 | 来源 | 建议 |
|---|---|---|
| **progressive discovery** | Cloudflare `search`/`describe` + Anthropic 文件树 | 两条路线**独立收敛到同一结论**:工具定义不该全量进上下文。本插件目前全量注入。⚠ DSH 核心工具 37 项,远小于 GitHub MCP + Stripe,**收益可能不显著**,建议先量当前注入占比再决定 |
| **截断语义:失败 vs 静默** | Cloudflare | Cloudflare 因 replay 必须失败;**本插件没有 replay,静默截断是合理的**。但可加「已截断」标记让模型知道结果不完整 —— `truncator.ts`(1514B)是否带标记**未查** |
| **`requiresApproval`** | Cloudflare | DSH 已有自己的审批机制(`ask_user` 卡片),**不需要重造**。但「哪些工具该标为需审批」这个**分类**可以抄 |
| **沙箱无网络** | Cloudflare `globalOutbound: null` | 本插件靠「不注入 fetch」实现,在 P0-1 修好前**无意义**(逃逸后直接拿 `process`) |
| **snippet 复用** | Cloudflare `runtime.saveSnippet` / `codemode.run` | 单机插件场景价值有限,**YAGNI,暂不做** |
| **把 `setTimeout` 缺失写进工具描述** | 本轮实测 | 模型会在沙箱里写计时/轮询逻辑然后撞墙,应在 guidance 里明说 |

### P2(工程卫生)
- `dsh.bundle.patch` 测试在无 DSH 运行时环境**静默跳过** → CI 里这条护栏形同虚设,建议改成「找不到运行时则 fail 并提示」
- 仓内**零 `docs/`** → 本报告是第 1 份

---

## 8. 证据等级表

| 结论 | 等级 | 依据 |
|---|---|---|
| `node:vm` 不是安全机制 | **[官方]** | Node.js 官方文档原文 |
| ShadowRealm/vm 类 = 最弱隔离级别 | **[社区·高可信]** | Simon Willison 报告原文(AI 生成,自述) |
| 本插件默认走 vm | **[实测]** | `src/sandbox.ts` L274-281、`src/types.ts` L35 |
| 7/10 逃逸向量成功,拿到宿主 process | **[实测]** | PoC,pid=32356 |
| 工具返回值是逃逸通道 | **[实测]** | 第 6 向量 + `tool-bridge.ts` `unwrapToolResult` |
| 80 个 env 可读、`kill`/`dlopen` 可用 | **[实测]** | PoC 影响面 JSON |
| QuickJS 挡住逃逸 | **[实测]** | `hasProcessGlobal: false` |
| **vm 路径 await 死循环挂死,超时失效** | **[实测]** | job `pwsh-24`/`pwsh-26` + `_tmp-C2` 20s 看门狗未返回 |
| 根因 = 微任务饥饿使宏任务无法调度 | **[实测+源码]** | `sandbox.ts` L108-109(同步限定)+ L112-117(setTimeout 宏任务) |
| **QuickJS 路径 ≥3 次挂起/恢复即崩进程** | **[实测]** | 10 个数据点矩阵,规律精确吻合 |
| 崩溃未被 try/catch 捕获 | **[实测]** | PoC 显式 try/catch,输出无 `CAUGHT` 前缀 |
| 崩溃与返回值类型无关 | **[实测]** | string/object/number 三组表现一致 |
| 并行调用不触发(1 周期) | **[实测]** | `Promise.all` ×3 / ×5 均通过 |
| 现有超时测试走的是 quickjs 路径 | **[实测]** | `test/sandbox.test.js` L3 import + L70 调用 |
| 现有测试从未在沙箱内 await 工具 | **[实测]** | `test/sandbox.test.js` 全文 86 行 |
| `npm test` 9 pass / 1 skip | **[实测]** | 实跑输出 |
| quickjs-emscripten 0.31.0 / Node v24.19.0 | **[实测]** | `package.json` / 崩溃 banner |
| Cloudflare 三层架构 / 无网络 / replay | **[官方]** | 包内 `docs/*.md` 原文 |
| Cloudflare 包依赖只有 2 个 | **[实测]** | `package.json` |
| 各仓 star/license/pushed | **[实测]** | `gh api` |
| Anthropic 98.7% 节省 | **[官方]** | Anthropic engineering 博文 |
| CodeAct「up to 20% higher success rate」 | **[官方]** | arXiv 2402.01030 摘要原文 |
| CodeAct「30% fewer steps」 | **[社区]** | Medium 二手,**摘要里没有** |
| Simon Willison 沙箱对比表与建议 | **[社区·高可信]** | 原文自述 AI 生成 |
| CSA trust handoff 段落 | **[社区]** | 已取到正文关键段 |
| CBSE / pillar 两篇正文 | **[未证实]** | 未取到正文 |
| `truncator.ts` 是否带「已截断」标记 | **[未证实]** | 未查 |

---

## 9. 未做 / 待补

1. **未定位 P0-3 的确切根因**(handle 泄漏 vs WASM 表溢出)—— 只锁定了触发条件(≥3 周期),未读 quickjs-emscripten 内部
2. 未验证 **worker thread 包裹**是否能兜住 P0-3(理论上能,未实测)
3. 未读 CodeAct 论文**正文**(只取到摘要)
4. 未取到 cymulate CBSE 与 pillar 两篇**正文**
5. 未量化「工具定义全量注入」在 DSH 37 项核心工具下的实际 token 占比 —— 这决定 progressive discovery 值不值得抄
6. ~~`truncator.ts` 静默截断是否带「已截断」标记,未查~~ → **已查(2026-10-15)**:带标记,`truncator.ts:39/53` 输出 `… [truncated: ${omitted} more characters]`
7. ~~未复核 README 的 99.7% / 19× 数字~~ → **已复核并更新(2026-10-15)**,见 §0b-3-C
8. **未量化 `hardIsolation` 的 worker 启动开销** —— 见 §0b-3-B,现有工具面下**不可分离测量**

---

## 附:本轮 PoC 与临时文件

全部为 `_tmp-` 前缀,跑完即删(已按显式路径白名单清理)。

| 文件 | 用途 |
|---|---|
| `_tmp-vm-escape-poc{,2,3}.mjs` | vm 逃逸向量 + 影响面 |
| `_tmp-timeout-poc.mjs` | vm await 死循环超时 |
| `_tmp-{A,B,C,C2,D,E,F,G,H}_*.mjs` | 两引擎超时/崩溃矩阵 |
| `_tmp-mx.mjs` / `_tmp-px.mjs` | 返回值类型 × 周期数矩阵 |

PoC 全程**只读探测**:不打印 env 值(只打印键名计数)、不写文件、不起子进程。
