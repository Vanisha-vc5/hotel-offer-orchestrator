import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Redis } from 'ioredis';
import type { Result } from 'ioredis';
import { config } from './config';
import { logger } from './logger';

/** Reply of filterByPrice.lua: `null` = cache MISS, otherwise [metaValues, offerJsons]. */
export type FilterByPriceReply = [Array<string | null>, Array<string | null>] | null;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    filterByPrice(
      byPriceKey: string,
      offersKey: string,
      metaKey: string,
      min: string,
      max: string,
      ...metaFields: string[]
    ): Result<FilterByPriceReply, Context>;
    /** writeCityOffers.lua: versioned atomic write. */
    writeCityOffers(
      byPriceKey: string,
      offersKey: string,
      metaKey: string,
      ...args: Array<string | number>
    ): Result<WriteOutcome, Context>;
  }
}

/** Result of writeCityOffers.lua. */
export type WriteOutcome = 'written' | 'stale' | 'kept_complete';

const LUA_DIR = path.join(__dirname, 'lua');

export function loadLua(name: string): string {
  return readFileSync(path.join(LUA_DIR, name), 'utf8');
}

/** Registers the custom Lua commands (EVALSHA with automatic EVAL fallback). */
export function defineCommands(client: Redis): void {
  client.defineCommand('filterByPrice', { numberOfKeys: 3, lua: loadLua('filterByPrice.lua') });
  client.defineCommand('writeCityOffers', { numberOfKeys: 3, lua: loadLua('writeCityOffers.lua') });
}

export function createRedis(url: string = config().REDIS_URL, name = 'redis'): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    // Fail fast instead of queueing forever: callers translate failures into 503s.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 2_000,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
  defineCommands(client);
  const log = logger.child({ component: name });
  client.on('ready', () => log.info('redis ready'));
  client.on('error', (err: Error) => log.warn({ err: err.message }, 'redis error'));
  client.on('end', () => log.info('redis connection closed'));
  return client;
}

let shared: Redis | undefined;

/** Process-wide Redis client. Connection is started on first use and auto-reconnects. */
export function getRedis(): Redis {
  if (!shared) {
    shared = createRedis();
    shared.connect().catch((err: Error) => {
      logger.warn({ err: err.message }, 'initial redis connect failed; will keep retrying');
    });
  }
  return shared;
}

/** Waits until Redis is ready, or resolves false after `timeoutMs`. */
export async function waitForRedis(client: Redis, timeoutMs: number): Promise<boolean> {
  if (client.status === 'ready') return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.off('ready', onReady);
      resolve(false);
    }, timeoutMs);
    const onReady = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    client.once('ready', onReady);
  });
}

export async function closeRedis(): Promise<void> {
  if (!shared) return;
  const client = shared;
  shared = undefined;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
