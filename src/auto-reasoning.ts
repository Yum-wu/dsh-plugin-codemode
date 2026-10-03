/**
 * 自动思考程度 (Auto Reasoning Effort) 自适应分类与映射引擎
 * 
 * 业界开源参考与规范对齐：
 * - luckeyfaraday/auto-reasoning (MIT License): 确定性任务复杂度评分标尺 (Score 1-10)
 * - ruban-24/switchboard (MIT License): 模型感知的阶梯投影与 Auto (<level>) 约定
 */

export interface ReasoningEffortDecision {
  score: number;
  tier: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  reason: string;
  matchedEffort: string;
  auditLabel: string;
}

export interface ModelEffortLadder {
  modelId: string;
  availableEfforts: string[]; // escalation order, e.g. ['low', 'medium', 'high']
}

/**
 * 分析用户首轮任务 Prompt，给出确定性复杂度评分 (1-10)
 */
export function scoreTaskComplexity(prompt: string): { score: number; reason: string } {
  const p = prompt.toLowerCase();

  // 1. 最高危特征 (Score 9-10) -> 架构设计、并发、死锁、资金风控、底层状态机
  if (
    /(并发|竞态|死锁|race condition|deadlock|状态机|state machine|资金安全|风控|清算|爆仓|liquidation|杠杆|leverage)/i.test(p)
  ) {
    return { score: 9, reason: 'concurrency_or_risk_critical' };
  }

  // 2. 深度推导特征 (Score 7-8) -> 数学推导、算法分析、大型重构、跨模块排障
  if (
    /(推导|证明|数学|formula|algorithm|重构|refactor|memory leak|内存泄漏|core dump|崩溃|crash)/i.test(p)
  ) {
    return { score: 7, reason: 'algorithmic_or_deep_refactor' };
  }

  // 3. 常规开发特征 (Score 4-6) -> 编写测试、实现功能、单个文件修改、代码审查
  if (
    /(测试|test|编写|实现|implement|bug|修复|fix|审查|review|函数|function)/i.test(p)
  ) {
    return { score: 5, reason: 'standard_development_task' };
  }

  // 4. 低危日常特征 (Score 1-3) -> 简单问答、读取文件、语法查询、日志过滤
  return { score: 2, reason: 'routine_lookup_or_query' };
}

/**
 * 根据模型实际支持的档位阶梯，投影出合法的思考档位 (动态适应 xhigh / max / high / medium / low)
 */
export function projectEffortOntoLadder(
  score: number,
  availableEfforts: string[] = ['low', 'medium', 'high']
): { target: string; tier: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' } {
  // 如果模型不提供阶梯或只有 1 档，直接返回该档位
  if (!availableEfforts || availableEfforts.length === 0) {
    return { target: 'medium', tier: 'medium' };
  }
  if (availableEfforts.length === 1) {
    return { target: availableEfforts[0], tier: availableEfforts[0] as any };
  }

  // 按得分决定理论意图
  let desiredTier: 'low' | 'medium' | 'high' | 'max' = 'medium';
  if (score <= 3) desiredTier = 'low';
  else if (score <= 6) desiredTier = 'medium';
  else if (score <= 8) desiredTier = 'high';
  else desiredTier = 'max';

  // 投影逻辑：优先精确匹配
  if (desiredTier === 'max' && availableEfforts.includes('max')) {
    return { target: 'max', tier: 'max' };
  }
  if (desiredTier === 'max' && availableEfforts.includes('xhigh')) {
    return { target: 'xhigh', tier: 'xhigh' };
  }
  if ((desiredTier === 'max' || desiredTier === 'high') && availableEfforts.includes('high')) {
    return { target: 'high', tier: 'high' };
  }
  if (desiredTier === 'medium' && availableEfforts.includes('medium')) {
    return { target: 'medium', tier: 'medium' };
  }
  if (desiredTier === 'low' && availableEfforts.includes('low')) {
    return { target: 'low', tier: 'low' };
  }
  if (desiredTier === 'low' && availableEfforts.includes('minimal')) {
    return { target: 'minimal', tier: 'minimal' };
  }

  // 无法精确匹配时，按位置插值
  const ratio = (score - 1) / 9; // 0.0 ~ 1.0
  const index = Math.min(
    availableEfforts.length - 1,
    Math.max(0, Math.floor(ratio * availableEfforts.length))
  );
  const matched = availableEfforts[index];
  return { target: matched, tier: matched as any };
}

/**
 * 完整决策链路
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
    auditLabel: `Auto (${target})`,
  };
}
