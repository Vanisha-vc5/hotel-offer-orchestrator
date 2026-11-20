/* Ops console: vanilla JS, no framework, no CDN. All rendering uses DOM APIs
 * (textContent), never innerHTML, so API data can't inject markup. */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const state = { temporalUiUrl: 'http://localhost:8080', namespace: 'default', features: {} };

  /** Tiny element builder: el('td', { class: 'num' }, 'text', childNode). */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) {
      if (c === undefined || c === null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const money = (n) => (typeof n === 'number' ? '₹' + n.toLocaleString('en-IN') : '–');
  const supplierBadge = (s) =>
    el('span', { class: 'badge ' + (s === 'Supplier A' ? 'A' : 'B') }, s);
  const chip = (label, value, tone) =>
    el('span', { class: 'chip ' + (tone || '') }, el('b', {}, label), value);
  const replace = (node, ...children) => node.replaceChildren(...children.flat().filter(Boolean));
  const errorBox = (msg) => el('div', { class: 'error', role: 'alert' }, msg);

  function workflowLink(id) {
    if (!id) return '–';
    const href = `${state.temporalUiUrl}/namespaces/${encodeURIComponent(state.namespace)}/workflows/${encodeURIComponent(id)}`;
    return el('a', { href, target: '_blank', rel: 'noopener' }, id);
  }

  async function api(path, options) {
    const res = await fetch(path, options);
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const err =
        body && body.error ? `${body.error.code}: ${body.error.message}` : `HTTP ${res.status}`;
      const e = new Error(err);
      e.status = res.status;
      throw e;
    }
    return { body, headers: res.headers };
  }

  function adminHeaders(extra) {
    const token = $('admin-token').value.trim();
    return Object.assign({}, extra || {}, token ? { 'x-admin-token': token } : {});
  }

  async function busy(button, fn) {
    if (button) button.disabled = true;
    try {
      await fn();
    } finally {
      if (button) button.disabled = false;
    }
  }

  // ---------------------------------------------------------------- offers table
  function offersTable(offers) {
    if (!offers.length) return el('p', { class: 'empty' }, 'No hotels match.');
    return el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', {}, 'Hotel'),
            el('th', {}, 'Supplier'),
            el('th', { class: 'num' }, 'Price'),
            el('th', { class: 'num' }, 'Commission'),
          ),
        ),
        el(
          'tbody',
          {},
          offers.map((o) =>
            el(
              'tr',
              {},
              el('td', {}, o.name),
              el('td', {}, supplierBadge(o.supplier)),
              el('td', { class: 'num' }, money(o.price)),
              el('td', { class: 'num' }, o.commissionPct + '%'),
            ),
          ),
        ),
      ),
    );
  }

  function headerChips(h) {
    const status = h.get('x-result-status');
    const cache = h.get('x-cache');
    return [
      chip('Workflow', workflowLink(h.get('x-workflow-id'))),
      cache && chip('Cache', cache, cache === 'HIT' ? 'ok' : ''),
      status && chip('Result', status, status === 'complete' ? 'ok' : 'warn'),
      h.get('x-suppliers-status') && chip('Suppliers', h.get('x-suppliers-status')),
      h.get('x-circuit-state') &&
        chip(
          'Circuits',
          h.get('x-circuit-state'),
          /open/.test(h.get('x-circuit-state')) ? 'warn' : '',
        ),
      h.get('x-response-time') && chip('Time', h.get('x-response-time')),
    ];
  }

  // ---------------------------------------------------------------- search
  $('search-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const q = new URLSearchParams({ city: String(f.get('city') || '') });
    if (f.get('minPrice')) q.set('minPrice', String(f.get('minPrice')));
    if (f.get('maxPrice')) q.set('maxPrice', String(f.get('maxPrice')));
    if (f.get('refresh') && (q.has('minPrice') || q.has('maxPrice'))) q.set('refresh', 'true');
    busy(ev.submitter, async () => {
      try {
        const { body, headers } = await api('/api/hotels?' + q.toString());
        replace($('search-meta'), headerChips(headers));
        replace($('search-results'), offersTable(body));
      } catch (e) {
        replace($('search-meta'));
        replace($('search-results'), errorBox(e.message));
      }
    });
  });

  // ---------------------------------------------------------------- ask
  $('ask-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const query = String(new FormData(ev.target).get('query') || '');
    busy(ev.submitter, async () => {
      try {
        const { body, headers } = await api('/api/hotels/ask', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query }),
        });
        const i = body.interpretedAs;
        replace(
          $('ask-meta'),
          chip('City', i.city),
          chip('Min', i.minPrice === null ? 'any' : money(i.minPrice)),
          chip('Max', i.maxPrice === null ? 'any' : money(i.maxPrice)),
          chip('Parser', body.parser, body.parser === 'llm' ? 'ok' : ''),
          chip('Parser cache', headers.get('x-parser-cache') || '–'),
          chip('Workflow', workflowLink(headers.get('x-workflow-id'))),
        );
        replace($('ask-results'), offersTable(body.results));
      } catch (e) {
        replace($('ask-meta'));
        replace($('ask-results'), errorBox(e.message));
      }
    });
  });

  // ---------------------------------------------------------------- health
  function supplierTile(name, dep) {
    const up = dep.status === 'up';
    const m = dep.monitor;
    const circuitTone = !m
      ? ''
      : m.circuit === 'closed'
        ? 'ok'
        : m.circuit === 'open'
          ? 'bad'
          : 'warn';
    return el(
      'div',
      { class: 'tile' },
      el('h3', {}, name, el('span', { class: 'chip ' + (up ? 'ok' : 'bad') }, up ? 'up' : 'down')),
      el(
        'dl',
        {},
        el('dt', {}, 'Latency'),
        el('dd', {}, dep.latencyMs + ' ms'),
        el('dt', {}, 'Uptime (1h)'),
        el('dd', {}, m && m.uptimePctLastHour !== null ? m.uptimePctLastHour + '%' : '–'),
        el('dt', {}, 'Circuit'),
        el('dd', {}, m ? el('span', { class: 'chip ' + circuitTone }, m.circuit) : '–'),
        el('dt', {}, 'Failures'),
        el('dd', {}, m ? String(m.consecutiveFailures) : '–'),
        dep.error ? el('dt', {}, 'Error') : null,
        dep.error ? el('dd', {}, dep.error) : null,
      ),
    );
  }

  async function refreshHealth() {
    let body;
    try {
      const res = await fetch('/health');
      body = await res.json();
    } catch {
      replace($('health-tiles'), errorBox('Health endpoint unreachable'));
      return;
    }
    const d = body.dependencies;
    replace(
      $('health-tiles'),
      supplierTile('Supplier A', d.supplierA),
      supplierTile('Supplier B', d.supplierB),
    );
    replace(
      $('health-deps'),
      chip(
        'Redis',
        `${d.redis.status} · ${d.redis.latencyMs} ms`,
        d.redis.status === 'up' ? 'ok' : 'bad',
      ),
      chip(
        'Temporal',
        `${d.temporal.status} · ${d.temporal.latencyMs} ms`,
        d.temporal.status === 'up' ? 'ok' : 'bad',
      ),
      chip('Uptime', body.uptimeSec + ' s'),
    );
    const tone = body.status === 'up' ? 'ok' : body.status === 'degraded' ? 'warn' : 'bad';
    $('overall').className = 'overall ' + tone;
    $('overall-text').textContent = 'System ' + body.status;
  }

  // ---------------------------------------------------------------- chaos
  const MODES = ['up', 'down', 'slow', 'flaky'];

  function renderChaosGrid(modes) {
    const cells = [el('span'), ...MODES.map((m) => el('span', { class: 'muted small' }, m))];
    for (const s of ['A', 'B']) {
      cells.push(el('b', {}, 'Supplier ' + s));
      for (const m of MODES) {
        const b = el(
          'button',
          { type: 'button', class: modes && modes[s] && modes[s].mode === m ? 'active' : '' },
          m,
        );
        b.addEventListener('click', () => setMode(s, m, b));
        cells.push(b);
      }
    }
    replace($('chaos-grid'), cells);
  }

  async function refreshChaos() {
    try {
      const { body } = await api('/admin/chaos', { headers: adminHeaders() });
      renderChaosGrid(body);
      const chips = [];
      if (state.features.monitor) {
        const c = await api('/admin/circuits', { headers: adminHeaders() });
        for (const s of ['A', 'B']) {
          const st = c.body[s].state;
          chips.push(
            chip(
              'Circuit ' + s,
              `${st} · ${c.body[s].consecutiveFailures} fail`,
              st === 'closed' ? 'ok' : st === 'open' ? 'bad' : 'warn',
            ),
          );
        }
      }
      replace($('chaos-state'), chips);
    } catch (e) {
      renderChaosGrid(null);
      replace(
        $('chaos-state'),
        errorBox(e.status === 401 ? 'Enter the admin token to use chaos controls.' : e.message),
      );
    }
  }

  async function setMode(supplier, mode, button) {
    await busy(button, async () => {
      try {
        await api('/admin/chaos/suppliers/' + supplier, {
          method: 'POST',
          headers: adminHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({ mode }),
        });
      } catch (e) {
        replace($('chaos-state'), errorBox(e.message));
        return;
      }
      await Promise.all([refreshChaos(), refreshHealth()]);
    });
  }

  $('chaos-reset').addEventListener('click', (ev) =>
    busy(ev.currentTarget, async () => {
      try {
        await api('/admin/chaos', { method: 'DELETE', headers: adminHeaders() });
      } catch (e) {
        replace($('chaos-state'), errorBox(e.message));
        return;
      }
      await Promise.all([refreshChaos(), refreshHealth()]);
    }),
  );

  $('probe-now').addEventListener('click', (ev) =>
    busy(ev.currentTarget, async () => {
      try {
        await api('/admin/monitor/probe-now', { method: 'POST', headers: adminHeaders() });
      } catch (e) {
        replace($('chaos-state'), errorBox(e.message));
        return;
      }
      await Promise.all([refreshChaos(), refreshHealth()]);
    }),
  );
  $('admin-token').addEventListener('change', refreshChaos);

  // ---------------------------------------------------------------- insights
  $('insights-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const city = String(new FormData(ev.target).get('city') || '');
    busy(ev.submitter, async () => {
      try {
        const { body } = await api('/api/hotels/insights?city=' + encodeURIComponent(city));
        const s = body.summary;
        replace(
          $('insights-summary'),
          chip('Hotels', s.hotels),
          chip('Overlapping', s.overlapping),
          chip('Wins A', s.winsBySupplier['Supplier A']),
          chip('Wins B', s.winsBySupplier['Supplier B']),
          chip('Total savings', money(s.totalSavings), 'ok'),
          chip('Result', body.resultStatus, body.resultStatus === 'complete' ? 'ok' : 'warn'),
          chip('Workflow', workflowLink(body.workflowId)),
        );
        replace(
          $('insights-decisions'),
          el('h4', {}, 'Decisions'),
          el(
            'div',
            { class: 'table-wrap' },
            el(
              'table',
              {},
              el(
                'thead',
                {},
                el(
                  'tr',
                  {},
                  el('th', {}, 'Hotel'),
                  el('th', {}, 'Winner'),
                  el('th', { class: 'num' }, 'Price'),
                  el('th', {}, 'Reason'),
                  el('th', { class: 'num' }, 'Savings'),
                  el('th', {}, 'Offers'),
                ),
              ),
              el(
                'tbody',
                {},
                body.hotels.map((h) =>
                  el(
                    'tr',
                    {},
                    el('td', {}, h.name),
                    el('td', {}, supplierBadge(h.winner.supplier)),
                    el('td', { class: 'num' }, money(h.winner.price)),
                    el('td', {}, h.reason.replace(/_/g, ' ')),
                    el('td', { class: 'num' }, money(h.savings)),
                    el(
                      'td',
                      { class: 'muted' },
                      h.offers.map((o) => `${o.supplier.slice(-1)} ${money(o.price)}`).join(' · '),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        const dups = body.possibleDuplicates;
        replace(
          $('insights-dups'),
          dups === undefined
            ? null
            : [
                el('h4', {}, 'Possible duplicates (report-only)'),
                dups.length
                  ? el(
                      'div',
                      { class: 'table-wrap' },
                      el(
                        'table',
                        {},
                        el(
                          'thead',
                          {},
                          el(
                            'tr',
                            {},
                            el('th', {}, 'Listing A'),
                            el('th', {}, 'Listing B'),
                            el('th', { class: 'num' }, 'Similarity'),
                            el('th', {}, 'Verdict'),
                            el('th', {}, 'Decided by'),
                            el('th', { class: 'num' }, 'Potential savings'),
                            el('th', {}, 'Reason'),
                          ),
                        ),
                        el(
                          'tbody',
                          {},
                          dups.map((d) =>
                            el(
                              'tr',
                              {},
                              el('td', {}, `${d.a.name} (${money(d.a.price)})`),
                              el('td', {}, `${d.b.name} (${money(d.b.price)})`),
                              el('td', { class: 'num' }, d.similarity.toFixed(2)),
                              el(
                                'td',
                                {},
                                el(
                                  'span',
                                  {
                                    class:
                                      'chip ' +
                                      (d.verdict === 'likely_same'
                                        ? 'warn'
                                        : d.verdict === 'different'
                                          ? 'ok'
                                          : ''),
                                  },
                                  d.verdict.replace('_', ' '),
                                ),
                              ),
                              el('td', {}, d.decidedBy),
                              el('td', { class: 'num' }, money(d.potentialSavings)),
                              el('td', { class: 'muted' }, d.reason),
                            ),
                          ),
                        ),
                      ),
                    )
                  : el('p', { class: 'empty' }, 'No near-duplicates found.'),
              ],
        );
      } catch (e) {
        replace($('insights-summary'));
        replace($('insights-decisions'), errorBox(e.message));
        replace($('insights-dups'));
      }
    });
  });

  // ---------------------------------------------------------------- boot
  async function boot() {
    try {
      const { body } = await api('/console/config.json');
      Object.assign(state, body);
    } catch {
      // defaults are fine
    }
    $('temporal-link').href = state.temporalUiUrl;
    if (!state.features.ask) $('ask-h').parentElement.hidden = true;
    if (!state.features.chaos) $('chaos-h').parentElement.hidden = true;
    if (!state.features.monitor) $('probe-now').hidden = true;
    renderChaosGrid(null);
    await Promise.all([refreshHealth(), state.features.chaos ? refreshChaos() : null]);
    setInterval(refreshHealth, 5000);
  }

  boot();
})();
