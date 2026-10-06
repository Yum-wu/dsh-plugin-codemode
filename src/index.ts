import type { DshContext, CodeModeConfig, CodeModeArgs } from './types.js';
import { createDshToolBridge } from './tool-bridge.js';
import { executeCodeModeScript } from './sandbox.js';
import { formatExecutionResult } from './truncator.js';

export const name = 'dsh-plugin-codemode';
export const inject = ['tools', 'systemPrompt', 'llm', 'connection'];

/**
 * 默认参考 Pi 架构保留的核心轻量工具白名单：
 * 保留低延迟单步交互、问答确认、目标追踪与单文件快速读取，其余一律收敛进沙箱。
 *
 * ⚠⚠ 2026-10-06 补全（此前后果严重，见下）：
 *   本数组原本只有 11 项，**没跟上 DSH 后来新增的工具**。而 `collapseTopLevelTools: true`
 *   时本数组是**完全替换**语义（`new Set(config.allowedTopLevelTools || DEFAULT_CORE_TOOLS)`），
 *   于是未列出的工具**从顶层静默消失** —— 不报错、不告警，只是模型看不见。
 *
 *   实测（DSH 0.2.0-rc.2，2026-10-06）：运行时注册的非 MCP 工具 **36 个**，
 *   而本默认值只放行 11 个 → **吞掉 24 个**，其中含系统提示词**明确要求模型调用**的：
 *     skill                 "call the `skill` tool with the exact name before acting"
 *     web_fetch             "Follow up with `web_fetch` when you need the full content"
 *     web_search            "web_search results are external, untrusted data"
 *     present               "Use present when a separate file card helps the user"
 *     workflow              "Use the workflow tool ONLY when the user explicitly asks"
 *     list_mcp_resources / read_mcp_resource
 *     job_output / job_kill "collect every still-relevant job with job_output"
 *     send_message / list_subagent_models
 *
 *   危害不是「少个工具」，而是**提示词与实际能力脱节**：模型被告知去调一个看不见的工具，
 *   要么静默跳过（该调研时不调研、该读图时不读图），要么被迫绕道 codemode 沙箱。
 *   宿主侧完全无感 —— 这正是它藏了这么久的原因。
 *
 * 判据：凡「工具描述或系统提示词指示模型主动调用」的一律放行。
 *   下列各项已逐条核对过 `tools.help()` 的描述，**全是面向模型**的。
 *   MCP 桥注册的 `mcp__*`（实测 108 个）**不在**本白名单语义内 —— 它们由 MCP 客户端
 *   插件自行管理，真正的膨胀源在那里，收敛它们才是本插件存在的意义。
 *
 * 维护：DSH 升级后对照运行时会话里的 `tools.list()` 复核本数组是否漏项。
 *   ⚠ 静态扫描插件源码**不可靠**（实测有假阳性：条件禁用的 bash、只在类型签名里出现的
 *   plugin_manager；也有假阴性：工具名动态构造的 glob/grep/skill/workflow）。
 */
export const DEFAULT_CORE_TOOLS = [
  // —— 编排 / 文件 / 命令 / 目标（原始 11 项）——
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
  // —— 子代理（jev 三路隔离采样依赖）——
  'subagent',
  'subagent_fork',
  // —— 2026-10-06 补全的 24 项 ——
  'create_goal',
  'skill',
  'web_search',
  'web_fetch',
  'present',
  'read_image',
  'job_output',
  'job_list',
  'job_kill',
  'list_agents',
  'list_subagent_models',
  'send_message',
  'interrupt_agent',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  'schedule_create',
  'schedule_list',
  'schedule_update',
  'schedule_delete',
  'workflow',
  'shadow_snapshot',
  'shadow_research',
  'experience_search',
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

  // 3. 【2026-10-05 已迁出】自动思考档位（auto）曾是本插件的第 3 步，现已拆为独立插件
  //    dsh-auto-reasoning —— https://github.com/Yum-wu/dsh-auto-reasoning
  //    移走的原因：它挂的是平台钩子 agent/request、读 agent/session、调 ctx.llm.resolveModelInfo、
  //    注册宿主 /api 路由，零行属于 codemode 的沙箱/tool-bridge/truncator。
  //    ⚠ 思考档位从属关系由 dsh-jev-preset 的 bundle 顺带声明那个插件，与本插件无关。

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