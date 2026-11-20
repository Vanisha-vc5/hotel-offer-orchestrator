/**
 * Build step: pre-bundles workflow code so the production worker does not need
 * webpack at startup (faster boot, identical code on every replica).
 */
import { writeFileSync } from 'node:fs';
import { bundleWorkflowCode } from '@temporalio/worker';
import { WORKFLOW_BUNDLE_PATH } from './bundlePath';

async function bundle(): Promise<void> {
  const { code } = await bundleWorkflowCode({ workflowsPath: require.resolve('./workflows') });
  writeFileSync(WORKFLOW_BUNDLE_PATH, code);
  process.stdout.write(
    `workflow bundle written to ${WORKFLOW_BUNDLE_PATH} (${code.length} bytes)\n`,
  );
}

bundle().catch((err: unknown) => {
  process.stderr.write(`workflow bundle failed: ${String(err)}\n`);
  process.exit(1);
});
