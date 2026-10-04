import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { apply, AUTO_EFFORT_SENTINEL, AUTO_DECISION_CAP, lastUserPromptText, promptFromEvents, promptFromFrozenMessages, promptFromInbox, scoreTaskComplexity } from '../lib/index.js';

/**
 * agent/request 上 Auto Reasoning Effort 的集成测试。
 * 用真实 cordis 的事件调度器(不是自造 mock 调度), 保证 prepend / next() / 返回值
 * 线程化这些行为与宿主里一致。
 */

const GEMINI_LADDER = ['low', 'medium', 'high'];

function makeCtx({ ladder = GEMINI_LADDER, resolveThrows = false, resolveModelInfo, withFetch = false } = {}) {
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
  if (withFetch) {
    const routes = [];
    ctx.provide('connection', { fetch: { register: (route) => { routes.push(route); return async () => {}; } } });
    ctx.__routes = routes;
  }
  return ctx;
}

/** 触发一次真实宿主调用并读回该会话归档的决策。 */
async function decideFor(ctx, sessionId, promptText) {
  await emitAgentRequest(
    ctx,
    { turn: 1, step: 0, agent: { id: sessionId, session: makeSession(promptText) } },
    { provider: 'opencodex', model: 'google-antigravity/gemini-3.8-flash', reasoningEffort: AUTO_EFFORT_SENTINEL },
  );
}

