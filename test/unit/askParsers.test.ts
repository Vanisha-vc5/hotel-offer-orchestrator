import Anthropic from '@anthropic-ai/sdk';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { AskService, LlmQueryParser, RulesQueryParser } from '../../src/api/services/askService';
import type { HotelService } from '../../src/api/services/hotelService';
import {
  AnthropicToolCaller,
  LlmTimeoutError,
  OpenAICompatibleToolCaller,
} from '../../src/infra/llm';
import type { ToolCaller } from '../../src/infra/llm';

const CITIES = ['delhi', 'mumbai', 'goa'];

/** Fake Anthropic client: only messages.create is used by AnthropicToolCaller. */
function fakeAnthropic(create: () => Promise<unknown>): Anthropic {
  // Cast: a structural stub of the one method the caller touches.
  return { messages: { create } } as unknown as Anthropic;
}

function toolUseMessage(input: unknown): unknown {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'tu_1', name: 'extract_filters', input }],
  };
}

/** In-memory stand-in for the two Redis calls AskService makes. */
function fakeRedis(): Redis {
  const store = new Map<string, string>();
  // Cast: structural stub of get/set only.
  return {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    },
  } as unknown as Redis;
}

function fakeHotels(): HotelService & { calls: string[] } {
  const calls: string[] = [];
  const offers = {
    offers: [],
    workflowId: 'hotel-offers-delhi',
    runId: 'r1',
    suppliersStatus: 'A=up;B=up',
    resultStatus: 'complete' as const,
    cache: 'MISS' as const,
  };
  // Cast: structural stub of the two service methods AskService calls.
  return {
    calls,
    getOffers: async (city: string) => {
      calls.push(`getOffers:${city}`);
      return offers;
    },
    getFilteredOffers: async (city: string, range: { minPrice?: number; maxPrice?: number }) => {
      calls.push(`getFilteredOffers:${city}:${range.minPrice ?? '-'}:${range.maxPrice ?? '-'}`);
      return offers;
    },
  } as unknown as HotelService & { calls: string[] };
}

describe('AnthropicToolCaller + LlmQueryParser', () => {
  it('returns validated filters from a forced tool call', async () => {
    let request: Record<string, unknown> = {};
    let options: Record<string, unknown> = {};
    const client = fakeAnthropic(async function (this: unknown, ...args: unknown[]) {
      request = args[0] as Record<string, unknown>;
      options = args[1] as Record<string, unknown>;
      return toolUseMessage({ city: 'delhi', minPrice: null, maxPrice: 6000 });
    } as () => Promise<unknown>);
    const parser = new LlmQueryParser(new AnthropicToolCaller(client, 'claude-haiku-4-5', 5000));

    expect(await parser.parse('cheap hotels in delhi under 6k')).toEqual({
      city: 'delhi',
      minPrice: null,
      maxPrice: 6000,
    });
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'extract_filters' });
    expect((request.tools as Array<{ strict: boolean }>)[0]?.strict).toBe(true);
    expect(request.model).toBe('claude-haiku-4-5');
    expect(options).toEqual({ timeout: 5000, maxRetries: 0 });
    // the query is wrapped as data, and the system prompt says so
    expect(JSON.stringify(request.messages)).toContain(
      '<query>cheap hotels in delhi under 6k</query>',
    );
    expect(String(request.system)).toMatch(/untrusted data/);
  });

  it('rejects output that does not match the schema', async () => {
    const client = fakeAnthropic(async () => toolUseMessage({ city: 42, minPrice: 'cheap' }));
    const parser = new LlmQueryParser(new AnthropicToolCaller(client, 'm', 5000));
    await expect(parser.parse('anything')).rejects.toThrow();
  });

  it('maps an SDK timeout to LlmTimeoutError', async () => {
    const client = fakeAnthropic(async () => {
      throw new Anthropic.APIConnectionTimeoutError();
    });
    await expect(
      new AnthropicToolCaller(client, 'm', 5000).callTool({
        system: 's',
        user: 'u',
        toolName: 't',
        toolDescription: 'd',
        schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      }),
    ).rejects.toBeInstanceOf(LlmTimeoutError);
  });
});

