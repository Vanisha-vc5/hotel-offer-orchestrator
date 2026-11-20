import type { Redis } from 'ioredis';
import { createRedis } from '../../src/infra/redis';

/** Real Redis for integration tests. Override with REDIS_URL (CI: service container). */
export async function connectTestRedis(): Promise<Redis> {
  const client = createRedis(process.env.REDIS_URL ?? 'redis://localhost:6379', 'test-redis');
  await client.connect();
  return client;
}

export function uniqueCity(prefix: string): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let suffix = '';
  for (let i = 0; i < 8; i++) suffix += letters[Math.floor(Math.random() * letters.length)];
  return `${prefix}-${suffix}`;
}
