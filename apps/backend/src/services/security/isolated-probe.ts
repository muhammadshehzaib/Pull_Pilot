import path from 'node:path';
import { existsSync } from 'node:fs';
import { runBoundedWorker } from './bounded-worker';
import { checkForProbeWithStatus, type SecurityProbeResult } from './probe-types';

const SCRIPT = `
const { workerData, parentPort } = require('node:worker_threads');
if (workerData.module.endsWith('.ts')) {
  // Development/test source execution only; production workers load compiled JS.
  const ts = require(workerData.typescript);
  require.extensions['.ts'] = (module, file) => {
    const source = require('node:fs').readFileSync(file, 'utf8');
    module._compile(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText, file);
  };
}
const probe = require(workerData.module);
parentPort.postMessage(probe[workerData.method](workerData.diff));
`;

export async function runIsolatedProbe(type: 'sast' | 'secrets', diff: string): Promise<SecurityProbeResult> {
  const js = path.join(__dirname, 'probes', `${type}.js`);
  const module = existsSync(js) ? js : path.join(__dirname, 'probes', `${type}.ts`);
  try {
    return await runBoundedWorker<SecurityProbeResult>(SCRIPT, { module, diff,
      method: type === 'sast' ? 'scanSast' : 'scanSecrets',
      ...(module.endsWith('.ts') ? { typescript: require.resolve('typescript') } : {}),
    });
  } catch {
    const probe = type === 'sast' ? 'SAST' : 'SECRETS';
    return { findings: [], checks: [checkForProbeWithStatus(probe, type, 'Bounded credential/code scan', 'DEGRADED', 0,
      'Scanner timed out or was unavailable; its checks did not complete.')] };
  }
}
