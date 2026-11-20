/**
 * Request-coalescing demo: fires N concurrent requests for the same city and
 * shows they were all served by ONE workflow execution (same run id).
 *
 *   npm run demo:coalescing                 # against http://localhost:3000
 *   BASE_URL=http://host:3000 N=50 npm run demo:coalescing
 *
 * Supplier B is put in `slow` mode (1.5s, below the activity timeout) for the
 * duration of the demo so the workflow is guaranteed to still be running when
 * the later requests arrive; chaos is reset afterwards.
 */
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const N = Number(process.env.N ?? 20);
const CITY = process.env.CITY ?? 'delhi';

async function setChaos(body: object | null): Promise<void> {
  const res = await fetch(`${BASE_URL}/admin/chaos${body ? '/suppliers/B' : ''}`, {
    method: body ? 'POST' : 'DELETE',
    headers: {
      'content-type': 'application/json',
      ...(process.env.ADMIN_TOKEN ? { 'x-admin-token': process.env.ADMIN_TOKEN } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`chaos call failed: ${res.status} ${await res.text()}`);
}

async function main(): Promise<void> {
  await setChaos({ mode: 'slow', latencyMs: 1500 });
  try {
    const started = performance.now();
    const responses = await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        const res = await fetch(`${BASE_URL}/api/hotels?city=${encodeURIComponent(CITY)}`, {
          headers: { 'x-request-id': `coalesce-${i}` },
        });
        const body = (await res.json()) as unknown[];
        return {
          status: res.status,
          workflowId: res.headers.get('x-workflow-id'),
          runId: res.headers.get('x-workflow-run-id'),
          hotels: body.length,
        };
      }),
    );
    const elapsed = Math.round(performance.now() - started);

    const runIds = new Set(responses.map((r) => r.runId));
    const workflowIds = new Set(responses.map((r) => r.workflowId));
    console.table(responses.slice(0, 5));
    console.log(`${N} concurrent requests in ${elapsed}ms`);
    console.log(`statuses:      ${[...new Set(responses.map((r) => r.status))].join(', ')}`);
    console.log(`workflow ids:  ${[...workflowIds].join(', ')}`);
    console.log(`distinct runs: ${runIds.size}  ${[...runIds].join(', ')}`);

    if (runIds.size !== 1 || responses.some((r) => r.status !== 200)) {
      console.error('FAIL: requests were not coalesced into one workflow run');
      process.exitCode = 1;
    } else {
      console.log(`PASS: all ${N} requests shared one workflow execution`);
    }
  } finally {
    await setChaos(null);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
