import path from 'node:path';
import { existsSync } from 'node:fs';
import { runBoundedWorker } from './bounded-worker';
import { checkForProbeWithStatus, type SecurityProbeResult } from './probe-types';
import { boundScanInput, INCOMPLETE_SCAN } from './scan-input';

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
  if (type !== 'sast' && type !== 'secrets') throw new Error('Unsupported scanner');
  const input = boundScanInput(diff);
  const js = path.join(__dirname, 'probes', `${type}.js`);
  const module = existsSync(js) ? js : path.join(__dirname, 'probes', `${type}.ts`);
  try {
    const result = await runBoundedWorker<SecurityProbeResult>(SCRIPT, { module, diff: input.diff,
      method: type === 'sast' ? 'scanSast' : 'scanSecrets',
      ...(module.endsWith('.ts') ? { typescript: require.resolve('typescript') } : {}),
    });
    if (input.incomplete) for (const check of result.checks) {
      if (check.status !== 'FAIL') check.status = 'DEGRADED';
      check.detail = [check.detail, INCOMPLETE_SCAN].filter(Boolean).join(' ');
    }
    return result;
  } catch {
    const probe = type === 'sast' ? 'SAST' : 'SECRETS';
    return { findings: [], checks: [checkForProbeWithStatus(probe, type, 'Bounded credential/code scan', 'DEGRADED', 0,
      'Scanner timed out or was unavailable; its checks did not complete.')] };
  }
}
