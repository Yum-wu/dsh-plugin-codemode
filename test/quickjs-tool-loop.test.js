import test from 'node:test';
import assert from 'node:assert/strict';
import { executeInQuickJsSandbox } from '../lib/sandbox.js';

/**
 * QuickJS 沙箱工具编排护栏 —— P0-3 回归测试
 *
 * 依据 2026-10-14 实测基线:QuickJS 路径下,**第 3 次跨 WASM 边界的
 * suspend/resume 周期即触发未捕获 WASM RuntimeError
 * (`memory access out of bounds` / `table index is out of bounds`),
 * 宿主进程直接死亡,且异常逃出 executeInQuickJsSandbox 的 try/catch。
 *
 * 触发条件是**周期数**而非调用总数:
 *   1 周期(seq×1 或 Promise.all×N)  → 通过
 *   2 周期(seq×2 或 seq+par)         → 通过
 *   3 周期(seq×3 / seq+par+seq)      → 崩溃
 *
 * ⚠ 若本文件导致测试进程整体消失(而非输出断言失败),那正是本护栏要抓的缺陷。
 */

const bridge = () => {
  let calls = 0;
  return {
    executeTool: async () => {
      calls++;
      return 'ok';
    },
    get callCount() {
      return calls;
    },
  };
};

test('QuickJS 沙箱:1 个挂起/恢复周期(单次工具调用)', async () => {
  const b = bridge();
  const outcome = await executeInQuickJsSandbox({
    script: `await tools.read({ i: 1 }); return 1;`,
    bridge: b,
    timeoutMs: 5000,
  });
  assert.equal(outcome.success, true, outcome.error);
  assert.equal(outcome.returnValue, 1);
  assert.equal(b.callCount, 1);
});

test('QuickJS 沙箱:1 个周期内并行 5 次工具调用', async () => {
  const b = bridge();
  const outcome = await executeInQuickJsSandbox({
    script: `await Promise.all([1,2,3,4,5].map((i) => tools.read({ i }))); return 5;`,
    bridge: b,
    timeoutMs: 5000,
  });
  assert.equal(outcome.success, true, outcome.error);
  assert.equal(outcome.returnValue, 5);
  assert.equal(b.callCount, 5);
});

test('QuickJS 沙箱:2 个周期(顺序 2 次)', async () => {
  const b = bridge();
  const outcome = await executeInQuickJsSandbox({
    script: `await tools.read({ i: 1 }); await tools.read({ i: 2 }); return 2;`,
    bridge: b,
    timeoutMs: 5000,
  });
  assert.equal(outcome.success, true, outcome.error);
  assert.equal(outcome.returnValue, 2);
  assert.equal(b.callCount, 2);
});

// ↓ 以下用例在修复前会让整个测试进程消失,这正是缺陷本身
test('QuickJS 沙箱:3 个周期(顺序 3 次)必须存活', async () => {
  const b = bridge();
  const outcome = await executeInQuickJsSandbox({
    script: `await tools.read({ i: 1 }); await tools.read({ i: 2 }); await tools.read({ i: 3 }); return 3;`,
    bridge: b,
    timeoutMs: 5000,
  });
  assert.equal(outcome.success, true, outcome.error);
  assert.equal(outcome.returnValue, 3);
  assert.equal(b.callCount, 3);
});

test('QuickJS 沙箱:3 个周期(seq + par + seq)必须存活', async () => {
  const b = bridge();
  const outcome = await executeInQuickJsSandbox({
    script: `await tools.read({ i: 1 });
             await Promise.all([1,2].map((i) => tools.read({ i })));
             await tools.read({ i: 9 });
             return 3;`,
    bridge: b,
    timeoutMs: 5000,
  });
  assert.equal(outcome.success, true, outcome.error);
  assert.equal(outcome.returnValue, 3);
});

test('QuickJS 沙箱:真实工作流(读 5 个工具再汇总)必须存活', async () => {
  const b = bridge();
  const outcome = await executeInQuickJsSandbox({
    script: `const out = [];
             for (let i = 0; i < 5; i++) { out.push(await tools.read({ i })); }
             return out.length;`,
    bridge: b,
    timeoutMs: 10000,
  });
  assert.equal(outcome.success, true, outcome.error);
  assert.equal(outcome.returnValue, 5);
  assert.equal(b.callCount, 5);
});
