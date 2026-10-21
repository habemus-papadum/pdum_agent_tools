import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (!['/', '/index.html', '/browser.js', '/worker.js', '/browser.js.map', '/worker.js.map'].includes(path)) { response.writeHead(404).end(); return; }
  try { response.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.map') ? 'application/json' : 'text/html'); response.end(await readFile(`${root}${path === '/' ? 'index.html' : path.slice(1)}`)); }
  catch { response.writeHead(404).end('Run pnpm build first.'); }
});
server.listen(Number(process.env.HP_PORT ?? 8039), '0.0.0.0', () => console.log(`HP Agent demo http://localhost:${(server.address() as { port: number }).port}`));
