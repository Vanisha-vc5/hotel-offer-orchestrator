/**
 * One-command verification (npm run verify):
 *   clean stack (down -v) → up --build --wait → lint → typecheck → unit/workflow/
 *   integration tests → newman (all folders) → timed chaos scenarios → benchmark
 *   (N=50) → docs/verification-report.md. Exits non-zero if anything failed.
 *
 * Reads API_HOST_PORT / REDIS_HOST_PORT / ADMIN_TOKEN from .env (created from
 * .env.example when missing, e.g. in CI).
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';

interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  details: string;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (t: string): string => t.replace(ANSI, '');

const results: StepResult[] = [];
const scenarioTimings: Array<{ name: string; ms: number; ok: boolean; details: string }> = [];
let newmanSummary = 'not run';
let benchmarkLines: string[] = [];

function readEnvFile(): Record<string, string> {
  if (!existsSync('.env')) copyFileSync('.env.example', '.env');
  const env: Record<string, string> = {};
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m?.[1] && m[2] !== undefined) env[m[1]] = m[2];
  }
  return env;
}

const dotenv = readEnvFile();
const API = `http://localhost:${dotenv.API_HOST_PORT || '3000'}`;
const REDIS_URL = `redis://localhost:${dotenv.REDIS_HOST_PORT || '6379'}/15`;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? dotenv.ADMIN_TOKEN ?? '';
const ADMIN: Record<string, string> = ADMIN_TOKEN ? { 'x-admin-token': ADMIN_TOKEN } : {};

/** Runs a shell command, streaming output; resolves with exit code and the output tail. */
function sh(cmd: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, env: { ...process.env, ...env } });
    let out = '';
    const collect = (chunk: Buffer): void => {
      process.stdout.write(chunk);
      out = (out + chunk.toString()).slice(-20_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

async function step(name: string, fn: () => Promise<string>, critical = false): Promise<boolean> {
  process.stdout.write(`\n\x1b[1;34m▶ ${name}\x1b[0m\n`);
  const started = performance.now();
  let ok = true;
  let details: string;
  try {
    details = await fn();
  } catch (err) {
    ok = false;
    details = (err as Error).message.split('\n').slice(-3).join(' ').slice(0, 300);
  }
  const ms = Math.round(performance.now() - started);
  results.push({ name, ok, ms, details });
  process.stdout.write(
    `${ok ? '\x1b[32m✔' : '\x1b[31m✘'} ${name} (${(ms / 1000).toFixed(1)}s)\x1b[0m ${details}\n`,
  );
  if (!ok && critical) throw new Error(`critical step failed: ${name}`);
  return ok;
}

async function npmStep(
  name: string,
  script: string,
  env: Record<string, string> = {},
): Promise<void> {
  await step(name, async () => {
    const { code, out } = await sh(`npm run ${script}`, env);
    const tests = /Tests\s+(.+?)\s*$/m.exec(stripAnsi(out))?.[1];
    if (code !== 0) throw new Error(`exit ${code}${tests ? ` — ${tests}` : ''}`);
    return tests ? `Tests ${tests}` : 'passed';
  });
}

// ------------------------------------------------------------------ HTTP helpers
async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; headers: Headers; json: unknown; ms: number }> {
  const started = performance.now();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...ADMIN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    json: text ? JSON.parse(text) : null,
    ms: Math.round(performance.now() - started),
  };
}

