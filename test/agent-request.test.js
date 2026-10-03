import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { apply, AUTO_EFFORT_SENTINEL, lastUserPromptText } from '../lib/index.js';

/**
 * agent/request 上 Auto Reasoning Effort 的集成测试。
 * 用真实 cordis 的事件调度器(不是自造 mock 调度), 保证 prepend / next() / 返回值
 * 线程化这些行为与宿主里一致。
 */

const GEMINI_LADDER = ['low', 'medium', 'high'];

function makeCtx({ ladder = GEMINI_LADDER, resolveThrows = false, resolveModelInfo } = {}) {
  const ctx = new Context();
  ctx.provide('tools', { register() {} });
  ctx.provide('systemPrompt', { section() {}, getSectionOrder() { return 100; } });
  ctx.provide('llm', {
    resolveModelInfo: resolveModelInfo ?? (async () => {
      if (resolveThrows) throw new Error('boom: provider unavailable');
      if (ladder === null) return { reasoning: undefined };
      return { reasoning: { efforts: ladder.map((id) => ({ id, name: id })) } };
    }),
  });
  return ctx;
}

function makeSession(promptText) {
  return {
    id: 'session-test',
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: promptText }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ],
  };
}

/** 复刻宿主 dsh-agent-loop 的发射方式: carrier + 事件名 + payload + 最内层终端。 */
async function emitAgentRequest(ctx, payload, seedConfig) {
  return await ctx.waterfall('agent/request', payload, () => Promise.resolve(seedConfig));
}

test('auto 哨兵被换成本模型合法档位(复杂任务 -> high)', async () => {
  const ctx = makeCtx();
  apply(ctx, { autoReasoning: true });
  const out = await emitAgentRequest(
    ctx,
    { turn: 1, step: 0, agent: { session: makeSession('处理并发竞态与死锁, 涉及资金风控清算') } },
    { provider: 'opencodex', model: 'google-antigravity/gemini-3.8-flash', reasoningEffort: AUTO_EFFORT_SENTINEL },
  );
  assert.ok(GEMINI_LADDER.includes(out.reasoningEffort), `档位必须落在阶梯内, 实际 ${out.reasoningEffort}`);
  assert.equal(out.reasoningEffort, 'high');
});

test('auto 哨兵: 简单任务降到 low', async () => {
  const ctx = makeCtx();
  apply(ctx, { autoReasoning: true });
  const out = await emitAgentRequest(
    ctx,
    { turn: 1, step: 0, agent: { session: makeSession('帮我看看这行日志什么意思') } },
    { provider: 'opencodex', model: 'google-antigravity/gemini-3.8-flash', reasoningEffort: AUTO_EFFORT_SENTINEL },
  );
  assert.equal(out.reasoningEffort, 'low');
});

test('用户显式选的档位不被接管', async () => {
  const ctx = makeCtx();
  apply(ctx, { autoReasoning: true });
  const out = await emitAgentRequest(
    ctx,
    { turn: 1, step: 0, agent: { session: makeSession('处理并发竞态与死锁') } },
    { provider: 'opencodex', model: 'x', reasoningEffort: 'medium' },
  );
  assert.equal(out.reasoningEffort, 'medium');
});

test('模型无思考档位时省略 reasoningEffort, 绝不把 auto 交回宿主', async () => {
  const ctx = makeCtx({ ladder: null });
  apply(ctx, { autoReasoning: true });
  const out = await emitAgentRequest(
    ctx,
    { turn: 1, step: 0, agent: { session: makeSession('随便') } },
    { provider: 'opencodex', model: 'non-reasoning', reasoningEffort: AUTO_EFFORT_SENTINEL },
  );
  assert.equal('reasoningEffort' in out, false);
});

test('resolveModelInfo 抛错时兜底省略档位(不能让请求带着 auto 去死)', async () => {
  const ctx = makeCtx({ resolveThrows: true });
  apply(ctx, { autoReasoning: true });
  const out = await emitAgentRequest(
    ctx,
    { turn: 1, step: 0, agent: { session: makeSession('随便') } },
    { provider: 'opencodex', model: 'x', reasoningEffort: AUTO_EFFORT_SENTINEL },
  );
  assert.equal('reasoningEffort' in out, false);
});

test('prepend 生效: 档位按【最终模型】的阶梯投影, 而不是种子模型', async () => {
  // 种子模型只给 low; 更内层的监听(模拟 dsh-agent 的模型选择)把模型换成 wide。
  // 若本插件不是最外层, 就会拿种子模型的阶梯去投影 -> 'low'; 是外层才看得到最终模型 -> 'high'。
  const ladders = { narrow: ['low'], wide: ['low', 'medium', 'high'] };
  const ctx = makeCtx({
    resolveModelInfo: async (_provider, model) => ({
      reasoning: { efforts: ladders[model].map((id) => ({ id, name: id })) },
    }),
  });
  apply(ctx, { autoReasoning: true });
  ctx.on('agent/request', async (_payload, next) => {
    const inner = await next();
    return { ...inner, model: 'wide' };
  });
  const out = await emitAgentRequest(
    ctx,
    { turn: 1, step: 0, agent: { session: makeSession('处理并发竞态与死锁, 资金风控') } },
    { provider: 'opencodex', model: 'narrow', reasoningEffort: AUTO_EFFORT_SENTINEL },
  );
  assert.equal(out.model, 'wide');
  assert.equal(out.reasoningEffort, 'high', '应针对最终模型 wide 的阶梯投影, 得到 high 而非 narrow 的 low');
});

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

test('开关关闭时一律不接管(默认行为)', async () => {
  const ctx = makeCtx();
  apply(ctx, {});                       // 不传 autoReasoning
  const out = await emitAgentRequest(
    ctx,
    { turn: 1, step: 0, agent: { session: makeSession('处理并发竞态与死锁') } },
    { provider: 'opencodex', model: 'x', reasoningEffort: AUTO_EFFORT_SENTINEL },
  );
  assert.equal(out.reasoningEffort, AUTO_EFFORT_SENTINEL, '未开启就该原样放行');
});

test('档位缺失时不接管(实测 Web 新会话送进来的是 auto 而非 absent)', async () => {
  const ctx = makeCtx();
  apply(ctx, { autoReasoning: true });
  const out = await emitAgentRequest(
    ctx,
    { turn: 1, step: 0, agent: { session: makeSession('处理并发竞态与死锁, 资金风控清算') } },
    { provider: 'opencodex', model: 'google-antigravity/gemini-3.8-flash' },
  );
  assert.equal('reasoningEffort' in out, false, '没人选过档位就交回宿主，让模型用自己的默认档');
});

test('lastUserPromptText 取最后一条 user 文本, 跳过非文本块', () => {
  const session = {
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: '第一问' }] },
      { role: 'assistant', content: [{ type: 'text', text: '答' }] },
      { role: 'user', content: [{ type: 'image' }, { type: 'text', text: '第二问' }] },
    ],
  };
  assert.equal(lastUserPromptText(session), '第二问');
  assert.equal(lastUserPromptText(undefined), '');
  assert.equal(lastUserPromptText({ deriveMessages: () => [] }), '');
});
