import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { apply } from '../lib/index.js';

/**
 * 2026-10-05：自动思考档位(auto)已拆为独立插件 dsh-auto-reasoning，
 * 原 test/agent-request.test.js（570 行 / 28 例，几乎全是 auto 的集成测试）随之删除。
 * 这份文件只救出一条**与 auto 无关**的回归护栏 —— 它防的是 `ctx.waterfall` 误用，
 * 与思考档位无关，删掉等于丢掉一条曾经真的炸过宿主的防线。
 *
 * 其余测试的归属：
 *   - auto 接管判据 / 阶梯投影 / 取数时序 → plugins/dsh-auto-reasoning（22 例）
 *   - 沙箱执行 → test/sandbox.test.js
 *   - bundle 声明 → test/bundle-declaration.test.js
 */

/** 只提供 apply() 真正会用到的服务；不给 llm/connection —— auto 已迁走，不该再依赖它们。 */
function makeCtx() {
  const ctx = new Context();
  ctx.provide('tools', { register() {} });
  ctx.provide('systemPrompt', { section() {}, getSectionOrder() { return 100; } });
  return ctx;
}

test('回归护栏: apply() 里禁止调用 ctx.waterfall(那是发射器, 曾把宿主炸成 fatal)', async () => {
  const ctx = makeCtx();
  const original = ctx.waterfall.bind(ctx);
  let calledDuringApply = 0;
  ctx.waterfall = (...args) => { calledDuringApply++; return original(...args); };
  apply(ctx, { collapseTopLevelTools: true });
  ctx.waterfall = original;
  assert.equal(calledDuringApply, 0,
    'apply() 期间出现了 ctx.waterfall(...) —— 注册监听要用 ctx.on, 用 waterfall 会让 dsh 启动即 fatal');
});

test('回归护栏: auto 迁走后 apply() 不再依赖 llm / connection 服务', async () => {
  // 上面的用例刻意不 provide('llm')。若日后有人又把档位逻辑塞回本插件，
  // 这里会先炸（ctx.llm 为 undefined），比等到线上才发现强。
  const ctx = makeCtx();
  assert.doesNotThrow(() => apply(ctx, { collapseTopLevelTools: true, injectGuidance: false }));
  assert.equal(ctx.llm, undefined);
  assert.equal(ctx.connection, undefined);
});