async function readRoute(ctx, sessionId) {
  const route = ctx.__routes[0];
  const url = 'http://local/api/codemode.auto-effort' + (sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`);
  const res = await route.fetch(new Request(url));
  return await res.json();
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

// ── 注入消息回归护栏 ──────────────────────────────────────────────────────────
// 缺陷(2026-10-04 浏览器端到端实测): DSH 把 AGENTS.md / 运行时快照 / 技能目录
// 也当成 role=user 的消息注入, 而且**排在真实提示词之后**。
// 只按 role 取「最后一条 user 文本」会取到技能目录 -> scoreTaskComplexity 恒为 2
// -> 每次都是 low, 表现为「Auto 永远是 low」。
// 官方判据 = message.source.kind: 真实输入是 'user', 其余三类是注入。

test('回归: 注入消息不得顶掉真实提示词(否则 Auto 恒为 low)', () => {
  const REAL = '分析这个模块的并发竞态与死锁,涉及资金风控清算';
  const session = {
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: REAL }] },
      { role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: '<system-reminder>…AGENTS.md…' }] },
      { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context. …' }] },
      { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '<system-reminder>…skills…' }] },
    ],
  };
  assert.equal(lastUserPromptText(session), REAL);
  assert.equal(scoreTaskComplexity(REAL).score, 9, '真实提示词应评 9 分');
  assert.equal(scoreTaskComplexity(lastUserPromptText(session)).score, 9, '取到注入文本就会掉回 2 分');
});

test('回归: 只有注入消息时返回空串, 不把技能目录当提示词', () => {
  const session = {
    deriveMessages: () => [
      { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '…技能…' }] },
    ],
  };
  assert.equal(lastUserPromptText(session), '');
});

// ── 取数时机回归护栏 ──────────────────────────────────────────────────────────
// 缺陷(2026-10-04 真实宿主实测): agent/request 触发时 agent.session.deriveMessages()
// 返回 **0 条消息** —— 用户消息还没投影进 surface(端点诊断实测
// {"hasSession":true,"hasDerive":true,"total":0})。
// 所以只靠 deriveMessages 取提示词必然拿到空串 -> scoreTaskComplexity 恒为 2 -> Auto 恒为 low。
// 修法: 订阅 session/event(官方 dsh-session-title 用的同一事件 + 同一 kind 判据)
// 增量缓存最后一条真实人类消息, agent/request 时读缓存。

test('回归: deriveMessages 为空时, 靠 session/event 缓存取到真实提示词', async () => {
  const ctx = makeCtx();
  apply(ctx, { autoReasoning: true });

  const session = { id: 'session-empty', deriveMessages: () => [] };   // 复刻真实宿主
  ctx.emit('session/event', session, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '处理并发竞态与死锁, 涉及资金风控清算' }] },
  });
  // 三条注入排在真实提示词之后, 且文本是低分文本 —— 过滤失效就会掉回 low
  for (const kind of ['agent-instructions', 'runtime-context', 'skill-catalog']) {
    ctx.emit('session/event', session, {
      type: 'user/message',
      data: { source: { kind }, content: [{ type: 'text', text: '帮我看看这行日志什么意思' }] },
    });
  }

  const out = await emitAgentRequest(
    ctx,
    { turn: 1, step: 0, agent: { id: 'session-empty', session } },
    { provider: 'opencodex', model: 'google-antigravity/gemini-3.8-flash', reasoningEffort: AUTO_EFFORT_SENTINEL },
  );
  assert.equal(out.reasoningEffort, 'high', '缓存到真实提示词应评 9 分并投影到 high');
});

// ── 取数源回归护栏(第三层, 真正的修法) ────────────────────────────────────────
// 缺陷(2026-10-04 三次重启才定位): agent/request 发在 dsh-agent-loop/lib/index.js:1179,
// 而 session.deriveMessages() 要到 L1262 才拼本轮 messages —— 用户消息在这两步【之间】
// 才被 splice 进会话日志。所以请求时刻 deriveMessages / snapshotEvents / session/event
// 三条路【全都】取不到本轮提示词(实测 promptSource 恒为 <none>)。
// 唯一有货的是 agent.inbox.nextTurn(持久 inbox 投影, 见 ReactLoopInbox)。

test('promptFromInbox: 从 agent.inbox.nextTurn 取待处理用户输入', () => {
  const agent = {
    inbox: {
      nextTurn: [
        { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '处理并发竞态与死锁' }] },
      ],
      nextStep: [],
    },
  };
  assert.equal(promptFromInbox(agent), '处理并发竞态与死锁');
});

test('promptFromInbox: nextTurn 空时退到 nextStep, 且跳过注入消息', () => {
  const agent = {
    inbox: {
      nextTurn: [],
      nextStep: [
        { id: 'a', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '真实提问' }] },
        { id: 'b', role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '技能目录' }] },
      ],
    },
  };
  assert.equal(promptFromInbox(agent), '真实提问');
  assert.equal(promptFromInbox({}), '', '没有 inbox 时安全返回空串');
  assert.equal(promptFromInbox(undefined), '');
  assert.equal(promptFromInbox({ inbox: null }), '');
});

test('回归: 三条旧路全空时, 靠 agent.inbox 仍能评出 high 并分流到 high', async () => {
  const ctx = makeCtx();
  apply(ctx, { autoReasoning: true });
  // 复刻真实宿主: surface 空、事件日志不含本轮消息、无缓存
  const session = { id: 'session-inbox-only', deriveMessages: () => [], snapshotEvents: () => [] };
  const agent = {
    id: 'session-inbox-only',
    session,
    inbox: {
      nextTurn: [{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '分析这个模块的并发竞态与死锁,涉及资金风控清算' }] }],
      nextStep: [],
    },
  };
  const out = await emitAgentRequest(
    ctx,
    { turn: 1, step: 0, agent },
    { provider: 'opencodex', model: 'google-antigravity/gemini-3.8-flash', reasoningEffort: AUTO_EFFORT_SENTINEL },
  );
  assert.equal(out.reasoningEffort, 'high');
});

// ── 主路径: agent/inbox/spliced ───────────────────────────────────────────────
// dsh-agent-loop/lib/index.js 的硬时序(读源码定案, 三次重启逐条排除后):
//   L906  inbox.claim()            从 inbox 取走本轮输入
//   L1050 prepareRequest() → L1179 waterfall("agent/request")   ← 挂载点
//   L1061 session.append("user/message")                        ← 之后才落盘
// 所以请求那一刻本轮提示词被 loop 攥在局部变量里, deriveMessages / snapshotEvents /
// inbox / user-message 四条路全空。唯一早于它的是用户提交时的 inbox 写入事件。

test('主路径: agent/inbox/spliced 在请求前就把提示词缓存好了', async () => {
  const ctx = makeCtx();
  apply(ctx, { autoReasoning: true });

  const session = { id: 'session-inbox-splice', deriveMessages: () => [], snapshotEvents: () => [] };
  // 用户提交那一刻写入 inbox(早于回合开始, 也早于任何请求)
  ctx.emit('session/event', session, {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-turn',
      start: 0,
      removedCount: 0,
      inserted: [
        { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '处理并发竞态与死锁, 涉及资金风控清算' }] },
      ],
    },
  });

  const out = await emitAgentRequest(
    ctx,
    { turn: 1, step: 0, agent: { id: 'session-inbox-splice', session } },
    { provider: 'opencodex', model: 'google-antigravity/gemini-3.8-flash', reasoningEffort: AUTO_EFFORT_SENTINEL },
  );
  assert.equal(out.reasoningEffort, 'high', '复杂提示词应评 9 分并投影到 high');
});

test('agent/inbox/spliced: 只认 next-turn, 且跳过注入 kind', async () => {
  const ctx = makeCtx({ withFetch: true });
  apply(ctx, { autoReasoning: true });

  const session = { id: 'session-splice-filter', deriveMessages: () => [] };
  // next-step 目标不算用户回合输入
  ctx.emit('session/event', session, {
    type: 'agent/inbox/spliced',
    data: { target: 'next-step', start: 0, removedCount: 0, inserted: [
      { id: 'x', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '处理并发竞态与死锁' }] },
    ] },
  });
  // next-turn 但都是注入 kind
  ctx.emit('session/event', session, {
    type: 'agent/inbox/spliced',
    data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [
      { id: 'y', role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '处理并发竞态与死锁' }] },
    ] },
  });
  // 真实输入
  ctx.emit('session/event', session, {
    type: 'agent/inbox/spliced',
    data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [
      { id: 'z', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好,这行日志什么意思' }] },
    ] },
  });

  await emitAgentRequest(ctx, { turn: 1, step: 0, agent: { id: 'session-splice-filter', session } },
    { provider: 'opencodex', model: 'google-antigravity/gemini-3.8-flash', reasoningEffort: AUTO_EFFORT_SENTINEL });
  const data = await readRoute(ctx, 'session-splice-filter');
  assert.equal(data.decision.effort, 'low', '只应缓存最后那条真实简单输入');
});

// ── 每轮重评 ──────────────────────────────────────────────────────────────────
// dsh-agent-loop:1174 首次请求 seed 来自 AgentOptions(auto), 之后来自持久 header(我上次写的值)。
// 所以"上一轮我定的档位"会以 incoming 的身份回来 —— 认出这个回音就能每轮重评。

test('每轮重评: 同会话第二轮 incoming 是我上次写的档位 -> 重新评估换档', async () => {
  const ctx = makeCtx({ withFetch: true });
  apply(ctx, { autoReasoning: true });
  const session = { id: 'session-reeval', deriveMessages: () => [] };
  const seed = (effort) => ({ provider: 'opencodex', model: 'google-antigravity/gemini-3.8-flash', reasoningEffort: effort });

  // 第一轮: 简单
  ctx.emit('session/event', session, {
    type: 'agent/inbox/spliced',
    data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [
      { id: 'a', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好,这行日志什么意思' }] },
    ] },
  });
  const first = await emitAgentRequest(ctx, { turn: 1, step: 0, agent: { id: 'session-reeval', session } }, seed(AUTO_EFFORT_SENTINEL));
  assert.equal(first.reasoningEffort, 'low');

  // 第二轮: 换成复杂提示词; incoming 是上一轮写进去的 low
  ctx.emit('session/event', session, {
    type: 'agent/inbox/spliced',
    data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [
      { id: 'b', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '处理并发竞态与死锁, 涉及资金风控清算' }] },
    ] },
  });
  const second = await emitAgentRequest(ctx, { turn: 2, step: 0, agent: { id: 'session-reeval', session } }, seed('low'));
  assert.equal(second.reasoningEffort, 'high', '第二轮应重评为 high');
  const data = await readRoute(ctx, 'session-reeval');
  assert.equal(data.decision.effort, 'high', '归档也应更新为 high');
});

test('用户手选档位不被接管(不等于本插件上次写的值)', async () => {
  const ctx = makeCtx({ withFetch: true });
  apply(ctx, { autoReasoning: true });
  const session = { id: 'session-userpick', deriveMessages: () => [] };
  const seed = (effort) => ({ provider: 'opencodex', model: 'google-antigravity/gemini-3.8-flash', reasoningEffort: effort });
  ctx.emit('session/event', session, {
    type: 'agent/inbox/spliced',
    data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [
      { id: 'a', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '处理并发竞态与死锁, 涉及资金风控清算' }] },
    ] },
  });
  const first = await emitAgentRequest(ctx, { turn: 1, step: 0, agent: { id: 'session-userpick', session } }, seed(AUTO_EFFORT_SENTINEL));
  assert.equal(first.reasoningEffort, 'high');

  // 用户手选 max: 既不是哨兵, 也不等于我上次写的 high -> 必须原样放行
  const second = await emitAgentRequest(ctx, { turn: 2, step: 0, agent: { id: 'session-userpick', session } }, seed('max'));
  assert.equal(second.reasoningEffort, 'max', '用户手选必须原样保留');
});

test('回归: 缓存按会话隔离, 不跨会话串提示词', async () => {
  const ctx = makeCtx({ withFetch: true });
  apply(ctx, { autoReasoning: true });

  const mk = (id, text) => {
    const session = { id, deriveMessages: () => [] };
    ctx.emit('session/event', session, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
    });
    return session;
  };
  const a = mk('sess-cache-a', '处理并发竞态与死锁, 涉及资金风控清算');
  const b = mk('sess-cache-b', '帮我看看这行日志什么意思');

  await emitAgentRequest(ctx, { turn: 1, step: 0, agent: { id: 'sess-cache-a', session: a } },
    { provider: 'opencodex', model: 'google-antigravity/gemini-3.8-flash', reasoningEffort: AUTO_EFFORT_SENTINEL });
  await emitAgentRequest(ctx, { turn: 1, step: 0, agent: { id: 'sess-cache-b', session: b } },
    { provider: 'opencodex', model: 'google-antigravity/gemini-3.8-flash', reasoningEffort: AUTO_EFFORT_SENTINEL });

  assert.equal((await readRoute(ctx, 'sess-cache-a')).decision.effort, 'high');
  assert.equal((await readRoute(ctx, 'sess-cache-b')).decision.effort, 'low');
});

// ── 取数源回归护栏(第二层) ────────────────────────────────────────────────────
// 缺陷(2026-10-04 真实宿主实测): 订阅 session/event 也晚了 —— 端点诊断显示
//   某会话自己发请求时, 缓存里只有【上一个】会话; 该会话的 user/message 事件
//   排在它自己的 agent/request 之后。所以必须找请求【之前】就有内容的源。
// 实测同一时刻 session.snapshotEvents() 已有 57 条事件, agent 上还挂着 frozenMessages。

test('promptFromEvents: 从原始事件日志倒序取最后一条 source.kind=user 的消息', () => {
  const session = {
    snapshotEvents: () => [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一问' }] } },
      { type: 'assistant/message', data: {} },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二问:处理并发竞态与死锁' }] } },
      // 三条注入排在真实提示词之后 —— 判据失效就会取到这些低分文本
      { type: 'user/message', data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: '帮我看看这行日志' }] } },
      { type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '帮我看看这行日志' }] } },
      { type: 'user/message', data: { source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '帮我看看这行日志' }] } },
    ],
  };
  assert.equal(promptFromEvents(session), '第二问:处理并发竞态与死锁');
  assert.equal(promptFromEvents({ snapshotEvents: () => [] }), '');
  assert.equal(promptFromEvents(undefined), '');
  assert.equal(promptFromEvents({}), '', '没有 snapshotEvents 时必须安全返回空串');
});

test('promptFromFrozenMessages: 从本轮冻结消息里取最后一条真实用户文本', () => {
  const agent = {
    frozenMessages: [
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '真实提示词' }] },
      { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '技能目录' }] },
    ],
  };
  assert.equal(promptFromFrozenMessages(agent), '真实提示词');
  assert.equal(promptFromFrozenMessages({}), '');
  assert.equal(promptFromFrozenMessages(undefined), '');
});

test('回归: deriveMessages 为空 + 无缓存时, 靠原始事件日志仍能评出 high', async () => {
  const ctx = makeCtx();
  apply(ctx, { autoReasoning: true });
  const session = {
    id: 'session-events-only',
    deriveMessages: () => [],
    snapshotEvents: () => [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '处理并发竞态与死锁, 涉及资金风控清算' }] } },
      { type: 'user/message', data: { source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '帮我看看这行日志什么意思' }] } },
    ],
  };
  const out = await emitAgentRequest(
    ctx,
    { turn: 1, step: 0, agent: { id: 'session-events-only', session } },
    { provider: 'opencodex', model: 'google-antigravity/gemini-3.8-flash', reasoningEffort: AUTO_EFFORT_SENTINEL },
  );
  assert.equal(out.reasoningEffort, 'high');
});

// ── 会话隔离回归护栏 ──────────────────────────────────────────────────────────
// 缺陷: 决策曾存进单个模块级变量, 全局 agent/request 瀑布让所有会话的胶囊
// 显示同一条"最近一次"记录。修法是按 sessionId 归档。

test('回归: 两个会话各自归档, 端点按 sessionId 返回对应决策', async () => {
  const ctx = makeCtx({ withFetch: true });
  apply(ctx, { autoReasoning: true });

  await decideFor(ctx, 'sess-A', '处理并发竞态与死锁, 涉及资金风控清算');   // -> 9/10 high
  await decideFor(ctx, 'sess-B', '帮我看看这行日志什么意思');               // -> 2/10 low

  const a = await readRoute(ctx, 'sess-A');
  const b = await readRoute(ctx, 'sess-B');

  assert.equal(a.decision.sessionId, 'sess-A');
  assert.equal(a.decision.effort, 'high');
  assert.equal(b.decision.sessionId, 'sess-B');
  assert.equal(b.decision.effort, 'low');
  assert.notEqual(a.decision.effort, b.decision.effort, '两个会话必须拿到各自的档位, 不能共享同一条记录');
  assert.deepEqual(a.sessions, ['sess-A', 'sess-B']);
});

test('回归: 未知 sessionId 返回 null, 不串到别的会话', async () => {
  const ctx = makeCtx({ withFetch: true });
  apply(ctx, { autoReasoning: true });
  await decideFor(ctx, 'sess-A', '处理并发竞态与死锁');

  const unknown = await readRoute(ctx, 'sess-never-seen');
  assert.equal(unknown.decision, null, '没决策过的会话必须返回 null, 不能回落到最近一条');

  const noParam = await readRoute(ctx, undefined);
  assert.equal(noParam.decision.sessionId, 'sess-A', '不带 sessionId 时才回落到最近一条(向后兼容)');
});

test('回归: 会话 id 归档上限有界, 不会无限增长', async () => {
  const ctx = makeCtx({ withFetch: true });
  apply(ctx, { autoReasoning: true });
  for (let i = 0; i < AUTO_DECISION_CAP + 5; i++) await decideFor(ctx, `sess-${i}`, '处理并发竞态');

  const data = await readRoute(ctx, undefined);
  assert.equal(data.sessions.length, AUTO_DECISION_CAP);
  assert.equal(data.sessions[0], 'sess-5', '淘汰的是最旧的会话');
  assert.equal(data.sessions[AUTO_DECISION_CAP - 1], `sess-${AUTO_DECISION_CAP + 4}`);
});

test('回归: 载荷没有 agent 时退回 cordis initiator 边界取会话', async () => {
  const ctx = makeCtx({ withFetch: true });
  apply(ctx, { autoReasoning: true });
  ctx.provide('agents', {
    currentInitiator: () => ({ id: 'sess-from-initiator', session: makeSession('处理并发竞态与死锁') }),
  });

  // 复刻真实宿主: dsh-agent-loop 发射的载荷只有 {turn, step, signal}, 没有 agent
  await emitAgentRequest(
    ctx,
    { turn: 1, step: 0 },
    { provider: 'opencodex', model: 'google-antigravity/gemini-3.8-flash', reasoningEffort: AUTO_EFFORT_SENTINEL },
  );

  const data = await readRoute(ctx, 'sess-from-initiator');
  assert.equal(data.decision.sessionId, 'sess-from-initiator');
  assert.equal(data.decision.effort, 'high');
  assert.equal(data.lastAgentSource, 'initiator');
});
