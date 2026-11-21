import type { Redis } from 'ioredis';
import type { ToolCallRequest, ToolCaller } from './llm';
import { logger } from './logger';

export class LlmBudgetExceededError extends Error {
  constructor(limit: number) {
    super(`LLM daily call limit (${limit}) reached`);
    this.name = 'LlmBudgetExceededError';
  }
}

const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;

/** Redis key for the UTC day's LLM call counter, e.g. `llm:calls:2026-11-21`. */
export function budgetKey(now: Date): string {
  return `llm:calls:${now.toISOString().slice(0, 10)}`;
}

/**
 * Daily cost guard shared by every LLM use (natural-language parser, duplicate
 * judge). Each call increments a per-UTC-day counter in Redis; over the limit,
 * or if the counter can't be read, the call is refused (fail closed) and the
 * caller falls back to its deterministic path (rules parser / similarity verdict).
 */
export class BudgetedToolCaller implements ToolCaller {
  constructor(
    private readonly inner: ToolCaller,
    private readonly redis: Redis,
    private readonly dailyLimit: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get provider(): ToolCaller['provider'] {
    return this.inner.provider;
  }

  get model(): string {
    return this.inner.model;
  }

  async callTool(req: ToolCallRequest): Promise<unknown> {
    const key = budgetKey(this.now());
    let calls: number;
    try {
      calls = await this.redis.incr(key);
      if (calls === 1) await this.redis.expire(key, TWO_DAYS_SECONDS);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'LLM budget counter unavailable; refusing LLM call',
      );
      throw new LlmBudgetExceededError(this.dailyLimit);
    }
    if (calls > this.dailyLimit) {
      logger.warn(
        { limit: this.dailyLimit, calls, key },
        'LLM daily call limit reached; using fallback',
      );
      throw new LlmBudgetExceededError(this.dailyLimit);
    }
    return this.inner.callTool(req);
  }
}
