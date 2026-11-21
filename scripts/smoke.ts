/**
 * Smoke-test any deployment:  npm run smoke -- --url https://hotels.example.com
 * Add --insecure for a self-signed/local Caddy certificate. Exits 1 on any failure.
 */
import { runSmoke } from './lib/smoke';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  return process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
}

async function main(): Promise<void> {
  const url = arg('url') ?? process.env.SMOKE_URL ?? 'http://localhost:3000';
  if (process.argv.includes('--insecure')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.log(`smoke testing ${url}\n`);
  const results = await runSmoke(url);
  for (const r of results) {
    console.log(
      `${r.ok ? '✔' : '✘'} ${r.check.padEnd(58)} ${String(r.ms).padStart(6)} ms  ${r.detail}`,
    );
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
