import type { ScriptExecutionOutcome } from './types.js';

/**
 * 格式化脚本执行结果，并将输出限制在 maxChars 之内。
 * 格式与 Pi Code Mode 对齐：包含状态、耗时、日志和提炼返回值。
 */
export function formatExecutionResult(
  outcome: ScriptExecutionOutcome,
  maxChars = 50000
): { text: string; isError: boolean } {
  const parts: string[] = [];

  const timeSec = (outcome.wallTimeMs / 1000).toFixed(2);
  if (outcome.success) {
    parts.push(`Script completed (${timeSec}s).`);
  } else {
    parts.push(`Script failed (${timeSec}s): ${outcome.error ?? 'Unknown error'}`);
  }

  if (outcome.logs.length > 0) {
    parts.push(`\n[Logs]`);
    parts.push(outcome.logs.join('\n'));
  }

  if (outcome.returnValue !== undefined) {
    parts.push(`\n[Return Value]`);
    let rendered = '';
    try {
      rendered =
        typeof outcome.returnValue === 'string'
          ? outcome.returnValue
          : JSON.stringify(outcome.returnValue, null, 2);
    } catch {
      rendered = String(outcome.returnValue);
    }

    if (rendered.length > maxChars) {
      const omitted = rendered.length - maxChars;
      rendered = `${rendered.slice(0, maxChars)}\n… [truncated: ${omitted} more characters]`;
    }
    parts.push(rendered);
  } else if (outcome.success && outcome.logs.length === 0) {
    parts.push(`\n(No logs emitted and no return value)`);
  }

  const fullText = parts.join('\n');
  return {
    text: fullText,
    isError: !outcome.success,
  };
}
