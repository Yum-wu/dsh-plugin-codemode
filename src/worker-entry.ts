import { parentPort, workerData } from 'node:worker_threads';
import { executeInVmSandbox, executeInQuickJsSandbox } from './sandbox.js';
import type { ScriptExecutionOutcome, ToolExecutionBridge } from './types.js';

/**
 * worker thread 内的沙箱执行体。
 *
 * 存在的理由:`vm` 与 QuickJS 都跑在**同一个事件循环**里,所以沙箱内任何形式的
 * 微任务饥饿(纯 `await` 紧循环)都会让宿主侧的 `setTimeout` 永远排不上,
 * 同进程内**没有任何**办法设硬上限。放进独立 worker 后,宿主用
 * `worker.terminate()` 就能强杀 —— 这是唯一的可靠兜底。
 */

interface WorkerInput {
  script: string;
  engine: 'vm' | 'quickjs';
  timeoutMs: number;
  maxResultChars?: number;
  availableTools: string[];
  toolHelp: Array<{ name: string; description?: string }>;
}

const port = parentPort;
if (port === null) {
  throw new Error('worker-entry.js must be started as a worker_threads.Worker');
}

const input = workerData as WorkerInput;

/** 结构化克隆前先降级成纯数据 —— 工具返回值可能带函数/渲染器,直接 postMessage 会抛。 */
function cloneable(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

port.on('message', (msg: any) => {
  if (!msg || msg.type !== 'tool-result') return;
  const entry = pending.get(msg.id);
  if (entry === undefined) return;
  pending.delete(msg.id);
  if (msg.ok) entry.resolve(msg.data);
  else entry.reject(new Error(String(msg.error)));
});

const bridge: ToolExecutionBridge = {
  executeTool: (name, args) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      port.postMessage({ type: 'tool', id, name, args: cloneable(args) });
    }),

  // 这两个是同步接口,没法走消息往返 —— 宿主在 spawn 时一次性把全量快照塞进 workerData。
  listAvailableTools: () => input.availableTools,
  getToolHelp: (pattern?: string) => {
    const filter = (pattern || '').toLowerCase();
    if (!filter) return input.toolHelp;
    return input.toolHelp.filter(
      (t) =>
        String(t?.name || '').toLowerCase().includes(filter) ||
        String(t?.description || '').toLowerCase().includes(filter)
    );
  },
};

const runner = input.engine === 'quickjs' ? executeInQuickJsSandbox : executeInVmSandbox;

const outcome: ScriptExecutionOutcome = await runner({
  script: input.script,
  bridge,
  timeoutMs: input.timeoutMs,
  maxResultChars: input.maxResultChars,
});

port.postMessage({
  type: 'done',
  outcome: {
    ...outcome,
    logs: outcome.logs.map(String),
    returnValue: cloneable(outcome.returnValue),
  },
});
