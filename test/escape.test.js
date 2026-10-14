import test from 'node:test';
import assert from 'node:assert/strict';
import { executeInVmSandbox } from '../lib/sandbox.js';

/**
 * 逃逸护栏 —— P0-1 回归测试
 *
 * 背景:`node:vm` 不是安全边界(Node 官方原文),沙箱内只要能拿到**宿主 realm** 的
 * 任何对象,就能顺着 `.constructor.constructor` 链取回宿主 Function 构造器,
 * 进而拿到宿主 `process`。
 *
 * 本测试断言:**10 条已知向量全部不得逃逸**。
 * 依据 2026-10-14 实测基线:修复前 7/10 逃逸成功(pid 与宿主相同)。
 */
const ESCAPE_VECTORS = [
  { name: 'this.constructor.constructor', expr: 'this.constructor.constructor' },
  { name: 'globalThis.constructor.constructor', expr: 'globalThis.constructor.constructor' },
  { name: 'Object.constructor', expr: 'Object.constructor' },
  { name: 'JSON.constructor.constructor', expr: 'JSON.constructor.constructor' },
  { name: 'Promise.constructor.constructor', expr: 'Promise.constructor.constructor' },
  { name: 'JSON.parse("{}").constructor.constructor', expr: 'JSON.parse("{}").constructor.constructor' },
  {
    // 数据通道:工具返回值直接来自宿主,`tool-bridge.ts` 的 unwrapToolResult 原样交回沙箱
    name: 'tool return value .constructor.constructor',
    expr: '(await tools.read({})).constructor.constructor',
  },
  { name: '(function(){}).constructor', expr: '(function(){}).constructor' },
  { name: '[].constructor.constructor', expr: '[].constructor.constructor' },
  { name: 'String("").constructor.constructor', expr: 'String("").constructor.constructor' },
];

const PROBE = `try {
  const F = __EXPR__;
  const probe = F('return typeof process')();
  return { escaped: probe !== 'undefined', probe };
} catch (e) {
  return { escaped: false, threw: String((e && e.message) || e).slice(0, 80) };
}`;

for (const { name, expr } of ESCAPE_VECTORS) {
  test(`Escape guard (vm): ${name}`, async () => {
    const bridge = {
      executeTool: async () => ({ marker: 'host-realm-object-returned-by-tool' }),
    };

    const outcome = await executeInVmSandbox({
      script: PROBE.replace('__EXPR__', expr),
      bridge,
      timeoutMs: 3000,
    });

    assert.equal(outcome.success, true, `沙箱不应崩溃: ${outcome.error || ''}`);
    assert.equal(
      outcome.returnValue?.escaped,
      false,
      `逃逸成功! ${name} → 取到宿主 process(probe=${outcome.returnValue?.probe})`
    );
  });
}

test('Escape guard (vm): 逃逸后不得读到宿主环境变量', async () => {
  const bridge = { executeTool: async () => ({ marker: 'x' }) };
  const outcome = await executeInVmSandbox({
    script: `try {
      const F = this.constructor.constructor;
      const p = F('return typeof process !== "undefined" ? process : null')();
      if (!p) return { reached: false };
      return { reached: true, envKeyCount: Object.keys(p.env || {}).length, hasKill: typeof p.kill === 'function' };
    } catch (e) { return { reached: false, threw: String((e && e.message) || e).slice(0, 80) }; }`,
    bridge,
    timeoutMs: 3000,
  });

  assert.equal(outcome.success, true);
  assert.equal(
    outcome.returnValue?.reached,
    false,
    `逃逸后读到了宿主进程: envKeyCount=${outcome.returnValue?.envKeyCount}, hasKill=${outcome.returnValue?.hasKill}`
  );
});
