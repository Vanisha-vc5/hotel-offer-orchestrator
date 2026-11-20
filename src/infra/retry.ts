import { setTimeout as sleep } from 'node:timers/promises';

export interface RetryOptions {
  attempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

/** Runs `fn` until it succeeds or `attempts` is exhausted, with exponential backoff. */
export async function retryWithBackoff<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let delay = opts.initialDelayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.attempts) throw err;
      opts.onRetry?.(attempt, err, delay);
      await sleep(delay);
      delay = Math.min(delay * 2, opts.maxDelayMs);
    }
  }
}
