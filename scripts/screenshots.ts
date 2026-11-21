/**
 * Automated README screenshots against the running local stack (npm run screenshots).
 *
 *   npx playwright install chromium     # once
 *   docker compose up -d --wait
 *   npm run screenshots                  # → docs/images/*.png (palette-compressed)
 *
 * Env: BASE_URL (default http://localhost:3000), TEMPORAL_UI (default http://localhost:8080),
 * ADMIN_TOKEN (only if the stack has one).
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import sharp from 'sharp';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const TEMPORAL_UI = (process.env.TEMPORAL_UI ?? 'http://localhost:8080').replace(/\/$/, '');
const OUT_DIR = path.resolve('docs/images');
const ADMIN: Record<string, string> = process.env.ADMIN_TOKEN
  ? { 'x-admin-token': process.env.ADMIN_TOKEN }
  : {};

async function api(method: string, p: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${BASE_URL}${p}`, {
    method,
    headers: { ...ADMIN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${await res.text()}`);
  return res;
}

/** Screenshot the viewport, then re-encode as a palette PNG (typically 3–5× smaller). */
async function capture(page: Page, name: string): Promise<void> {
  const raw = await page.screenshot({ type: 'png' });
  const png = await sharp(raw)
    .png({ palette: true, quality: 85, compressionLevel: 9, effort: 10 })
    .toBuffer();
  const file = path.join(OUT_DIR, name);
  writeFileSync(file, png);
  console.log(
    `  ✔ ${name}  ${(raw.length / 1024).toFixed(0)} KB → ${(statSync(file).size / 1024).toFixed(0)} KB`,
  );
}

async function consoleShot(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/console/`);
  await page.waitForFunction(() => document.querySelectorAll('#health-tiles .tile').length === 2);
  await page.fill('#search-form input[name=city]', 'delhi');
  await page.click('#search-form button[type=submit]');
  await page.waitForFunction(
    () => document.querySelectorAll('#search-results tbody tr').length === 7,
  );
  await page.fill('#insights-form input[name=city]', 'jaipur');
  await page.click('#insights-form button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('#insights-dups tbody tr').length > 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await capture(page, 'console.png');
}

async function retriesShot(page: Page): Promise<void> {
  await api('DELETE', '/admin/chaos');
  await api('POST', '/admin/chaos/suppliers/B', { mode: 'flaky' });
  let workflowId: string;
  let runId: string;
  try {
    const res = await api('GET', '/api/hotels?city=delhi');
    workflowId = res.headers.get('x-workflow-id') ?? 'hotel-offers-delhi';
    runId = res.headers.get('x-workflow-run-id') ?? '';
    if (res.headers.get('x-result-status') !== 'complete')
      throw new Error('flaky run did not recover');
  } finally {
    await api('DELETE', '/admin/chaos');
  }
  const url = `${TEMPORAL_UI}/namespaces/default/workflows/${encodeURIComponent(workflowId)}/${runId}/history`;
  await page.goto(url);
  await page.getByText('Activity Task Started').first().waitFor({ timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  // Temporal records ActivityTaskStarted once, on the final attempt: the flaky B fetch
  // shows "Attempt 3". Expand that row (its details include the last failure) and centre it.
  const retried = page
    .locator('tr', { hasText: 'Activity Task Started' })
    .filter({ hasText: /Attempt\s*3/ })
    .first();
  await retried.click();
  await page.waitForTimeout(500);
  await retried.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(300);
  await capture(page, 'temporal-retries.png');
}

async function scheduleShot(page: Page): Promise<void> {
  await page.goto(`${TEMPORAL_UI}/namespaces/default/schedules/cache-warmup`);
  await page.getByText('cache-warmup').first().waitFor({ timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  await capture(page, 'temporal-schedule.png');
}

async function openApiShot(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/docs/`);
  await page.locator('.swagger-ui .opblock').first().waitFor({ timeout: 30_000 });
  await capture(page, 'openapi.png');
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  await api('GET', '/health/live'); // fail fast if the stack is not running
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'light',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    console.log(`capturing against ${BASE_URL} and ${TEMPORAL_UI}`);
    await consoleShot(page);
    await retriesShot(page);
    await scheduleShot(page);
    await openApiShot(page);
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
