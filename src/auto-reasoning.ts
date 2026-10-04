/**
 * 自动思考程度 (Auto Reasoning Effort) 双阶决策引擎
 * 
 * 架构：
 * - L1 确定性特征旁路：极值/风控词/数学公式/量化指标极速响应
 * - L2 Jev 1.13 SystemOne 语义决策：调用 OpenCode Zen 的 jev-1.13 模型进行自然语言技术意图判定
 * - L3 规则阶梯兜底：网络异常或超时时无缝降级，保证 100% 可用性
 */

import { queryJevReasoningEffort, type JevClientOptions } from './jev-client.js';

export interface ReasoningEffortDecision {
  score: number;
  tier: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  reason: string;
  matchedEffort: string;
  source?: 'jev-model' | 'rule' | 'bypass';
  confidence?: number;
}

export interface ModelEffortLadder {
  modelId: string;
  availableEfforts: string[]; // escalation order, e.g. ['low', 'medium', 'high']
}

/**
 * 分析用户任务 Prompt，给出确定性复杂度评分 (1-10)
 */
export function scoreTaskComplexity(prompt: string): { score: number; reason: string } {
  const p = prompt.toLowerCase();

  // 1. 最高危特征 (Score 9-10) -> 架构设计、并发、死锁、资金风控、底层状态机、爆仓清算、逆运算合约
  if (
    /(并发|竞态|死锁|race condition|deadlock|状态机|state machine|资金安全|风控|清算|爆仓|liquidation|杠杆|leverage|逆向合约|inverse contract)/i.test(p)
  ) {
    return { score: 9, reason: 'concurrency_or_risk_critical' };
  }

  // 2. 深度推导特征 (Score 7-8) -> 算法、优化、数学推导、重构、性能排障、因子回测、滑点冲击模型
  if (
    /(算法|algorithm|优化|optimize|推导|证明|数学|formula|重构|refactor|memory leak|内存泄漏|core dump|崩溃|crash|perf|性能调优|回测|backtest|vwap|almgren|滑点|slippage|波动率|volatility|方差|covariance)/i.test(p)
  ) {
    return { score: 7, reason: 'algorithmic_or_deep_refactor' };
  }

  // 3. 常规开发特征 (Score 4-6) -> 编写测试、实现功能、单个文件修改、代码审查、脚本编写
  if (
    /(测试|test|编写|实现|implement|bug|修复|fix|审查|review|函数|function|脚本|script|组件|component|配置|config)/i.test(p)
  ) {
    return { score: 5, reason: 'standard_development_task' };
  }

  // 4. 低危日常特征 (Score 1-3) -> 简单问答、读取文件、语法查询、日志过滤、日常对话
  return { score: 2, reason: 'routine_lookup_or_query' };
}

/**
 * 根据模型实际支持的档位阶梯，投影出合法的思考档位 (动态适应 xhigh / max / high / medium / low)
 */
export function projectEffortOntoLadder(
  score: number,
  availableEfforts: string[] = ['low', 'medium', 'high']
): { target: string; tier: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' } {
  if (!availableEfforts || availableEfforts.length === 0) {
    return { target: 'medium', tier: 'medium' };
  }
  if (availableEfforts.length === 1) {
    return { target: availableEfforts[0], tier: availableEfforts[0] as any };
  }

  // 按得分决定理论意图
  let desiredTier: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'medium';
  if (score <= 1) desiredTier = 'minimal';
  else if (score <= 3) desiredTier = 'low';
  else if (score <= 6) desiredTier = 'medium';
  else if (score <= 8) desiredTier = 'high';
  else desiredTier = 'max';

  // 投影逻辑：优先精确匹配
  if (desiredTier === 'max' && availableEfforts.includes('max')) {
    return { target: 'max', tier: 'max' };
  }
  if ((desiredTier === 'max' || (desiredTier as string) === 'xhigh') && availableEfforts.includes('xhigh')) {
    return { target: 'xhigh', tier: 'xhigh' };
  }
  if ((desiredTier === 'max' || (desiredTier as string) === 'xhigh' || desiredTier === 'high') && availableEfforts.includes('high')) {
    return { target: 'high', tier: 'high' };
  }
  if (desiredTier === 'medium' && availableEfforts.includes('medium')) {
    return { target: 'medium', tier: 'medium' };
  }
  if (desiredTier === 'low' && availableEfforts.includes('low')) {
    return { target: 'low', tier: 'low' };
  }
  if ((desiredTier === 'low' || desiredTier === 'minimal') && availableEfforts.includes('minimal')) {
    return { target: 'minimal', tier: 'minimal' };
  }

  // 无法精确匹配时，按位置插值
  const ratio = Math.max(0, Math.min(1, (score - 1) / 9)); // 0.0 ~ 1.0
  const index = Math.min(
    availableEfforts.length - 1,
    Math.max(0, Math.floor(ratio * availableEfforts.length))
  );
  const matched = availableEfforts[index];
  return { target: matched, tier: matched as any };
}

/**
 * 映射 Jev 返回的 tier 到分值
 */
function tierToScore(tier: string): number {
  switch (tier) {
    case 'max': return 10;
    case 'xhigh': return 9;
    case 'high': return 8;
    case 'medium': return 5;
    case 'low': return 2;
    case 'minimal': return 1;
    default: return 5;
  }
}

/**
 * 同步决策链路 (基于规则与词表，用于单测与快速回退)
 */
export function decideReasoningEffort(
  prompt: string,
  availableEfforts: string[] = ['low', 'medium', 'high']
): ReasoningEffortDecision {
  const { score, reason } = scoreTaskComplexity(prompt);
  const { target, tier } = projectEffortOntoLadder(score, availableEfforts);

  return {
    score,
    tier,
    reason,
    matchedEffort: target,
    source: 'rule',
  };
}

/**
 * 双阶异步决策链路 (优先 Jev 1.13 语义模型，超时或失败回退到规则引擎)
 */
export async function decideReasoningEffortAsync(
  prompt: string,
  availableEfforts: string[] = ['low', 'medium', 'high'],
  jevOptions?: JevClientOptions
): Promise<ReasoningEffortDecision> {
  const trimmed = prompt.trim();
  // 极短输入或空文本直接走轻量规则
  if (!trimmed || trimmed.length < 4) {
    return decideReasoningEffort(prompt, availableEfforts);
  }

  // 单测或显式禁用时跳过远程 Jev 网络请求
  if (process.env.NODE_ENV === 'test' || process.env.DISABLE_JEV_REMOTE === '1') {
    return decideReasoningEffort(prompt, availableEfforts);
  }

  // 1. 调用 Jev 1.13 SystemOne
  try {
    const jevRes = await queryJevReasoningEffort(trimmed, jevOptions);
    if (jevRes && jevRes.tier) {
      const score = tierToScore(jevRes.tier);
      const { target, tier } = projectEffortOntoLadder(score, availableEfforts);
      return {
        score,
        tier,
        reason: jevRes.reason,
        matchedEffort: target,
        source: 'jev-model',
        confidence: jevRes.confidence,
      };
    }
  } catch {
    // 捕获所有异常并静默降级
  }

  // 2. 降级回规则
  return decideReasoningEffort(prompt, availableEfforts);
}
