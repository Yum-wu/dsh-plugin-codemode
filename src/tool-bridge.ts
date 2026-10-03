import type { ToolExecutionBridge } from './types.js';

export interface CreateBridgeOptions {
  ctx: any;
  sessionCtx?: any;
  currentToolName?: string;
}

/**
 * 创建与 DSH 宿主环境 ctx.tools 对接的桥接器
 */
export function createDshToolBridge(options: CreateBridgeOptions): ToolExecutionBridge {
  const { ctx, sessionCtx, currentToolName = 'codemode' } = options;

  return {
    listAvailableTools: () => {
      try {
        if (!ctx.tools) return [];
        if (typeof ctx.tools.keys === 'function') {
          return Array.from(ctx.tools.keys()).filter((n) => n !== currentToolName);
        }
        if (typeof ctx.tools.list === 'function') {
          return ctx.tools
            .list()
            .map((t: any) => t.name)
            .filter((n: string) => n !== currentToolName);
        }
        return [];
      } catch {
        return [];
      }
    },

    executeTool: async (name: string, args: Record<string, unknown>) => {
      // 1. 防御：禁止递归调用自身
      if (name === currentToolName) {
        throw new Error(`Recursive invocation of "${name}" tool inside codemode script is rejected.`);
      }

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
