import test from 'node:test';
import assert from 'node:assert/strict';
import { executeInQuickJsSandbox } from '../lib/sandbox.js';

test('Sandbox - basic evaluation and return value', async () => {
  const dummyBridge = {
    executeTool: async () => 'ok',
  };

  const outcome = await executeInQuickJsSandbox({
    script: `
      const a = 10;
      const b = 20;
      return a + b;
    `,
    bridge: dummyBridge,
  });

  assert.equal(outcome.success, true);
  assert.equal(outcome.returnValue, 30);
});

test('Sandbox - console.log and text output capture', async () => {
  const dummyBridge = {
    executeTool: async () => 'ok',
  };

  const outcome = await executeInQuickJsSandbox({
    script: `
      console.log('hello', 'world');
      console.info('info msg');
      text('direct text');
      return { status: 'done' };
    `,
    bridge: dummyBridge,
  });

  assert.equal(outcome.success, true);
  assert.equal(outcome.logs.length, 3);
  assert.equal(outcome.logs[0], 'hello world');
  assert.equal(outcome.logs[1], 'info msg');
  assert.equal(outcome.logs[2], 'direct text');
  assert.deepEqual(outcome.returnValue, { status: 'done' });
});

test('Sandbox - isolation security check (no process or Node APIs)', async () => {
  const dummyBridge = {
    executeTool: async () => 'ok',
  };

  const outcome = await executeInQuickJsSandbox({
    script: `
      const hasProcess = typeof process !== 'undefined';
      const hasRequire = typeof require !== 'undefined';
      return { hasProcess, hasRequire };
    `,
    bridge: dummyBridge,
  });

  assert.equal(outcome.success, true);
  assert.deepEqual(outcome.returnValue, { hasProcess: false, hasRequire: false });
});

test('Sandbox - hard timeout handles infinite loops', async () => {
  const dummyBridge = {
    executeTool: async () => 'ok',
  };

  // 设置 500ms 超时
  const outcome = await executeInQuickJsSandbox({
    script: `
      // 模拟一个异步死循环
      async function sleep(ms) {
        // QuickJS 里没有 setTimeout，但循环调用 async tool 会占用时间
        return new Promise(() => {});
      }
      await sleep(1000);
      return 'unreachable';
    `,
    bridge: dummyBridge,
    timeoutMs: 500,
  });

  assert.equal(outcome.success, false);
  assert.match(outcome.error || '', /timeout/i);
});
