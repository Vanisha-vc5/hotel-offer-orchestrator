import Anthropic from '@anthropic-ai/sdk';
import type { Config } from './config';

/** JSON schema for a tool's input (object schema, all properties required). */
export interface ToolSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
  [key: string]: unknown;
}

export interface ToolCallRequest {
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  schema: ToolSchema;
}

/**
 * Minimal "call one tool and give me its arguments" abstraction. Callers MUST
 * validate the returned value (zod): it is model output, not trusted data.
 */
export interface ToolCaller {
  readonly provider: 'anthropic' | 'openai-compatible';
  readonly model: string;
  callTool(req: ToolCallRequest): Promise<unknown>;
}

export class LlmTimeoutError extends Error {
  constructor(ms: number) {
    super(`LLM call timed out after ${ms}ms`);
    this.name = 'LlmTimeoutError';
  }
}

/**
 * Anthropic Messages API with a forced tool call (`tool_choice: {type: 'tool'}`)
 * and a strict schema, so the reply is a single structured tool_use block.
 */
export class AnthropicToolCaller implements ToolCaller {
  readonly provider = 'anthropic' as const;

  constructor(
    private readonly client: Anthropic,
    readonly model: string,
    private readonly timeoutMs: number,
  ) {}

  async callTool(req: ToolCallRequest): Promise<unknown> {
    const tool: Anthropic.Tool = {
      name: req.toolName,
      description: req.toolDescription,
      strict: true,
      input_schema: req.schema,
    };
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 512,
          system: req.system,
          tools: [tool],
          tool_choice: { type: 'tool', name: req.toolName },
          messages: [{ role: 'user', content: req.user }],
        },
        // Fail fast: the caller falls back to the rules parser instead of retrying.
        { timeout: this.timeoutMs, maxRetries: 0 },
      );
    } catch (err) {
      if (err instanceof Anthropic.APIConnectionTimeoutError)
        throw new LlmTimeoutError(this.timeoutMs);
      throw err;
    }
    if (response.stop_reason === 'refusal') throw new Error('LLM declined the request');
    const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!block) throw new Error('LLM returned no tool call');
    return block.input;
  }
}

/**
 * Any OpenAI-compatible chat-completions endpoint (Groq, OpenRouter, Ollama, …)
 * with a forced function call. Plain fetch: no extra SDK dependency.
 */
export class OpenAICompatibleToolCaller implements ToolCaller {
  readonly provider = 'openai-compatible' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    readonly model: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async callTool(req: ToolCallRequest): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: timeout,
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: req.toolName,
                description: req.toolDescription,
                parameters: req.schema,
              },
            },
          ],
          tool_choice: { type: 'function', function: { name: req.toolName } },
        }),
      });
    } catch (err) {
      if (timeout.aborted) throw new LlmTimeoutError(this.timeoutMs);
      throw err;
    }
    if (!res.ok) throw new Error(`LLM endpoint responded ${res.status}`);
    const body = (await res.json()) as {
      choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
    };
    const args = body.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (typeof args !== 'string') throw new Error('LLM returned no tool call');
    return JSON.parse(args) as unknown; // throws on invalid JSON → caller falls back
  }
}

/** Builds the configured tool caller, or undefined when LLM_PROVIDER=none. */
export function createToolCaller(cfg: Config): ToolCaller | undefined {
  switch (cfg.LLM_PROVIDER) {
    case 'anthropic':
      return new AnthropicToolCaller(
        // No apiKey → the SDK resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ant profile.
        new Anthropic(cfg.LLM_API_KEY ? { apiKey: cfg.LLM_API_KEY } : {}),
        cfg.LLM_MODEL ?? 'claude-haiku-4-5',
        cfg.LLM_TIMEOUT_MS,
      );
    case 'openai-compatible':
      if (!cfg.LLM_BASE_URL || !cfg.LLM_MODEL) return undefined; // enforced by config validation
      return new OpenAICompatibleToolCaller(
        cfg.LLM_BASE_URL,
        cfg.LLM_API_KEY,
        cfg.LLM_MODEL,
        cfg.LLM_TIMEOUT_MS,
      );
    default:
      return undefined;
  }
}
