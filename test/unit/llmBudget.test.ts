import { MockActivityEnvironment } from '@temporalio/testing';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { AskService, LlmQueryParser, RulesQueryParser } from '../../src/api/services/askService';
import type { HotelService } from '../../src/api/services/hotelService';
import type { ToolCaller } from '../../src/infra/llm';
import { BudgetedToolCaller, LlmBudgetExceededError, budgetKey } from '../../src/infra/llmBudget';
import type { HotelRepository } from '../../src/infra/hotelRepository';
import { createDuplicateActivities } from '../../src/temporal/activities/duplicate.activities';

const silent = { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} };

/** In-memory stand-in for the Redis calls used here (incr/expire/get/set). */
function fakeRedis(
  opts: { failIncr?: boolean } = {},
): Redis & { store: Map<string, string>; ttls: Map<string, number> } {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  // Cast: structural stub of the few commands the code under test uses.
  return {
    store,
    ttls,
    incr: async (k: string) => {
      if (opts.failIncr) throw new Error('redis down');
      const n = Number(store.get(k) ?? 0) + 1;
      store.set(k, String(n));
      return n;
    },
    expire: async (k: string, s: number) => {
      ttls.set(k, s);
      return 1;
    },
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    },
  } as unknown as Redis & { store: Map<string, string>; ttls: Map<string, number> };
}

function countingLlm(answer: unknown): ToolCaller & { calls: number } {
  const llm = {
    provider: 'anthropic' as const,
    model: 'm',
    calls: 0,
    async callTool() {
      llm.calls++;
      return answer;
    },
  };
  return llm;
}

const req = {
  system: 's',
  user: 'u',
  toolName: 't',
  toolDescription: 'd',
  schema: {
    type: 'object' as const,
    properties: {},
    required: [],
    additionalProperties: false as const,
  },
};

describe('BudgetedToolCaller (LLM_DAILY_CALL_LIMIT)', () => {
  it('passes calls through until the daily limit, then refuses without calling the model', async () => {
    const inner = countingLlm({ ok: true });
    const redis = fakeRedis();
    const now = new Date('2026-11-21T10:00:00Z');
    const budgeted = new BudgetedToolCaller(inner, redis, 2, () => now);

    await budgeted.callTool(req);
    await budgeted.callTool(req);
    await expect(budgeted.callTool(req)).rejects.toBeInstanceOf(LlmBudgetExceededError);
    expect(inner.calls).toBe(2);
    expect(redis.store.get('llm:calls:2026-11-21')).toBe('3');
    expect(redis.ttls.get('llm:calls:2026-11-21')).toBe(2 * 24 * 60 * 60);
  });

  it('uses one counter per UTC day', () => {
    expect(budgetKey(new Date('2026-11-21T23:59:59Z'))).toBe('llm:calls:2026-11-21');
    expect(budgetKey(new Date('2026-11-22T00:00:00Z'))).toBe('llm:calls:2026-11-22');
  });

  it('fails closed when the counter is unavailable', async () => {
    const inner = countingLlm({});
    const budgeted = new BudgetedToolCaller(inner, fakeRedis({ failIncr: true }), 200);
    await expect(budgeted.callTool(req)).rejects.toBeInstanceOf(LlmBudgetExceededError);
    expect(inner.calls).toBe(0);
  });

  it('a limit of 0 disables LLM calls entirely', async () => {
    const inner = countingLlm({});
    await expect(new BudgetedToolCaller(inner, fakeRedis(), 0).callTool(req)).rejects.toThrow(
      /limit \(0\)/,
    );
    expect(inner.calls).toBe(0);
  });
});

describe('fallbacks when the budget is exhausted', () => {
  it('/api/hotels/ask falls back to the rules parser', async () => {
    const redis = fakeRedis();
    const inner = countingLlm({ city: 'mumbai', minPrice: null, maxPrice: null });
    const budgeted = new BudgetedToolCaller(inner, redis, 1);
    const offers = {
      offers: [],
      workflowId: 'w',
      runId: 'r',
      suppliersStatus: 'A=up;B=up',
      resultStatus: 'complete' as const,
      cache: 'MISS' as const,
    };
    // Cast: structural stub of the two HotelService methods AskService calls.
    const hotels = {
      getOffers: async () => offers,
      getFilteredOffers: async () => offers,
    } as unknown as HotelService;
    const ask = new AskService(
      [new LlmQueryParser(budgeted), new RulesQueryParser(['delhi', 'goa'])],
      hotels,
      redis,
    );

    expect((await ask.ask('hotels in goa please', 'r1')).parser).toBe('llm'); // 1st call: within budget
    const second = await ask.ask('hotels in delhi under 6k', 'r2'); // 2nd call: over budget
    expect(second).toMatchObject({
      parser: 'rules',
      interpretedAs: { city: 'delhi', maxPrice: 6000 },
    });
    expect(inner.calls).toBe(1);
  });

  it('the duplicate judge returns a similarity-only verdict', async () => {
    const inner = countingLlm({ verdict: 'different', reason: 'x' });
    const budgeted = new BudgetedToolCaller(inner, fakeRedis(), 0);
    // Cast: the judge does not touch the repository.
    const acts = createDuplicateActivities({} as HotelRepository, budgeted);
    const judged = await new MockActivityEnvironment(undefined, { logger: silent }).run(
      acts.judgeDuplicate,
      { name: 'Taj Rambagh Palace', supplier: 'Supplier A', price: 24000 },
      { name: 'Taj Jai Mahal Palace', supplier: 'Supplier B', price: 21000 },
      'jaipur',
      0.87,
    );
    expect(judged).toMatchObject({ verdict: 'uncertain', decidedBy: 'similarity' });
    expect(judged.reason).toMatch(/LLM daily budget reached/);
    expect(inner.calls).toBe(0);
  });
});
