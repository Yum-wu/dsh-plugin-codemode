import type { Context } from '@deepseek-ai/cordis';

export interface DshContext extends Context {
  tools?: {
    register: (def: any) => void;
    keys?: () => IterableIterator<string>;
    list?: () => Array<{ name: string }>;
    get?: (name: string, scope?: any) => any;
    execute?: (name: string, args: any, sessionCtx?: any) => Promise<any>;
    view?: (scope?: any) => any;
  };
  systemPrompt?: {
    getSectionOrder?: (name: string) => number;
    section: (options: { name: string; order: number; text: string }) => void;
    assemble?: (context: any) => Promise<any>;
  };
  llm?: {
    resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<any>;
  };
  connection?: {
    fetch?: {
      register?: (route: {
        path: string;
        methods: readonly string[];
        requestBody: 'buffered' | 'streaming';
        fetch: (request: Request) => Promise<Response>;
      }) => () => Promise<void>;
    };
  };
}

export interface CodeModeConfig {
  /** 面向模型的工具名称，默认 'codemode' */
  toolName?: string;
  /** 沙箱执行引擎：'vm' (V8 原生高速隔离沙箱，默认) | 'quickjs' (WASM 纯内存沙箱) */
  engine?: 'vm' | 'quickjs';
  /** 返回给上下文的最大字符上限，超出截断，默认 50,000 */
  maxResultChars?: number;
  /** 单次脚本执行的硬超时（毫秒），默认 60,000 */
  timeoutMs?: number;
  /** 是否向模型系统提示词追加 Code Mode 编排指南，默认 true */
  injectGuidance?: boolean;
  /** 是否开启 Pi 模式顶层工具收敛过滤（仅暴露核心轻量工具 + codemode，其余收进沙箱） */
  collapseTopLevelTools?: boolean;
  /** 当 collapseTopLevelTools 开启时，允许保留在顶层暴露的核心轻量工具白名单 */
  allowedTopLevelTools?: string[];
  /** 是否接管思考档位 (Auto Reasoning Effort)，默认 false，必须显式开启 */
  autoReasoning?: boolean;
}

export interface CodeModeArgs {
  /** 模型生成的待执行 JavaScript 代码 (ES2022+)，支持顶层 await / return */
  script: string;
}

export interface ToolExecutionBridge {
  executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  listAvailableTools?: () => string[];
  getToolHelp?: (namePattern?: string) => any[];
}

export interface ScriptExecutionOptions {
  script: string;
  bridge: ToolExecutionBridge;
  engine?: 'vm' | 'quickjs';
  maxResultChars?: number;
  timeoutMs?: number;
}

export interface ScriptExecutionOutcome {
  success: boolean;
  logs: string[];
  returnValue?: unknown;
  error?: string;
  wallTimeMs: number;
}