function expectThat(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

async function scenario(name: string, fn: () => Promise<string>): Promise<void> {
  const started = performance.now();
  let ok = true;
  let details: string;
  try {
    details = await fn();
  } catch (err) {
    ok = false;
    details = (err as Error).message;
  } finally {
    await call('DELETE', '/admin/chaos').catch(() => undefined);
  }
  const ms = Math.round(performance.now() - started);
  scenarioTimings.push({ name, ms, ok, details });
  if (!ok) throw new Error(`${name}: ${details}`);
}

async function chaosScenarios(): Promise<string> {
  const delhi = (): ReturnType<typeof call> => call('GET', '/api/hotels?city=delhi');
  await call('DELETE', '/admin/chaos');

  await scenario('Supplier B down → partial + degraded', async () => {
    await call('POST', '/admin/chaos/suppliers/B', { mode: 'down' });
    const r = await delhi();
    expectThat(
      r.status === 200 && r.headers.get('x-result-status') === 'partial',
      `got ${r.status} ${r.headers.get('x-result-status')}`,
    );
    expectThat((r.json as unknown[]).length === 6, 'expected 6 hotels');
    const h = await call('GET', '/health');
    expectThat((h.json as { status: string }).status === 'degraded', 'health not degraded');
    return `200 partial, 6 hotels in ${r.ms} ms; health degraded`;
  });

  await scenario('Both suppliers down → 503', async () => {
    await call('POST', '/admin/chaos/suppliers/A', { mode: 'down' });
    await call('POST', '/admin/chaos/suppliers/B', { mode: 'down' });
    const r = await delhi();
    const code = (r.json as { error?: { code?: string } }).error?.code;
    expectThat(r.status === 503 && code === 'SUPPLIERS_UNAVAILABLE', `got ${r.status} ${code}`);
    return `503 SUPPLIERS_UNAVAILABLE in ${r.ms} ms`;
  });

  await scenario('Supplier B flaky → retries recover', async () => {
    await call('POST', '/admin/chaos/suppliers/B', { mode: 'flaky' });
    const r = await delhi();
    expectThat(
      r.headers.get('x-result-status') === 'complete',
      `got ${r.headers.get('x-result-status')}`,
    );
    return `200 complete (2 failures retried) in ${r.ms} ms`;
  });

  await scenario('Supplier B slow → timeouts → partial', async () => {
    await call('POST', '/admin/chaos/suppliers/B', { mode: 'slow', latencyMs: 6000 });
    const r = await delhi();
    expectThat(
      r.headers.get('x-result-status') === 'partial',
      `got ${r.headers.get('x-result-status')}`,
    );
    return `200 partial after per-attempt timeouts in ${r.ms} ms`;
  });

  await scenario('Circuit breaker → fast partial', async () => {
    await call('POST', '/admin/chaos/suppliers/B', { mode: 'down' });
    for (let i = 0; i < 3; i++) await call('POST', '/admin/monitor/probe-now');
    const c = await call('GET', '/admin/circuits');
    expectThat((c.json as { B: { state: string } }).B.state === 'open', 'circuit B not open');
    const r = await delhi();
    expectThat(r.ms < 1000, `took ${r.ms} ms`);
    expectThat((r.headers.get('x-circuit-state') ?? '').includes('B=open'), 'no B=open header');
    return `circuit B open; /api/hotels answered in ${r.ms} ms`;
  });
  return scenarioTimings.map((s) => `${s.name}: ${s.ms} ms`).join('; ');
}

// ------------------------------------------------------------------ report
async function versions(): Promise<string[]> {
  const v = async (cmd: string): Promise<string> =>
    (await sh(`${cmd} 2>&1`)).out.trim().split('\n').at(-1) ?? 'unknown';
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    version: string;
    dependencies: Record<string, string>;
  };
  return [
    `- **Date:** ${new Date().toISOString()}`,
    `- **Commit:** \`${await v('git rev-parse --short HEAD')}\` · **App version:** ${pkg.version}`,
    `- **Node:** ${process.version} · **Docker:** ${await v('docker version --format "{{.Server.Version}}"')} · **Compose:** ${await v('docker compose version --short')}`,
    `- **Temporal SDK:** ${pkg.dependencies['@temporalio/client']} · **OS:** ${os.type()} ${os.release()} (${os.arch()}), ${os.cpus().length} cores`,
  ];
}

async function writeReport(): Promise<void> {
  const allOk = results.every((r) => r.ok);
  const total = results.reduce((s, r) => s + r.ms, 0);
  const md = [
    '# Verification report',
    '',
    `> **${allOk ? '✅ PASS' : '❌ FAIL'}**: ${results.filter((r) => r.ok).length}/${results.length} checks passed in ${(total / 1000).toFixed(0)} s. Generated by \`npm run verify\` (\`scripts/verify.ts\`).`,
    '',
    ...(await versions()),
    '',
    '## Checks',
    '',
    '| # | Check | Result | Duration | Details |',
    '| -: | ----- | ------ | -------: | ------- |',
    ...results.map(
      (r, i) =>
        `| ${i + 1} | ${r.name} | ${r.ok ? '✅ pass' : '❌ fail'} | ${(r.ms / 1000).toFixed(1)} s | ${r.details.replace(/\|/g, '\\|')} |`,
    ),
    '',
    '## Newman (Postman collection, all folders)',
    '',
    newmanSummary,
    '',
    '## Chaos scenarios',
    '',
    '| Scenario | Result | Duration | Observed |',
    '| -------- | ------ | -------: | -------- |',
    ...scenarioTimings.map(
      (s) => `| ${s.name} | ${s.ok ? '✅' : '❌'} | ${s.ms} ms | ${s.details} |`,
    ),
    '',
    '## Benchmark (N=50, coalescing on vs off)',
    '',
    '```',
    ...benchmarkLines,
    '```',
    '',
  ].join('\n');
  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/verification-report.md', md);
  process.stdout.write(`\nwritten docs/verification-report.md — ${allOk ? 'PASS' : 'FAIL'}\n`);
}

