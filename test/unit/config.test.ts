import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/infra/config';

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const cfg = loadConfig({});
    expect(cfg).toMatchObject({
      PORT: 3000,
      CACHE_TTL_SECONDS: 300,
      PARTIAL_CACHE_TTL_SECONDS: 30,
      SUPPLIER_ACTIVITY_TIMEOUT: '4s',
      SUPPLIER_RETRY_MAX_ATTEMPTS: 3,
      WORKFLOW_EXECUTION_TIMEOUT: '30s',
      ENABLE_CHAOS: true,
      TEMPORAL_NAMESPACE: 'default',
    });
    expect(cfg.ADMIN_TOKEN).toBeUndefined();
  });

  it('treats empty strings as unset', () => {
    const cfg = loadConfig({ PORT: '', ADMIN_TOKEN: '' });
    expect(cfg.PORT).toBe(3000);
    expect(cfg.ADMIN_TOKEN).toBeUndefined();
  });

  it('fails fast with every problem listed', () => {
    const attempt = (): unknown =>
      loadConfig({ PORT: 'abc', REDIS_URL: 'not a url', SUPPLIER_ACTIVITY_TIMEOUT: 'soon' });
    expect(attempt).toThrow(ConfigError);
    try {
      attempt();
    } catch (err) {
      const issues = (err as ConfigError).issues.join('\n');
      expect(issues).toContain('PORT');
      expect(issues).toContain('REDIS_URL');
      expect(issues).toContain('SUPPLIER_ACTIVITY_TIMEOUT');
    }
  });

  it('requires mTLS cert and key together', () => {
    expect(() => loadConfig({ TEMPORAL_TLS_CERT_PATH: '/tmp/client.pem' })).toThrow(/together/);
  });
});
