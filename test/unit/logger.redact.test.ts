import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS } from '../../src/infra/logger';

/** Same redaction config as the app logger, captured into memory. */
function capture(): { log: pino.Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { log: pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, stream), lines };
}

describe('logger redaction', () => {
  it('never writes admin tokens, auth headers or API keys', () => {
    const { log, lines } = capture();
    log.info(
      {
        req: {
          headers: { 'x-admin-token': 'tok-123', authorization: 'Bearer abc', cookie: 'sid=1' },
        },
        cfg: {
          ADMIN_TOKEN: 'tok-123',
          LLM_API_KEY: 'sk-ant-secret',
          TEMPORAL_API_KEY: 'tmprl-secret',
        },
        apiKey: 'sk-ant-top',
        nested: { token: 't', password: 'p', secret: 's' },
        city: 'delhi',
      },
      'request',
    );
    const out = lines.join('');
    for (const secret of [
      'tok-123',
      'Bearer abc',
      'sid=1',
      'sk-ant-secret',
      'tmprl-secret',
      'sk-ant-top',
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[redacted]');
    expect(out).toContain('"city":"delhi"'); // ordinary fields are untouched
  });
});
