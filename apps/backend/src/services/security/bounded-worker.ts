import { Worker } from 'node:worker_threads';

/** Only trusted application scripts may be passed here. Code/diffs are data. */
export function runBoundedWorker<T>(script: string, data: unknown, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(script, { eval: true, workerData: data,
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } });
    let finished = false;
    const finish = (error?: Error, result?: T) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error('Scanner execution limit exceeded')), timeoutMs);
    worker.once('message', result => finish(undefined, result));
    worker.once('error', () => finish(new Error('Scanner execution unavailable')));
    worker.once('exit', () => finish(new Error('Scanner stopped without a result')));
  });
}
