import { newAsyncContext, type QuickJSAsyncContext, type QuickJSHandle } from 'quickjs-emscripten';
import type { ScriptExecutionOptions, ScriptExecutionOutcome } from './types.js';

/**
 * 驱动 QuickJS 微任务队列并等待异步执行完成或超时
 */
async function waitForPromise(
  vm: QuickJSAsyncContext,
  promiseHandle: QuickJSHandle,
  timeoutMs: number
): Promise<{ success: boolean; handle: QuickJSHandle }> {
  const start = Date.now();
  while (true) {
    const state = vm.getPromiseState(promiseHandle);
    if (state.type === 'fulfilled') {
      return { success: true, handle: state.value };
    }
    if (state.type === 'rejected') {
      return { success: false, handle: state.error };
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Script execution exceeded hard timeout limit of ${timeoutMs}ms`);
    }

    if (vm.runtime.hasPendingJob()) {
      const res = await vm.runtime.executePendingJobs();
      if (res.error) {
        throw new Error('QuickJS runtime pending job error: ' + vm.dump(res.error));
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

/**
 * 在独立的 QuickJS-WASM 内存沙箱中执行 JS 代码
 */
export async function executeInQuickJsSandbox(
  options: ScriptExecutionOptions
): Promise<ScriptExecutionOutcome> {
  const startTime = Date.now();
  const logs: string[] = [];
  const timeoutMs = options.timeoutMs ?? 60000;

  let vm: QuickJSAsyncContext | undefined;
  try {
    vm = await newAsyncContext();

    // 1. 注入 console.log / console.info / console.warn / console.error
    const logFn = vm.newFunction('__log', (...args) => {
      const nativeArgs = args.map((a) => vm!.dump(a));
      const line = nativeArgs
        .map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x)))
        .join(' ');
      logs.push(line);
    });

    const consoleObj = vm.newObject();
    vm.setProp(consoleObj, 'log', logFn);
    vm.setProp(consoleObj, 'info', logFn);
    vm.setProp(consoleObj, 'warn', logFn);
    vm.setProp(consoleObj, 'error', logFn);
    vm.setProp(vm.global, 'console', consoleObj);
    logFn.dispose();
    consoleObj.dispose();

    // 注入快捷 text() 帮助函数
    const textFn = vm.newFunction('text', (valHandle) => {
      const val = vm!.dump(valHandle);
      logs.push(typeof val === 'object' ? JSON.stringify(val) : String(val));
    });
    vm.setProp(vm.global, 'text', textFn);
    textFn.dispose();

    // 2. 注入底层宿主工具调用器 __call_host_tool
    const callHostToolFn = vm.newAsyncifiedFunction(
      '__call_host_tool',
      async (nameHandle, argsJsonHandle) => {
        const toolName = vm!.getString(nameHandle);
        let parsedArgs: Record<string, unknown> = {};
        try {
          const rawArgs = vm!.getString(argsJsonHandle);
          if (rawArgs) {
            parsedArgs = JSON.parse(rawArgs);
          }
        } catch (e: any) {
          throw new Error(`Invalid JSON arguments for tool "${toolName}": ${e.message}`);
        }

        try {
          const result = await options.bridge.executeTool(toolName, parsedArgs);
          const serialized = JSON.stringify({ ok: true, data: result });
          return vm!.newString(serialized);
        } catch (err: any) {
          const serialized = JSON.stringify({
            ok: false,
            error: err?.message || String(err),
          });
          return vm!.newString(serialized);
        }
      }
    );
    vm.setProp(vm.global, '__call_host_tool', callHostToolFn);
    callHostToolFn.dispose();

    // 3. 构造沙箱内的 tools Proxy 对象与支持工具名安全下划线转换
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
    const initRes = vm.evalCode(initProxyScript);
    vm.unwrapResult(initRes).dispose();

    // 4. 包装用户代码并执行
    // 将其包裹在一个 async IIFE 中，支持顶层 await / return
    const wrappedScript = `(async () => {\n${options.script}\n})()`;
    const evalRes = await vm.evalCodeAsync(wrappedScript);
    const promiseHandle = vm.unwrapResult(evalRes);

    const { success, handle } = await waitForPromise(vm, promiseHandle, timeoutMs);
    promiseHandle.dispose();

    let returnValue: unknown = undefined;
    let errorMessage: string | undefined = undefined;

    if (success) {
      returnValue = vm.dump(handle);
    } else {
      const dumped = vm.dump(handle);
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
    if (vm && vm.alive) {
      vm.dispose();
    }
  }
}
