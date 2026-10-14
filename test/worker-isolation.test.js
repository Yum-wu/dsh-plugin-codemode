import test from 'node:test';
import assert from 'node:assert/strict';
import { executeInWorkerSandbox } from '../lib/worker-sandbox.js';
import { executeCodeModeScript } from '../lib/sandbox.js';

/**
 * worker thread 硬隔离护栏
 *
 * 存在理由:同进程内 `vm` / QuickJS 与宿主共用一个事件循环,沙箱里一个**纯 `await`
 * 紧循环**(不调用任何工具)就能饿死宏任务队列 —— 宿主侧 `setTimeout` 永远排不上,
 * `Promise.race` 型超时结构性失效,整个进程挂死(2026-10-14 实测:20s 看门狗未返回)。
 *
 * 放进 worker 后,宿主事件循环始终空闲,`worker.terminate()` 一定生效。
 */

function makeBridge() {
  const calls = [];
  return {
    calls,
    executeTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'boom') throw new Error('tool exploded');
      if (name === 'read') return { content: 'hello ' + (args?.file_path ?? '') };
      return { name, args };
    },
    listAvailableTools: () => ['read', 'edit', 'pwsh'],
    getToolHelp: (p) =>
      [
        { name: 'read', description: 'Read a file' },
        { name: 'edit', description: 'Edit a file' },
      ].filter((t) => !p || t.name.includes(p)),
  };
}

test('worker:基本执行 + 工具调用 + 返回值', async () => {
  const bridge = makeBridge();
  const outcome = await executeInWorkerSandbox({
    script: `const r = await tools.read({ file_path: 'a.txt' }); return r.content;`,
    bridge,
    timeoutMs: 10000,
  });
  assert.equal(outcome.success, true, outcome.error);
  assert.equal(outcome.returnValue, 'hello a.txt');
  assert.equal(bridge.calls.length, 1);
});

test('worker:console.log 与 text 捕获回传', async () => {
  const outcome = await executeInWorkerSandbox({
    script: `console.log('hi', 42); text('direct'); return 'done';`,
    bridge: makeBridge(),
    timeoutMs: 10000,
  });
  assert.equal(outcome.success, true, outcome.error);
  assert.equal(outcome.returnValue, 'done');
  assert.deepEqual(outcome.logs, ['hi 42', 'direct']);
});

test('worker:并行工具调用', async () => {
  const bridge = makeBridge();
  const outcome = await executeInWorkerSandbox({
    script: `const rs = await Promise.all([1,2,3].map(i => tools.read({ file_path: 'f'+i }))); return rs.map(r=>r.content).join(',');`,
    bridge,
    timeoutMs: 10000,
  });
  assert.equal(outcome.success, true, outcome.error);
  assert.equal(outcome.returnValue, 'hello f1,hello f2,hello f3');
  assert.equal(bridge.calls.length, 3);
});

test('worker:工具抛错在沙箱内可捕获', async () => {
  const outcome = await executeInWorkerSandbox({
    script: `try { await tools.boom({}); return 'no-throw'; } catch (e) { return 'caught:' + e.message; }`,
    bridge: makeBridge(),
    timeoutMs: 10000,
  });
  assert.equal(outcome.success, true, outcome.error);
  assert.match(String(outcome.returnValue), /^caught:.*tool exploded/);
});

test('worker:tools.list() / tools.help() 快照可用', async () => {
  const outcome = await executeInWorkerSandbox({
    script: `const names = await tools.list(); const help = await tools.help('read'); return { n: names.length, h: help.length };`,
    bridge: makeBridge(),
    timeoutMs: 10000,
  });
  assert.equal(outcome.success, true, outcome.error);
  assert.deepEqual(outcome.returnValue, { n: 3, h: 1 });
});

// ↓↓ 本文件的核心用例:同进程内杀不掉的那一类 ↓↓

test('worker:纯 await 紧循环被硬杀(同进程内会永久挂死)', async () => {
  const t0 = Date.now();
  const outcome = await executeInWorkerSandbox({
    script: `let i = 0; while (true) { i++; await Promise.resolve(); } return i;`,
    bridge: makeBridge(),
    timeoutMs: 800,
  });
  const elapsed = Date.now() - t0;
  assert.equal(outcome.success, false, '必须失败,不能返回成功');
  assert.match(String(outcome.error), /hard timeout limit of 800ms/);
  assert.ok(elapsed < 5000, `必须在看门狗内被终止,实际 ${elapsed}ms`);
});

test('worker:同步死循环被硬杀', async () => {
  const t0 = Date.now();
  const outcome = await executeInWorkerSandbox({
    script: `while (true) {}`,
    bridge: makeBridge(),
    timeoutMs: 800,
  });
  assert.equal(outcome.success, false);
  assert.ok(Date.now() - t0 < 5000);
});

test('worker:await 工具紧循环被硬杀(工具通道不再能撑住循环)', async () => {
  const t0 = Date.now();
  const outcome = await executeInWorkerSandbox({
    script: `let i = 0; while (true) { i++; await tools.read({ i }); } return i;`,
    bridge: makeBridge(),
    timeoutMs: 800,
  });
  const elapsed = Date.now() - t0;
  assert.equal(outcome.success, false);
  assert.ok(elapsed < 5000, `实际 ${elapsed}ms`);
});

test('worker:quickjs 引擎同样可用', async () => {
  const bridge = makeBridge();
  const outcome = await executeInWorkerSandbox({
    script: `const rs = []; for (let i = 0; i < 4; i++) { rs.push(await tools.read({ file_path: 'f'+i })); } return rs.length;`,
    bridge,
    engine: 'quickjs',
    timeoutMs: 15000,
  });
  assert.equal(outcome.success, true, outcome.error);
  assert.equal(outcome.returnValue, 4);
  assert.equal(bridge.calls.length, 4);
});

test('executeCodeModeScript:hardIsolation=true 时确实改走 worker', async () => {
  const t0 = Date.now();
  const outcome = await executeCodeModeScript({
    script: `let i = 0; while (true) { i++; await Promise.resolve(); }`,
    bridge: makeBridge(),
    hardIsolation: true,
    timeoutMs: 800,
  });
  assert.equal(outcome.success, false);
  assert.ok(Date.now() - t0 < 5000);
  assert.match(String(outcome.error), /hard timeout limit of 800ms/);
});
