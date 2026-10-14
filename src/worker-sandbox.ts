import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { ScriptExecutionOptions, ScriptExecutionOutcome } from './types.js';

const WORKER_ENTRY = fileURLToPath(new URL('./worker-entry.js', import.meta.url));

/** postMessage 需要结构化克隆;工具返回值可能含函数/渲染器,先降级成纯数据。 */
function cloneable(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

/**
 * 把沙箱执行放进 worker thread,并用 `worker.terminate()` 做**真正可用的**硬超时。
 *
 * 为什么必须有这条路径:同进程内 `vm` / QuickJS 与宿主共用一个事件循环,
 * 沙箱里一个纯 `await` 紧循环就能饿死宏任务队列,让宿主侧的 `setTimeout`
 * 永远排不上 —— 此时 `Promise.race` 型超时**结构性失效**(2026-10-14 实测:
 * 20s 看门狗未返回)。跨线程之后,宿主事件循环始终空闲,terminate() 一定生效。
 *
 * 副作用(好的那种):worker 内的 WASM/QuickJS 级崩溃(如 quickjs-emscripten 的
 * `p->ref_count == 0` 断言)不再杀死主进程,而是变成一条干净的失败结果。
 */
export async function executeInWorkerSandbox(
  options: ScriptExecutionOptions
): Promise<ScriptExecutionOutcome> {
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? 60000;
  const engine = options.engine === 'quickjs' ? 'quickjs' : 'vm';

  return await new Promise<ScriptExecutionOutcome>((resolve) => {
    let settled = false;
    let worker: Worker | undefined;
    let timer: NodeJS.Timeout;

    const finish = (outcome: ScriptExecutionOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (worker !== undefined) {
        worker.removeAllListeners();
        worker.terminate().catch(() => {});
      }
      resolve(outcome);
    };

    // 外层看门狗比内层超时宽 250ms:让内层有机会先报出准确原因;
    // 内层被微任务饥饿卡住时,由这里强杀。
    timer = setTimeout(() => {
      finish({
        success: false,
        logs: [],
        error: `Script execution exceeded hard timeout limit of ${timeoutMs}ms (worker terminated)`,
        wallTimeMs: Date.now() - startTime,
      });
    }, timeoutMs + 250);

    try {
      worker = new Worker(WORKER_ENTRY, {
        workerData: {
          script: options.script,
          engine,
          timeoutMs,
          maxResultChars: options.maxResultChars,
          availableTools: options.bridge.listAvailableTools?.() || [],
          toolHelp: options.bridge.getToolHelp?.() || [],
        },
        resourceLimits: {
          maxOldGenerationSizeMb: 512,
          maxYoungGenerationSizeMb: 64,
          stackSizeMb: 4,
        },
      });
    } catch (err: any) {
      settled = true;
      clearTimeout(timer);
      return resolve({
        success: false,
        logs: [],
        error: `Failed to start sandbox worker: ${err?.message || err}`,
        wallTimeMs: Date.now() - startTime,
      });
    }

    worker.on('message', (msg: any) => {
      if (!msg) return;

      if (msg.type === 'done') {
        finish(msg.outcome as ScriptExecutionOutcome);
        return;
      }

      if (msg.type === 'tool') {
        Promise.resolve()
          .then(() => options.bridge.executeTool(msg.name, msg.args))
          .then(
            (data) =>
              worker!.postMessage({
                type: 'tool-result',
                id: msg.id,
                ok: true,
                data: cloneable(data),
              }),
            (err: any) =>
              worker!.postMessage({
                type: 'tool-result',
                id: msg.id,
                ok: false,
                error: err?.message || String(err),
              })
          );
      }
    });

    worker.on('error', (err) => {
      finish({
        success: false,
        logs: [],
        error: `Sandbox worker crashed: ${err?.message || String(err)}`,
        wallTimeMs: Date.now() - startTime,
      });
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        finish({
          success: false,
          logs: [],
          error: `Sandbox worker exited unexpectedly with code ${code}`,
          wallTimeMs: Date.now() - startTime,
        });
      }
    });
  });
}
