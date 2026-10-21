import type { Tool } from '../runtime.ts';

/** Retain the schema and handler advertised by this model step, as Codex's StepContext does. */
export function snapshotTools(tools: ReadonlyMap<string, Tool>): ReadonlyMap<string, Tool> {
  return new Map([...tools].map(([name, tool]) => [name, {
    definition: structuredClone(tool.definition), execute: tool.execute, supportsParallel: tool.supportsParallel === true,
  }]));
}

interface Admission {
  parallel: boolean;
  signal: AbortSignal;
  resolve(release: () => void): void;
  reject(error: unknown): void;
  abort(): void;
}

/** FIFO shared/exclusive gate. A queued exclusive call prevents later readers overtaking it. */
export class ParallelToolGate {
  private readers = 0;
  private writer = false;
  private readonly queue: Admission[] = [];

  acquire(parallel: boolean, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const request: Admission = { parallel, signal, resolve, reject, abort: () => {
        const index = this.queue.indexOf(request);
        if (index < 0) return;
        this.queue.splice(index, 1); signal.removeEventListener('abort', request.abort);
        reject(signal.reason ?? new Error('Tool admission interrupted')); this.drain();
      } };
      this.queue.push(request); signal.addEventListener('abort', request.abort, { once: true });
      this.drain();
    });
  }

  private drain(): void {
    if (this.writer) return;
    while (this.queue.length) {
      const request = this.queue[0]!;
      if (!request.parallel && this.readers > 0) return;
      this.queue.shift(); request.signal.removeEventListener('abort', request.abort);
      if (request.signal.aborted) { request.reject(request.signal.reason); continue; }
      if (request.parallel) this.readers++; else this.writer = true;
      let released = false;
      request.resolve(() => {
        if (released) return;
        released = true;
        if (request.parallel) this.readers--; else this.writer = false;
        this.drain();
      });
      if (this.writer) return;
    }
  }
}
