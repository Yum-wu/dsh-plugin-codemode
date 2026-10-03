import type { DshContext, CodeModeConfig, CodeModeArgs } from './types.js';
import { createDshToolBridge } from './tool-bridge.js';
import { executeCodeModeScript } from './sandbox.js';
import { formatExecutionResult } from './truncator.js';
import { decideReasoningEffort } from './auto-reasoning.js';

export const name = 'dsh-plugin-codemode';
export const inject = ['tools', 'systemPrompt', 'llm', 'connection'];

/**
 * 模型配置里写 `reasoningEffort: auto` 时的哨兵值。
 * cordis 的档位枚举只有 off/minimal/low/medium/high/xhigh/max，`auto` 不是合法档位，
 * 会在 dsh-llm 的 resolveCallWithInfo 里抛 UNSUPPORTED_REASONING_EFFORT；
 * 本插件在 agent/request 上把它换成按任务复杂度投影出的合法档位。
 */
export const AUTO_EFFORT_SENTINEL = 'auto';

/** 保留的会话决策条数上限；超出后按插入序淘汰最旧的会话。 */
export const AUTO_DECISION_CAP = 50;

/** 一次自动档位决策，按会话 id 归档供客户端胶囊读取。 */
export interface AutoEffortDecision {
  sessionId: string;
  effort: string;
  score: number;
  reason: string;
  model: string;
  ladder: string[];
  at: string;
}

/**
 * 取当前异步驱动链上的 Agent。agent/request 由 agent 作用域派发，
 * 若宿主把 agent 注入进载荷就用载荷，否则退回 initiator 边界。
 * 两条路都不可用时返回 undefined —— 调用方按 'default' 归档，不抛错。
 */
function currentAgent(ctx: any): any {
  try {
    const registry = ctx?.agents ?? ctx?.get?.('agents');
    return registry?.currentInitiator?.();
  } catch {
    return undefined;
  }
}

/** 取会话中最后一条用户消息的纯文本，作为复杂度评分的输入。 */
export function lastUserPromptText(session: any): string {
  const messages: any[] = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((block: any) => block?.type === 'text')
      .map((block: any) => String(block.text ?? ''))
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}

/**
 * 默认参考 Pi 架构保留的核心轻量工具白名单：
 * 保留低延迟单步交互、问答确认、目标追踪与单文件快速读取，其余一律收敛进沙箱
 */
export const DEFAULT_CORE_TOOLS = [
  'codemode',
  'ask_user_question',
  'pwsh',
  'read',
  'edit',
  'write',
  'glob',
  'grep',
  'get_goal',
  'update_goal',
  'todo_write',
];

