/** Node adapter using only public OpenAI SDK APIs. Browser hosts supply another factory. */
import type OpenAI from 'openai';
import { ResponsesWS } from 'openai/resources/responses/ws';
import type { ResponsesConnection, ResponsesConnectionFactory, NativeItem } from './connector.js';

export function officialConnectionFactory(clientFactory: () => OpenAI | Promise<OpenAI>): ResponsesConnectionFactory {
  return async (signal) => {
    signal.throwIfAborted();
    const client = await clientFactory();
    signal.throwIfAborted();
    const socket = new ResponsesWS(client, { reconnect: null });
    // Register eagerly so no frame can race the consumer's first next().
    const stream = socket.stream();
    const connection: ResponsesConnection = {
      send(event) { socket.send(event as unknown as Parameters<ResponsesWS['send']>[0]); },
      close() { socket.close(); },
      events: (async function* () {
          for await (const item of stream) {
            if (item.type === 'message') yield item.message as unknown as NativeItem;
            if (item.type === 'error') throw item.error;
            if (item.type === 'close') { signal.throwIfAborted(); throw new Error('Responses connection closed; dispatched work has unknown outcome'); }
          }
      })(),
    };
    return connection;
  };
}
