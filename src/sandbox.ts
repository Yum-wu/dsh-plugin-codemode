import vm from 'node:vm';
import { newAsyncContext, type QuickJSAsyncContext, type QuickJSHandle } from 'quickjs-emscripten';
import type { ScriptExecutionOptions, ScriptExecutionOutcome } from './types.js';

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
    const toolProxy = new Proxy(
      {},
      {
        get(_, prop) {
          const toolName = String(prop);
          return async (args: Record<string, unknown> = {}) => {
            return await options.bridge.executeTool(toolName, args);
          };
        },
      }
    );

    const logSink = (...args: any[]) => {
      logs.push(
        args.map((x) => (typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x))).join(' ')
      );
    };

    const sandbox = {
      tools: toolProxy,
      console: {
        log: logSink,
        info: logSink,
        warn: logSink,
        error: logSink,
      },
      text: (val: any) => {
        logs.push(typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val));
      },
      Promise,
      JSON,
      Math,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Map,
      Set,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
    };

    const context = vm.createContext(sandbox);
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
    const callHostToolFn = qvm.newAsyncifiedFunction(
      '__call_host_tool',
      async (nameHandle, argsJsonHandle) => {
        const toolName = qvm!.getString(nameHandle);
        let parsedArgs: Record<string, unknown> = {};
        try {
          const rawArgs = qvm!.getString(argsJsonHandle);
          if (rawArgs) {
            parsedArgs = JSON.parse(rawArgs);
          }
        } catch (e: any) {
          throw new Error(`Invalid JSON arguments for tool "${toolName}": ${e.message}`);
        }

        try {
          const result = await options.bridge.executeTool(toolName, parsedArgs);
          const serialized = JSON.stringify({ ok: true, data: result });
          return qvm!.newString(serialized);
        } catch (err: any) {
          const serialized = JSON.stringify({
            ok: false,
            error: err?.message || String(err),
          });
          return qvm!.newString(serialized);
        }
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
 */
export async function executeCodeModeScript(
  options: ScriptExecutionOptions
): Promise<ScriptExecutionOutcome> {
  if (options.engine === 'quickjs') {
    return await executeInQuickJsSandbox(options);
  }
  return await executeInVmSandbox(options);
}
