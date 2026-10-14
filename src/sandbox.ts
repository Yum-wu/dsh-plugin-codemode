import vm from 'node:vm';
import { newAsyncContext, type QuickJSAsyncContext, type QuickJSHandle } from 'quickjs-emscripten';
import type { ScriptExecutionOptions, ScriptExecutionOutcome } from './types.js';
import { executeInWorkerSandbox } from './worker-sandbox.js';

/**
 * 驱动 QuickJS 微任务队列并等待异步执行完成或超时
 */
async function waitForPromise(
  qvm: QuickJSAsyncContext,
  promiseHandle: QuickJSHandle,
  timeoutMs: number
): Promise<{ success: boolean; handle: QuickJSHandle }> {
  const start = Date.now();
  while (true) {
    const state = qvm.getPromiseState(promiseHandle);
    if (state.type === 'fulfilled') {
      return { success: true, handle: state.value };
    }
    if (state.type === 'rejected') {
      return { success: false, handle: state.error };
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Script execution exceeded hard timeout limit of ${timeoutMs}ms`);
    }

    if (qvm.runtime.hasPendingJob()) {
      const res = await qvm.runtime.executePendingJobs();
      if (res.error) {
        throw new Error('QuickJS runtime pending job error: ' + qvm.dump(res.error));
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

/**
 * 在 V8 原生 VM 隔离上下文中执行脚本 (极速并发、高吞吐、对齐 DSH PTC 工作流架构)
 */
export async function executeInVmSandbox(
  options: ScriptExecutionOptions
): Promise<ScriptExecutionOutcome> {
  const startTime = Date.now();
  const logs: string[] = [];
  const timeoutMs = options.timeoutMs ?? 60000;

  try {
    // ⚠ P0-1 修复(2026-10-14):这里曾把宿主 realm 的 Promise/JSON/Object/... 直接
    // 注入 sandbox。凡进入 context 的宿主对象,都能顺着 `.constructor.constructor`
    // 取回宿主 Function 构造器,进而拿到宿主 process(实测 7/10 向量逃逸成功)。
    // 现在宿主只留一个**只收发字符串**的通道,且由 context 内脚本捕获后立即从
    // globalThis 删除 —— 用户代码无法反射到闭包里的它。
    // ⚠ P0-2 修复(2026-10-14):沙箱里的 `await` 紧循环会占满微任务队列,
    // 使 setTimeout 永远排不上 —— Promise.race 的硬超时因此完全失效(实测挂死)。
    // 在宿主通道里显式让出一个宏任务,并做截止时间检查,超时后由通道抛出,
    // 沙箱侧的 await 随之失败,脚本终止。
    const deadline = startTime + timeoutMs;
    const hostCall = async (kind: string, a: string, b: string): Promise<string> => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (Date.now() > deadline) {
        throw new Error(`Script execution exceeded hard timeout limit of ${timeoutMs}ms`);
      }
      try {
        if (kind === 'tool') {
          let args: Record<string, unknown> = {};
          try {
            args = b ? JSON.parse(b) : {};
          } catch (e: any) {
            return JSON.stringify({ ok: false, error: `Invalid JSON arguments: ${e?.message || e}` });
          }
          const result = await options.bridge.executeTool(a, args);
          return JSON.stringify({ ok: true, data: result === undefined ? null : result });
        }
        if (kind === 'list') {
          return JSON.stringify({ ok: true, data: options.bridge.listAvailableTools?.() || [] });
        }
        if (kind === 'help') {
          return JSON.stringify({
            ok: true,
            data: (options.bridge as any).getToolHelp?.(a || undefined) || [],
          });
        }
        return JSON.stringify({ ok: false, error: `Unknown host channel: ${kind}` });
      } catch (err: any) {
        return JSON.stringify({ ok: false, error: err?.message || String(err) });
      }
    };

    // ⚠ 必须用无原型对象:普通字面量对象的原型是**宿主** Object.prototype,
    // 于是 context 里的 `globalThis.constructor` 会顺着原型链取到宿主 Object,
    // 再 `.constructor` 就是宿主 Function —— 逃逸。Object.create(null) 掐断这条链。
    const sandbox = Object.create(null) as Record<string, unknown>;
    sandbox.__cm_host_call = hostCall;
    const context = vm.createContext(sandbox);
    // console / text / tools 全部在 context **内部**构造 —— 宿主不递任何对象进来。
    // 工具返回值由 context 自己的 JSON.parse 解析,因此沙箱侧拿到的是 context realm 对象。
    const initScript = new vm.Script(
      `(() => {
        const hostCall = globalThis.__cm_host_call;
        delete globalThis.__cm_host_call;

        const logs = [];
        const stringify = (v) => (v !== null && typeof v === 'object') ? JSON.stringify(v) : String(v);
        const sink = (...args) => { logs.push(args.map(stringify).join(' ')); };

        Object.defineProperty(globalThis, '__cm_logs', { value: logs, configurable: true });
        Object.defineProperty(globalThis, 'console', {
          value: { log: sink, info: sink, warn: sink, error: sink },
          configurable: true,
          writable: true,
        });
        Object.defineProperty(globalThis, 'text', {
          value: (v) => { logs.push(stringify(v)); },
          configurable: true,
          writable: true,
        });

        globalThis.tools = new Proxy({}, {
          get(_, prop) {
            const toolName = String(prop);
            if (toolName === 'list') {
              return async () => JSON.parse(await hostCall('list', '', '')).data;
            }
            if (toolName === 'help') {
              return async (pattern) => JSON.parse(await hostCall('help', pattern || '', '')).data;
            }
            return async function(args = {}) {
              const raw = await hostCall('tool', toolName, JSON.stringify(args));
              const parsed = JSON.parse(raw);
              if (!parsed.ok) {
                throw new Error('Tool ' + toolName + ' failed: ' + parsed.error);
              }
              return parsed.data;
            };
          }
        });
      })();`,
      { filename: 'codemode:init' }
    );
    initScript.runInContext(context, { timeout: 1000 });

    const wrapped = `(async () => {\n${options.script}\n})()`;
    const scriptObj = new vm.Script(wrapped, {
      filename: 'codemode:main',
      lineOffset: -1,
    });

    const runPromise = scriptObj.runInContext(context, {
      timeout: timeoutMs,
    });

    const returnValue = await Promise.race([
      runPromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Script execution exceeded hard timeout limit of ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);

    // 取回 context 内的日志(context → 宿主方向,只读字符串)
    try {
      const captured = new vm.Script('globalThis.__cm_logs').runInContext(context, {
        timeout: 1000,
      });
      for (const line of Array.from(captured as any)) logs.push(String(line));
    } catch {
      // 日志读取失败不影响执行结果
    }

    return {
      success: true,
      logs,
      returnValue,
      wallTimeMs: Date.now() - startTime,
    };
  } catch (error: any) {
    return {
      success: false,
      logs,
      error: error?.message || String(error),
      wallTimeMs: Date.now() - startTime,
    };
  }
}

/**
 * 在 QuickJS-WASM 纯内存沙箱中执行 JS 代码 (WASM 强沙箱)
 */
export async function executeInQuickJsSandbox(
  options: ScriptExecutionOptions
): Promise<ScriptExecutionOutcome> {
  const startTime = Date.now();
  const logs: string[] = [];
  const timeoutMs = options.timeoutMs ?? 60000;

  let qvm: QuickJSAsyncContext | undefined;
  try {
    qvm = await newAsyncContext();

    // 1. 注入 console.log / console.info / console.warn / console.error
    const logFn = qvm.newFunction('__log', (...args) => {
      const nativeArgs = args.map((a) => qvm!.dump(a));
      const line = nativeArgs
        .map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x)))
        .join(' ');
      logs.push(line);
    });

    const consoleObj = qvm.newObject();
    qvm.setProp(consoleObj, 'log', logFn);
    qvm.setProp(consoleObj, 'info', logFn);
    qvm.setProp(consoleObj, 'warn', logFn);
    qvm.setProp(consoleObj, 'error', logFn);
    qvm.setProp(qvm.global, 'console', consoleObj);
    logFn.dispose();
    consoleObj.dispose();

    // 注入快捷 text() 帮助函数
    const textFn = qvm.newFunction('text', (valHandle) => {
      const val = qvm!.dump(valHandle);
      logs.push(typeof val === 'object' ? JSON.stringify(val) : String(val));
    });
    qvm.setProp(qvm.global, 'text', textFn);
    textFn.dispose();

    // 2. 注入底层宿主工具调用器 __call_host_tool
    // ⚠ P0-3 修复(2026-10-14):原实现用 `qvm.newAsyncifiedFunction(async ...)`。
    // 实测该路径下**顺序**工具调用会触发 QuickJS 引用计数断言
    //   `Aborted(Assertion failed: p->ref_count == 0, at: quickjs.c:5512, free_zero_refcount)`
    // 或 `RuntimeError: memory access out of bounds`;异常**逃出 try/catch**,
    // 直接杀死宿主进程(对照实验:asyncified 4/4 崩溃,手动 newPromise 4/4 通过)。
    // 改为手动 newPromise,由 waitForPromise 的 executePendingJobs 泵送 settle。
    const callHostToolFn = qvm.newFunction(
      '__call_host_tool',
      (nameHandle, argsJsonHandle) => {
        const toolName = qvm!.getString(nameHandle);
        const rawArgs = qvm!.getString(argsJsonHandle);
        const deferred = qvm!.newPromise();

        Promise.resolve()
          .then(async () => {
            let parsedArgs: Record<string, unknown> = {};
            try {
              if (rawArgs) {
                parsedArgs = JSON.parse(rawArgs);
              }
            } catch (e: any) {
              throw new Error(`Invalid JSON arguments for tool "${toolName}": ${e.message}`);
            }
            const result = await options.bridge.executeTool(toolName, parsedArgs);
            return JSON.stringify({ ok: true, data: result === undefined ? null : result });
          })
          .catch((err: any) =>
            JSON.stringify({ ok: false, error: err?.message || String(err) })
          )
          .then((serialized: string) => {
            deferred.resolve(qvm!.newString(serialized));
          });

        return deferred.handle;
      }
    );
    qvm.setProp(qvm.global, '__call_host_tool', callHostToolFn);
    callHostToolFn.dispose();

    // 3. 构造沙箱内的 tools Proxy 对象
    const initProxyScript = `
      globalThis.tools = new Proxy({}, {
        get(_, prop) {
          const toolName = String(prop);
          return async function(args = {}) {
            const raw = await __call_host_tool(toolName, JSON.stringify(args));
            const parsed = JSON.parse(raw);
            if (!parsed.ok) {
              throw new Error("Tool " + toolName + " failed: " + parsed.error);
            }
            return parsed.data;
          };
        }
      });
    `;
    const initRes = qvm.evalCode(initProxyScript);
    qvm.unwrapResult(initRes).dispose();

    // 4. 包装用户代码并执行
    const wrappedScript = `(async () => {\n${options.script}\n})()`;
    const evalRes = await qvm.evalCodeAsync(wrappedScript);
    const promiseHandle = qvm.unwrapResult(evalRes);

    const { success, handle } = await waitForPromise(qvm, promiseHandle, timeoutMs);
    promiseHandle.dispose();

    let returnValue: unknown = undefined;
    let errorMessage: string | undefined = undefined;

    if (success) {
      returnValue = qvm.dump(handle);
    } else {
      const dumped = qvm.dump(handle);
      errorMessage =
        typeof dumped === 'object' && dumped !== null && 'message' in dumped
          ? String((dumped as any).message)
          : String(dumped);
    }
    handle.dispose();

    return {
      success,
      logs,
      returnValue,
      error: errorMessage,
      wallTimeMs: Date.now() - startTime,
    };
  } catch (error: any) {
    return {
      success: false,
      logs,
      error: error?.message || String(error),
      wallTimeMs: Date.now() - startTime,
    };
  } finally {
    if (qvm && qvm.alive) {
      qvm.dispose();
    }
  }
}

/**
 * 统一沙箱执行入口，默认走原生 VM 高速引擎
 *
 * `hardIsolation: true` 时改走 worker thread —— 见 worker-sandbox.ts 里对
 * 「为什么同进程内设不出可靠硬超时」的说明。
 */
export async function executeCodeModeScript(
  options: ScriptExecutionOptions
): Promise<ScriptExecutionOutcome> {
  if (options.hardIsolation === true) {
    return await executeInWorkerSandbox(options);
  }
  if (options.engine === 'quickjs') {
    return await executeInQuickJsSandbox(options);
  }
  return await executeInVmSandbox(options);
}