describe('OpenAICompatibleToolCaller', () => {
  const schema = {
    type: 'object' as const,
    properties: {},
    required: [],
    additionalProperties: false as const,
  };
  const req = { system: 's', user: 'u', toolName: 'extract_filters', toolDescription: 'd', schema };
  const reply = (args: string): Response =>
    new Response(
      JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: { arguments: args } }] } }],
      }),
      {
        status: 200,
      },
    );

  it('parses the forced function call arguments', async () => {
    let body: Record<string, unknown> = {};
    const fetchStub = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return reply('{"city":"goa","minPrice":7000,"maxPrice":null}');
    }) as unknown as typeof fetch;
    const caller = new OpenAICompatibleToolCaller(
      'http://llm.local/v1/',
      'k',
      'llama',
      5000,
      fetchStub,
    );
    expect(await caller.callTool(req)).toEqual({ city: 'goa', minPrice: 7000, maxPrice: null });
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'extract_filters' } });
  });

  it('throws on invalid JSON arguments', async () => {
    const fetchStub = (async () => reply('{not json')) as unknown as typeof fetch;
    const caller = new OpenAICompatibleToolCaller(
      'http://llm.local/v1',
      undefined,
      'm',
      5000,
      fetchStub,
    );
    await expect(caller.callTool(req)).rejects.toThrow();
  });

  it('times out with LlmTimeoutError', async () => {
    const fetchStub = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const caller = new OpenAICompatibleToolCaller(
      'http://llm.local/v1',
      undefined,
      'm',
      50,
      fetchStub,
    );
    await expect(caller.callTool(req)).rejects.toBeInstanceOf(LlmTimeoutError);
  });
});

describe('AskService parser chain', () => {
  const failing = (err: Error): ToolCaller => ({
    provider: 'anthropic',
    model: 'm',
    callTool: async () => {
      throw err;
    },
  });
  const returning = (value: unknown): ToolCaller => ({
    provider: 'anthropic',
    model: 'm',
    callTool: async () => value,
  });
  const service = (llm: ToolCaller | undefined, hotels = fakeHotels()) =>
    new AskService(
      [...(llm ? [new LlmQueryParser(llm)] : []), new RulesQueryParser(CITIES)],
      hotels,
      fakeRedis(),
    );

  it('uses the LLM when it succeeds', async () => {
    const hotels = fakeHotels();
    const res = await service(
      returning({ city: 'mumbai', minPrice: 5000, maxPrice: 9000 }),
      hotels,
    ).ask('mid-range stays in bombay', 'r1');
    expect(res.parser).toBe('llm');
    expect(hotels.calls).toEqual(['getFilteredOffers:mumbai:5000:9000']);
  });

  it('falls back to rules on invalid LLM output', async () => {
    const res = await service(returning({ nonsense: true })).ask('hotels in delhi under 6k', 'r1');
    expect(res).toMatchObject({
      parser: 'rules',
      interpretedAs: { city: 'delhi', minPrice: null, maxPrice: 6000 },
    });
  });

  it('falls back to rules on an LLM timeout', async () => {
    const res = await service(failing(new LlmTimeoutError(5000))).ask('goa above 7k', 'r1');
    expect(res).toMatchObject({ parser: 'rules', interpretedAs: { city: 'goa', minPrice: 7000 } });
  });

  it('never lets an invalid LLM city through (falls back instead)', async () => {
    const res = await service(
      returning({ city: 'delhi}:evil', minPrice: null, maxPrice: null }),
    ).ask('hotels in delhi', 'r1');
    expect(res.parser).toBe('rules');
    expect(res.interpretedAs.city).toBe('delhi');
  });

  it('caches interpretations: the second identical query skips the parsers', async () => {
    let llmCalls = 0;
    const llm: ToolCaller = {
      provider: 'anthropic',
      model: 'm',
      callTool: async () => {
        llmCalls++;
        return { city: 'delhi', minPrice: null, maxPrice: null };
      },
    };
    const svc = service(llm);
    expect((await svc.ask('Hotels in Delhi', 'r1')).cached).toBe(false);
    expect((await svc.ask('hotels in   delhi', 'r2')).cached).toBe(true);
    expect(llmCalls).toBe(1);
  });

  it('uses the unfiltered path when no price is mentioned, and 422s without a city', async () => {
    const hotels = fakeHotels();
    await service(undefined, hotels).ask('show me goa', 'r1');
    expect(hotels.calls).toEqual(['getOffers:goa']);
    await expect(service(undefined).ask('cheap hotels under 5k', 'r1')).rejects.toMatchObject({
      code: 'UNPROCESSABLE_QUERY',
      status: 422,
    });
  });
});
