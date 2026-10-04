import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideReasoningEffort, decideReasoningEffortAsync } from '../lib/auto-reasoning.js';
import { queryJevReasoningEffort } from '../lib/jev-client.js';

describe('Jev 1.13 双阶决策与集成测试', () => {
  it('规则层: 中文"算法"与"优化"正确识别为 high', () => {
    const res = decideReasoningEffort('这2个插件的算法还能优化吗', ['low', 'medium', 'high']);
    assert.equal(res.matchedEffort, 'high');
    assert.equal(res.score, 7);
  });

  it('Jev 客户端: 真实调用 systemone 端点返回 high', async () => {
    // 允许调用真实网络
    delete process.env.NODE_ENV;
    delete process.env.DISABLE_JEV_REMOTE;
    const res = await queryJevReasoningEffort('这2个插件的算法还能优化吗', { timeoutMs: 12000 });
    assert.ok(res !== null, 'Jev 返回不应为空');
    assert.equal(res.tier, 'high');
    assert.equal(res.source, 'jev-model');
  });

  it('双阶异步链路: 真实语义命中 Jev 模型决策', async () => {
    delete process.env.NODE_ENV;
    delete process.env.DISABLE_JEV_REMOTE;
    const decision = await decideReasoningEffortAsync('这2个插件的算法还能优化吗', ['low', 'medium', 'high']);
    assert.equal(decision.matchedEffort, 'high');
    assert.equal(decision.source, 'jev-model');
  });

  it('双阶异步链路: 模拟超时失败时无缝降级到规则层', async () => {
    const decision = await decideReasoningEffortAsync('这2个插件的算法还能优化吗', ['low', 'medium', 'high'], {
      endpoint: 'https://127.0.0.1:9999/invalid',
      timeoutMs: 50
    });
    assert.equal(decision.matchedEffort, 'high');
    assert.equal(decision.source, 'rule');
  });
});
