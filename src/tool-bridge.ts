import type { ToolExecutionBridge } from './types.js';

export interface CreateBridgeOptions {
  ctx: any;
  sessionCtx?: any;
  currentToolName?: string;
}

export interface ToolHelpInfo {
  name: string;
  description: string;
  parameters?: any;
}

/**
 * 创建与 DSH 宿主环境 ctx.tools 对接的桥接器
 */
export function createDshToolBridge(options: CreateBridgeOptions): ToolExecutionBridge {
  const { ctx, sessionCtx, currentToolName = 'codemode' } = options;

  const getVisibleTools = (): Map<string, any> => {
    try {
      if (!ctx.tools) return new Map();
      if (typeof ctx.tools.view === 'function') {
        const view = ctx.tools.view(sessionCtx?.agent);
        if (view && view.visible) return view.visible;
      }
      if (ctx.tools instanceof Map) return ctx.tools;
      return new Map();
    } catch {
      return new Map();
    }
  };

  const MAX_CONCURRENT_TOOLS = 16;
  let activeCalls = 0;
  const waitQueue: Array<() => void> = [];

  function acquireSlot(): Promise<void> {
    if (activeCalls < MAX_CONCURRENT_TOOLS) {
      activeCalls++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waitQueue.push(() => {
        activeCalls++;
        resolve();
      });
    });
  }

  function releaseSlot(): void {
    activeCalls--;
    if (waitQueue.length > 0) {
      const next = waitQueue.shift();
      if (next) next();
    }
  }

  async function invokeToolInternal(name: string, args: Record<string, unknown>) {
    if (!ctx.tools) {
      throw new Error('DSH host ctx.tools is not available.');
    }

    // 2. 深度脱敏：消灭跨 VM / 沙箱的原型链污染，确保纯 JSON 对象
    const cleanArgs = JSON.parse(JSON.stringify(args || {}));

    // 3. 构建规范的 exec 上下文 (保障 signal 与 agent 存在)
    const signal = sessionCtx?.signal || new AbortController().signal;
    const agent = sessionCtx?.agent;
    const callId = `cm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 4. 优先路径：获取已注册工具实例直接执行
    let toolInstance: any;
    if (typeof ctx.tools.get === 'function') {
      toolInstance = ctx.tools.get(name, agent);
    } else if (ctx.tools instanceof Map) {
      toolInstance = ctx.tools.get(name);
    }

    const execContext = {
      callId,
      name,
      arguments: cleanArgs,
      signal,
      ...(agent ? { agent } : {}),
    };

    if (toolInstance && typeof toolInstance.execute === 'function') {
      try {
        const res = await toolInstance.execute(cleanArgs, execContext);
        return unwrapToolResult(res);
      } catch {
        // 如果直调参数报错，继续降级尝试标准调度
      }
    }

    // 5. 次选路径：调用标准 DSH 调度器 ctx.tools.execute(exec)
    if (typeof ctx.tools.execute === 'function') {
      const res = await ctx.tools.execute(execContext);
      return unwrapToolResult(res);
    }

    throw new Error(`Tool "${name}" is not registered in DSH runtime.`);
  }

  return {
    listAvailableTools: () => {
      try {
        const visible = getVisibleTools();
        if (visible.size > 0) {
          return Array.from(visible.keys()).map(String).filter((n) => n !== currentToolName);
        }
        if (typeof ctx.tools?.keys === 'function') {
          return Array.from(ctx.tools.keys()).map(String).filter((n) => n !== currentToolName);
        }
        return [];
      } catch {
        return [];
      }
    },

    getToolHelp: (namePattern?: string): ToolHelpInfo[] => {
      const visible = getVisibleTools();
      const results: ToolHelpInfo[] = [];
      const filter = (namePattern || '').toLowerCase();

      for (const [name, def] of visible.entries()) {
        if (name === currentToolName) continue;
        if (!filter || name.toLowerCase().includes(filter) || (def.description && def.description.toLowerCase().includes(filter))) {
          results.push({
            name,
            description: def.description || '',
            parameters: def.parameters || {},
          });
        }
      }
      return results;
    },

    executeTool: async (name: string, args: Record<string, unknown>) => {
      // 1. 防御：禁止递归调用自身
      if (name === currentToolName) {
        throw new Error(`Recursive invocation of "${name}" tool inside codemode script is rejected.`);
      }

      // 获取信号量槽位，保护并发度不超过 MAX_CONCURRENT_TOOLS
      await acquireSlot();
      try {
        return await invokeToolInternal(name, args);
      } finally {
        releaseSlot();
      }
    },
  };
}

/**
 * 提取 DSH 工具返回的真实数据内容（剥离渲染卡片包络，保留核心 payload）
 */
function unwrapToolResult(result: unknown): unknown {
  if (result === null || result === undefined) return result;
  if (typeof result !== 'object') return result;

  const obj = result as Record<string, unknown>;
  // 如果结果具有 result 或 data 字段（DSH 规范常见包络）
  if ('result' in obj && obj.result !== undefined) {
    return obj.result;
  }
  if ('data' in obj && obj.data !== undefined) {
    return obj.data;
  }
  // 如果是 ContentBlock 数组形结构
  if (Array.isArray(obj.content)) {
    // 优先提取 text 类型 block
    const textBlock = obj.content.find((b: any) => b && b.type === 'text' && typeof b.text === 'string');
    if (textBlock) {
      return textBlock.text;
    }
    return obj.content;
  }

  return result;
}
