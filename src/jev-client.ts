/**
 * Jev 1.13 SystemOne 语义决策客户端 (零外部依赖，使用 Node 18+ 原生 fetch 与环境变量代理支持)
 */

export interface JevDecisionResult {
  tier: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  confidence: number;
  reason: string;
  probabilities?: Record<string, number>;
  source: 'jev-model' | 'fallback-rule';
}

export interface JevClientOptions {
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  proxyUrl?: string;
}

const DEFAULT_ENDPOINT = 'https://opencode.ai/zen/v1/systemone';
const DEFAULT_MODEL = 'jev-1.13-free';
const DEFAULT_TIMEOUT_MS = 3500;

/**
 * 内存 LRU 语义决策缓存 (减少网络 IO 延迟，相同/高频任务 0ms 命中)
 */
const decisionCache = new Map<string, { result: JevDecisionResult; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5分钟有效期
const MAX_CACHE_SIZE = 100;

/**
 * 调用 Jev 1.13 SystemOne 判断任务所需的思考强度
 */
export async function queryJevReasoningEffort(
  prompt: string,
  options: JevClientOptions = {}
): Promise<JevDecisionResult | null> {
  const trimmed = prompt.trim();
  if (!trimmed) return null;

  const endpoint = options.endpoint || process.env.JEV_ENDPOINT || DEFAULT_ENDPOINT;
  const model = options.model || process.env.JEV_MODEL || DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  // 1. 查本地缓存 (以 endpoint + model + prompt 为组合键)
  const cacheKey = `${endpoint}:${model}:${trimmed.slice(0, 300)}`;
  const cached = decisionCache.get(cacheKey);
  if (cached) {
    if (Date.now() < cached.expiresAt) {
      return { ...cached.result };
    }
    decisionCache.delete(cacheKey);
  }

  const payload = JSON.stringify({
    model,
    state: trimmed.slice(0, 1500),
    questions: {
      effort: {
        type: 'choice',
        instructions: '根据任务内容判断解决该问题所需的思考推理深度与计算复杂度',
        criteria: {
          low: '简单问答、文件查看、语法查询、日志检索、打招呼',
          medium: '常规业务代码开发、Bug修改、简单功能实现、单测编写',
          high: '算法实现与调优、数学公式推导、复杂重构、架构设计、深度故障根因排查',
          max: '高危并发、分布式死锁、资金风控底层状态机、爆仓清算'
        }
      }
    }
  });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'dsh-plugin-codemode/0.1.1'
      },
      body: payload,
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!resp.ok) {
      return null;
    }

    const data: any = await resp.json();
    const ans = data?.answers?.effort;
    if (!ans || typeof ans.choice !== 'string') {
      return null;
    }

    const tier = ans.choice as 'low' | 'medium' | 'high' | 'max';
    const result: JevDecisionResult = {
      tier,
      confidence: typeof ans.confidence === 'number' ? ans.confidence : 1.0,
      reason: `jev1.3_choice_${tier}`,
      probabilities: ans.probabilities,
      source: 'jev-model'
    };

    // 写缓存并维持上限
    if (decisionCache.size >= MAX_CACHE_SIZE) {
      const oldest = decisionCache.keys().next().value;
      if (oldest) decisionCache.delete(oldest);
    }
    decisionCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });

    return result;
  } catch {
    return null;
  }
}