// ------------------------------------------------------------------ main
async function main(): Promise<void> {
  try {
    await step(
      'Clean slate: docker compose down -v',
      async () => {
        const { code } = await sh('docker compose down -v --remove-orphans');
        if (code !== 0) throw new Error(`exit ${code}`);
        return 'volumes removed';
      },
      true,
    );
    await step(
      'docker compose up --build --wait (all services healthy)',
      async () => {
        const { code } = await sh('docker compose up --build -d --wait --wait-timeout 420');
        if (code !== 0) throw new Error(`exit ${code}`);
        const { out } = await sh('docker compose ps --format "{{.Service}}={{.Health}}"');
        const services = out.trim().split(/\r?\n/).filter(Boolean);
        if (!services.every((s) => s.endsWith('=healthy'))) throw new Error(services.join(' '));
        return services.join(', ');
      },
      true,
    );

    await npmStep('Lint (ESLint)', 'lint');
    await npmStep('Typecheck (tsc strict)', 'typecheck');
    await npmStep('Unit tests', 'test:unit');
    await npmStep('Workflow tests (Temporal)', 'test:workflow');
    await npmStep('Integration tests (supertest + real Redis)', 'test:integration', { REDIS_URL });

    await step('Postman collection (newman)', async () => {
      mkdirSync('newman', { recursive: true });
      const { code } = await sh(
        `npx newman run postman/HotelOfferOrchestrator.postman_collection.json -e postman/local.postman_environment.json ` +
          `--env-var baseUrl=${API} ${ADMIN_TOKEN ? `--env-var adminToken=${ADMIN_TOKEN}` : ''} ` +
          `--reporters cli,json --reporter-json-export newman/report.json`,
      );
      const run = JSON.parse(readFileSync('newman/report.json', 'utf8')).run as {
        stats: Record<string, { total: number; failed: number }>;
        timings: { completed: number; started: number };
      };
      const s = run.stats;
      newmanSummary =
        `| Item | Executed | Failed |\n| ---- | -------: | -----: |\n` +
        ['iterations', 'requests', 'testScripts', 'prerequestScripts', 'assertions']
          .map((k) => `| ${k} | ${s[k]?.total ?? 0} | ${s[k]?.failed ?? 0} |`)
          .join('\n') +
        `\n\nTotal run duration: ${((run.timings.completed - run.timings.started) / 1000).toFixed(1)} s`;
      const detail = `${s.requests?.total} requests, ${s.assertions?.total} assertions, ${s.assertions?.failed} failed`;
      if (code !== 0 || (s.assertions?.failed ?? 1) > 0) throw new Error(detail);
      return detail;
    });

    await step('Chaos scenarios (down, both down, flaky, slow, circuit)', chaosScenarios);

    await step('Benchmark N=50 (coalescing on vs off)', async () => {
      const { code, out } = await sh('npx tsx scripts/benchmark.ts', {
        LEVELS: '50',
        OUT: '-',
        BASE_URL: API,
        ADMIN_TOKEN,
      });
      benchmarkLines = stripAnsi(out)
        .split(/\r?\n/)
        .filter((l) => /coalescing=|Headline/.test(l));
      if (code !== 0) throw new Error(`exit ${code}`);
      return benchmarkLines
        .filter((l) => l.startsWith('coalescing='))
        .map((l) => l.replace(/\s+/g, ' '))
        .join(' | ');
    });
  } catch (err) {
    process.stderr.write(`\n${(err as Error).message}\n`);
  } finally {
    await writeReport();
  }
  if (!results.length || results.some((r) => !r.ok)) process.exitCode = 1;
}

void main();
