import { createServer } from "node:http";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";

type Message = Record<string, unknown>;
export type Action = { name: string; arguments: Message } | { text: string };

export async function startFixture() {
  const requests: Message[] = [];
  const actions: Action[] = [];
  const errors: string[] = [];
  let sequence = 0;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      let body = Buffer.concat(chunks);
      if (request.headers["content-encoding"] === "gzip") body = gunzipSync(body);
      if (request.headers["content-encoding"] === "deflate") body = inflateSync(body);
      if (request.headers["content-encoding"] === "br") body = brotliDecompressSync(body);
      const parsed = body.length > 0 ? JSON.parse(body.toString()) as Message : {};
      requests.push({ method: request.method, url: request.url, body: parsed });
      if (!request.url?.endsWith("/responses")) {
        response.writeHead(404).end("fixture endpoint missing");
        return;
      }
      const action = actions.shift() ?? { text: "Fixture finished." };
      const id = `response_${++sequence}`;
      const item = "name" in action
        ? { type: "function_call", id: `function_${sequence}`, call_id: `call_${sequence}`, name: action.name, arguments: JSON.stringify(action.arguments) }
        : { type: "message", id: `message_${sequence}`, role: "assistant", content: [{ type: "output_text", text: action.text }] };
      const events = [
        { type: "response.created", response: { id } },
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { id, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    } catch (error) {
      errors.push(String(error));
      response.writeHead(500).end("fixture parse error");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  return {
    url: `http://127.0.0.1:${address.port}/v1`, requests, actions, errors,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
