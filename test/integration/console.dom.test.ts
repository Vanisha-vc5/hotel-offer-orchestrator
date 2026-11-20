/**
 * DOM smoke test for the ops console: loads the real index.html + console.js
 * into jsdom, points fetch at a live test app, and drives the UI like a user.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONSOLE_DIR } from '../../src/api/routes/console.routes';
import { startTestApp } from '../helpers/app';
import type { TestApp } from '../helpers/app';

type Maybe<T> = T | undefined | null | false;

/** Polls `fn` (sync or async) until it returns a truthy value. */
async function until<T>(fn: () => Maybe<T> | Promise<Maybe<T>>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting for the console to render');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('ops console (jsdom, real API)', () => {
  let t: TestApp;
  let dom: JSDOM;
  let doc: Document;

  beforeAll(async () => {
    t = await startTestApp({ TEMPORAL_UI_URL: 'http://temporal.example:8080' });
    await t.chaos.reset();
    for (const c of ['delhi', 'jaipur']) await t.repository.deleteCity(c);
    const base = `${t.baseUrl}/console/`;
    dom = new JSDOM(readFileSync(path.join(CONSOLE_DIR, 'index.html'), 'utf8'), {
      url: base,
      runScripts: 'outside-only',
      beforeParse(window) {
        // jsdom has no fetch; route the page's relative requests to the test app.
        (window as unknown as { fetch: typeof fetch }).fetch = (input, init) =>
          fetch(new URL(String(input), base), init);
      },
    });
    doc = dom.window.document;
    dom.window.eval(readFileSync(path.join(CONSOLE_DIR, 'console.js'), 'utf8'));
  });
  afterAll(async () => {
    dom?.window.close(); // stops the 5s health polling
    await t?.close();
  });

  const submit = (formId: string): void => {
    const form = doc.getElementById(formId) as HTMLFormElement;
    form.requestSubmit(form.querySelector('button[type=submit]') as HTMLButtonElement);
  };

  it('renders supplier health tiles and the overall status on load', async () => {
    const tiles = await until(() => {
      const nodes = doc.querySelectorAll('#health-tiles .tile');
      return nodes.length === 2 ? nodes : null;
    });
    expect(tiles[0]?.textContent).toContain('Supplier A');
    expect(tiles[0]?.textContent).toContain('closed'); // circuit from the monitor block
    expect(doc.getElementById('overall-text')?.textContent).toBe('System up');
    expect((doc.getElementById('temporal-link') as HTMLAnchorElement).href).toBe(
      'http://temporal.example:8080/',
    );
  });

  it('search shows the 7 delhi hotels with supplier badges and a Temporal link', async () => {
    submit('search-form');
    const rows = await until(() => {
      const r = doc.querySelectorAll('#search-results tbody tr');
      return r.length === 7 ? r : null;
    });
    expect(rows[0]?.textContent).toContain('Ibis');
    expect(rows[0]?.querySelector('.badge.B')?.textContent).toBe('Supplier B');
    const link = doc.querySelector('#search-meta a') as HTMLAnchorElement;
    expect(link.href).toBe(
      'http://temporal.example:8080/namespaces/default/workflows/hotel-offers-delhi',
    );
    expect(doc.getElementById('search-meta')?.textContent).toContain('MISS');
  });

  it('ask shows the interpretation and filtered results', async () => {
    submit('ask-form');
    const rows = await until(() => {
      const r = doc.querySelectorAll('#ask-results tbody tr');
      return r.length === 4 ? r : null;
    });
    expect(doc.getElementById('ask-meta')?.textContent).toContain('delhi');
    expect(doc.getElementById('ask-meta')?.textContent).toContain('rules');
    expect(rows[3]?.textContent).toContain('Radison');
  });

  it('insights shows decisions and possible duplicates for jaipur', async () => {
    submit('insights-form');
    const dupRows = await until(() => {
      const r = doc.querySelectorAll('#insights-dups tbody tr');
      return r.length === 4 ? r : null;
    });
    expect(doc.querySelectorAll('#insights-decisions tbody tr').length).toBeGreaterThan(0);
    expect(dupRows[0]?.textContent).toContain('likely same');
  });

  it('chaos buttons change supplier modes and reset clears them', async () => {
    await until(() => doc.querySelectorAll('#chaos-grid button').length === 8);
    const downB = [...doc.querySelectorAll('#chaos-grid button')][5] as HTMLButtonElement; // B row, "down"
    expect(downB.textContent).toBe('down');
    downB.click();
    await until(async () => (await t.chaos.get('B')).mode === 'down');
    await until(
      () => (doc.querySelectorAll('#chaos-grid button')[5] as HTMLElement).className === 'active',
    );

    (doc.getElementById('chaos-reset') as HTMLButtonElement).click();
    await until(
      () => (doc.querySelectorAll('#chaos-grid button')[4] as HTMLElement).className === 'active',
    );
    expect((await t.chaos.get('B')).mode).toBe('up');
  });
});