export function apply(ctx: DshContext, config: CodeModeConfig = {}) {
  const toolName = config.toolName || 'codemode';
  const maxResultChars = config.maxResultChars || 50000;
  const timeoutMs = config.timeoutMs || 60000;
  const injectGuidance = config.injectGuidance !== false;
  const collapseTopLevel = config.collapseTopLevelTools === true;
  const allowedTools = new Set(config.allowedTopLevelTools || DEFAULT_CORE_TOOLS);
  allowedTools.add(toolName);

  // 1. 注入 Code Mode 编排硬铁律与沙箱 API 规范
  if (injectGuidance && ctx.systemPrompt?.section) {
    let order = 100;
    try {
      if (typeof ctx.systemPrompt.getSectionOrder === 'function') {
        const resolved = ctx.systemPrompt.getSectionOrder(`tool:${toolName}`);
        if (Number.isFinite(resolved)) {
          order = resolved;
        }
      }
    } catch {
      order = 100;
    }

    ctx.systemPrompt.section({
      name: `tool:${toolName}`,
      order,
      text: `## 【强制门禁】Code Mode (Programmatic Tool Calling) 编排铁律
凡命中以下场景之一，严禁使用单步原子工具（read/grep/glob/pwsh）进行多轮循环交互，必须且只能调用 \`${toolName}\` 编写 JavaScript 脚本一次性完成：
1. 涉及 2 个及以上文件的扫描、检索、批量读取、过滤或统计；
2. 涉及对外部工具/MCP 的批量查询或需要中间数据聚合、排序、计算；
3. 任何会返回超过 50 行文本且模型只需部分摘要或指标的探索操作。

【违规判定】：在满足上述场景时逐个调用原子工具属于反模式，会产生巨量 Token 浪费和上下文污染。

【脚本环境规范】
- 脚本运行于独立轻量隔离沙箱中，支持 ES2022+ 语法，支持顶层 \`await\` 与 \`return\`。
- 外部工具映射：全局可用 \`tools.<tool_name>(args)\` 异步函数。
  - 例如：\`const content = await tools.read({ file_path: 'foo.txt' });\`
  - 支持并发：\`const results = await Promise.all(paths.map(p => tools.read({ file_path: p })));\`
- 零 Token 动态自省：可在脚本中调用 \`tools.list()\` 查看全部可用工具名，调用 \`tools.help('tool_name')\` 在沙箱内存中查阅完整 Schema，严禁索取全量静态定义。
- 结果返回：使用 \`return <value>\` 返回最终提炼的结构化数据（中间工具输出不会污染主对话上下文）。
- 调试输出：支持使用 \`console.log(...)\` 或 \`text(...)\` 打印人类可读的关键进度日志。`,
    });
  }

  // 2. 挂载 DSH 系统提示词组装流水线 (Waterfall)，收敛顶层工具声明
  // ctx.waterfall() 是「发射」，注册监听必须用 ctx.on()；prepend 让本监听成为最外层，
  // waterfall 的整体结果就是最外层监听器的返回值（实测：内层监听返回的值只向上传给它的外层）
  if (collapseTopLevel) {
    (ctx as any).on('system-prompt/assemble', async (assembly: any, context: any, next: () => Promise<any>) => {
      const original = await next();
      if (!original || !Array.isArray(original.tools)) return original;

      // 仅保留核心轻量白名单工具，把其余 130+ 个 MCP / GUI 重型工具从顶层 Prompt 中剔除
      const filteredTools = original.tools.filter((t: any) => {
        const name = typeof t === 'string' ? t : t?.name || t?.function?.name;
        return allowedTools.has(name);
      });

      return {
        ...original,
        tools: filteredTools,
      };
    }, { prepend: true });
  }

  // 3. Auto Reasoning Effort：按任务复杂度决定本次请求的思考档位。
  // 必须挂 agent/request —— llm/stream 的 options 对 loop 请求是 deepFreeze 的，
  // 且 cordis 的 next() 不吃实参，改不动。agent/request 的返回值直接喂给 llm.prepareCall。
  // global+prepend：跨 agent 作用域都命中，且排在 dsh-agent 自己的模型选择监听之前成为最外层。
  const autoReasoning = config.autoReasoning === true;
  const autoStats = { seen: 0, lastIncoming: 'never', lastOutgoing: 'never', lastAgentSource: 'never' };
  // 决策必须按会话隔离：agent/request 是全局瀑布，单槽变量会让所有会话的胶囊
  // 显示同一条（最近一次）记录。Map 保留插入序，超上限时淘汰最旧的会话。
  const autoDecisions = new Map<string, AutoEffortDecision>();
  const rememberDecision = (decision: AutoEffortDecision) => {
    autoDecisions.delete(decision.sessionId);
    autoDecisions.set(decision.sessionId, decision);
    while (autoDecisions.size > AUTO_DECISION_CAP) {
      const oldest = autoDecisions.keys().next().value;
      if (oldest === undefined) break;
      autoDecisions.delete(oldest);
    }
  };

  (ctx as any).on('agent/request', async (payload: any, next: () => Promise<any>) => {
    const resolved = await next();
    // 会话归属：优先取 payload 上注入的 agent，退回 cordis 的 initiator 边界。
    // agent/request 的瀑布载荷由 agent 作用域派发，两种来源在不同宿主版本上各有一路。
    const agent = payload?.agent ?? currentAgent(ctx);
    const sessionId = String(agent?.id ?? agent?.session?.id ?? 'default');
    autoStats.lastAgentSource = payload?.agent ? 'payload' : agent ? 'initiator' : 'none';
    autoStats.seen += 1;
    autoStats.lastIncoming = resolved?.reasoningEffort === void 0 ? '<absent>' : String(resolved.reasoningEffort);
    const passthrough = () => { autoStats.lastOutgoing = autoStats.lastIncoming; return resolved; };
    if (!autoReasoning || !resolved) return passthrough();

    // 只接管哨兵 auto：用户在模型拾取器里显式选过、或会话持久 header 里已存着具体档位时，
    // incoming 就是那个具体值，一律放行不碰。
    // 2026-10-04 实测 seen=1 / lastIncoming=auto / lastOutgoing=low —— Web 新会话送进来的
    // 确实是 'auto'。此前胶囊一直停在"待首次请求"，是因为在跑的会话全是我验证时建的那几条、
    // 其 header 里已存着 high，不是接管条件写错（我一度归因给 agentOptions() 丢掉档位，错了）。
    if (resolved.reasoningEffort !== AUTO_EFFORT_SENTINEL) return passthrough();

    // 兜底路径：拿不到合法档位时【不带】reasoningEffort，让模型用自己的默认档，
    // 绝不能把 'auto' 原样交回宿主(会在 resolveCallWithInfo 抛 UNSUPPORTED_REASONING_EFFORT)
    const { reasoningEffort: _sentinel, ...withoutSentinel } = resolved;
    try {
      const info = await ctx.llm?.resolveModelInfo?.(resolved.provider, resolved.model);
      const ladder: string[] = (info?.reasoning?.efforts ?? []).map((effort: any) => String(effort.id));
      if (ladder.length === 0) {
        autoStats.lastOutgoing = '<omitted:no-ladder>';
        return withoutSentinel;
      }
      const decision = decideReasoningEffort(lastUserPromptText(agent?.session), ladder);
      rememberDecision({
        sessionId,
        effort: decision.matchedEffort,
        score: decision.score,
        reason: decision.reason,
        model: resolved.model,
        ladder,
        at: new Date().toISOString(),
      });
      autoStats.lastOutgoing = decision.matchedEffort;
      ctx.logger?.info?.(
        `codemode auto-reasoning: ${resolved.model} -> ${decision.matchedEffort} ` +
        `(score ${decision.score}/10, ${decision.reason}, ladder=${ladder.join('/')})`
      );
      return { ...resolved, reasoningEffort: decision.matchedEffort };
    } catch (error) {
      autoStats.lastOutgoing = `<omitted:error>`;
      ctx.logger?.warn?.(`codemode auto-reasoning 决策失败，回退模型默认档位: ${String(error)}`);
      return withoutSentinel;
    }
  }, { global: true, prepend: true });

  // 3b. 把档位决策与诊断计数暴露给客户端胶囊(lib/client.js 轮询这个只读路由)。
  // 走宿主共享 /api 通道，鉴权与信任策略由宿主施加，插件自己不处理凭据。
  ctx.connection?.fetch?.register?.({
    path: '/api/codemode.auto-effort',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request: Request) => {
      const sessionId = new URL(request.url).searchParams.get('sessionId') ?? '';
      const decision =
        autoDecisions.get(sessionId) ??
        (sessionId === '' ? [...autoDecisions.values()].pop() : undefined);
      return Promise.resolve(Response.json({
        enabled: autoReasoning,
        ...autoStats,
        sessionId,
        decision: decision ?? null,
        sessions: [...autoDecisions.keys()],
      }));
    },
  });

  // 4. 注册面向模型的 codemode 工具
  const toolDefinition = {
    name: toolName,
    description: `在受控内存沙箱中执行模型编写的 JavaScript (ES2022+) 编排脚本。通过 \`tools.<tool_name>(args)\` 异步调用已注册的各类宿主及 MCP 工具，支持 Promise.all 并发与数据过滤。只有显式 return 的提炼结果和日志才会进入上下文，中间原始数据不污染会话历史。沙箱支持 tools.list() 与 tools.help(name)。`,
    parameters: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description:
            '纯 JavaScript 异步执行体代码，支持顶层 await / return。通过 tools.<tool_name>(args) 编排调用外部工具。',
        },
      },
      required: ['script'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
      },
      render: (_args: any, value: any) => {
        if (Array.isArray(value?.content)) {
          return value.content;
        }
        return [
          {
            type: 'text',
            text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
          },
        ];
      },
    },
    execute: async (args: CodeModeArgs, sessionCtx: any) => {
      const bridge = createDshToolBridge({
        ctx,
        sessionCtx,
        currentToolName: toolName,
      });

      const outcome = await executeCodeModeScript({
        script: args.script,
        bridge,
        engine: config.engine,
        maxResultChars,
        timeoutMs,
      });

      const formatted = formatExecutionResult(outcome, maxResultChars);

      return {
        content: [
          {
            type: 'text',
            text: formatted.text,
          },
        ],
        isError: formatted.isError,
      };
    },
  };

  if (typeof ctx.tools?.register === 'function') {
    ctx.tools.register(toolDefinition);
  }
}

export * from './types.js';
export * from './sandbox.js';
export * from './tool-bridge.js';
export * from './truncator.js';
export * from './auto-reasoning.js';
