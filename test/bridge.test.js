import test from 'node:test';
import assert from 'node:assert/strict';
import { executeInQuickJsSandbox } from '../lib/sandbox.js';
import { createDshToolBridge } from '../lib/tool-bridge.js';
import { formatExecutionResult } from '../lib/truncator.js';

test('Bridge - Promise.all parallel tool execution', async () => {
  const calls = [];

  const mockCtx = {
    tools: {
      // DSH 0.2.0 ToolRuntime.execute(exec) 单参契约：exec = {callId, name, arguments, signal, agent?}
      execute: async (exec) => {
        calls.push(exec.name + ':' + exec.arguments.id);
        return { data: `result-of-${exec.name}-${exec.arguments.id}` };
      },
    },
  };

  const bridge = createDshToolBridge({
    ctx: mockCtx,
    currentToolName: 'codemode',
  });

  const outcome = await executeInQuickJsSandbox({
    script: `
      const [res1, res2, res3] = await Promise.all([
        tools.read_file({ id: 1 }),
        tools.read_file({ id: 2 }),
        tools.read_file({ id: 3 }),
      ]);
      return {
        combined: [res1, res2, res3],
      };
    `,
    bridge,
  });

  assert.equal(outcome.success, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(outcome.returnValue, {
    combined: [
      'result-of-read_file-1',
      'result-of-read_file-2',
      'result-of-read_file-3',
    ],
  });
});

test('Bridge - rejects recursive codemode call', async () => {
  const mockCtx = {
    tools: {
      execute: async () => 'ok',
    },
  };
  const bridge = createDshToolBridge({
    ctx: mockCtx,
    currentToolName: 'codemode',
  });

  const outcome = await executeInQuickJsSandbox({
    script: `
      try {
        await tools.codemode({ script: '1+1' });
        return 'not-blocked';
      } catch (e) {
        return { caught: e.message };
      }
    `,
    bridge,
  });

  assert.equal(outcome.success, true);
  assert.match(outcome.returnValue.caught, /Recursive/i);
});

test('Truncator - cuts off oversized output', () => {
  const longText = 'A'.repeat(500);
  const outcome = {
    success: true,
    logs: ['Starting scan'],
    returnValue: { text: longText },
    wallTimeMs: 120,
  };

  const result = formatExecutionResult(outcome, 100);
  assert.equal(result.isError, false);
  assert.match(result.text, /truncated/);
  assert.match(result.text, /Script completed \(0\.12s\)/);
});
