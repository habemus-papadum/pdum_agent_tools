import type { NativeItem, ResponsesConnectionFactory } from '../../038-hp-sdk-fit/src/connector.ts';

/** The hosting app supplies a URL or overrides construction; no key/token logic belongs here. */
export function browserConnectionFactory(url: string, construct: (url: string) => WebSocket = (value) => new WebSocket(value)): ResponsesConnectionFactory {
  return async (signal) => {
    signal.throwIfAborted();
    const socket = construct(url);
    const queue: NativeItem[] = [];
    let wake: (() => void) | undefined; let ended = false; let failure: Error | undefined;
    socket.addEventListener('message', (event) => {
      try { queue.push(JSON.parse(String(event.data))); } catch (error) { failure = new Error(String(error)); }
      wake?.();
    });
    socket.addEventListener('close', () => { ended = true; wake?.(); });
    socket.addEventListener('error', () => { failure = new Error('WebSocket connection error'); wake?.(); });
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener('abort', abort);
        socket.removeEventListener('open', open); socket.removeEventListener('error', error); socket.removeEventListener('close', close);
      };
      const abort = () => { cleanup(); socket.close(); reject(signal.reason ?? new Error('WebSocket opening aborted')); };
      const open = () => { if (signal.aborted) { abort(); return; } cleanup(); resolve(); };
      const error = () => { cleanup(); socket.close(); reject(new Error('WebSocket failed to open')); };
      const close = () => { cleanup(); reject(new Error('WebSocket closed before open')); };
      socket.addEventListener('open', open); socket.addEventListener('error', error); socket.addEventListener('close', close);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    // After opening, the connector owns active-round cancellation. Do not retain a
    // finished turn's AbortSignal on a socket reused by subsequent turns.
    return {
      send: (event) => socket.send(JSON.stringify(event)), close: () => socket.close(),
      events: (async function* () {
        for (;;) {
          if (queue.length) { yield queue.shift()!; continue; }
          if (failure) throw failure;
          if (ended) return;
          await new Promise<void>((resolve) => { wake = resolve; }); wake = undefined;
        }
      })(),
    };
  };
}
