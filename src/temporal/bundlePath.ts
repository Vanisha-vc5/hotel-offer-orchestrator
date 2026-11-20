import path from 'node:path';

/** Location of the pre-bundled workflow code produced by `npm run build`. */
export const WORKFLOW_BUNDLE_PATH = path.resolve(__dirname, '..', 'workflow-bundle.js');
