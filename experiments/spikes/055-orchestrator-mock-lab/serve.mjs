import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { readFile, stat, access, mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { createMarkdownPage } from './markdown-page.mjs';
import { createHistoryReader } from '../058-native-history-access/read-adapter.mjs';
import { createFamilyReader } from './family-reader.mjs';

const directory = resolve(fileURLToPath(new URL('./', import.meta.url)));
const repo = resolve(directory, '../../..');
const defaults = {
  aiuiRoot: resolve(repo, '.dev/aiui'),
  historyDirectory: resolve(repo, 'experiments/artifacts/058-native-history-access'),
};
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.md': 'text/plain', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm' };

/** Disposable application host. Native history is read-only; Round B owns separate lab writes. */
export async function startMockServer(options = {}) {
  const host = options.host ?? '0.0.0.0';
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid preview port');
  const aiuiRoot = await realpath(resolve(options.aiuiRoot ?? defaults.aiuiRoot));
  const design = resolve(aiuiRoot, 'packages/aiui-design/src');
  const fonts = resolve(aiuiRoot, 'packages/aiui-design/node_modules/@fontsource');
  const variableFonts = resolve(aiuiRoot, 'packages/aiui-design/node_modules/@fontsource-variable');
  const markdownPage = await createMarkdownPage(aiuiRoot);
  const historyDirectory = resolve(options.historyDirectory ?? process.env.PDUM_HISTORY_EXPORT_DIR ?? defaults.historyDirectory);
  const history = createHistoryReader(historyDirectory);
  const families = createFamilyReader(historyDirectory, {
    configPath: options.familyConfig ?? process.env.PDUM_HISTORY_FAMILIES_CONFIG,
  });
  // Consume Habemus Papadum styles/fonts from the source checkout; no upstream copies.
  await Promise.all([access(join(design, 'site.css')), access(join(fonts, 'cormorant-garamond/400.css')), access(join(fonts, 'libre-franklin/400.css'))]);
  const id = randomUUID();
  const stateDirectory = await mkdtemp(join(options.stateParent ?? tmpdir(), 'pdum-orchestrator-mocks-'));
  const require = createRequire(import.meta.url);
  const duckdbPackage = resolve(dirname(require.resolve('@duckdb/duckdb-wasm')), '../package.json');
  const data = { dist: resolve(dirname(duckdbPackage), 'dist'), version: JSON.parse(await readFile(duckdbPackage, 'utf8')).version };
  const mounts = [
    [`/__data/duckdb-wasm-assets/${data.version}/`, data.dist],
    ['/__aiui-design/@fontsource-variable/', variableFonts],
    ['/__aiui-design/@fontsource/', fonts],
    ['/__aiui-design/', design],
    ['/__design/@fontsource-variable/', variableFonts],
    ['/__design/@fontsource/', fonts],
    ['/__design/', design],
    ['/053-orchestrator-overview/', resolve(directory, '../053-orchestrator-overview')],
    ['/054-orchestrator-session/', resolve(directory, '../054-orchestrator-session')],
    ['/058-native-history-access/', resolve(directory, '../058-native-history-access')],
    ['/059-historical-viewer/', resolve(directory, '../059-historical-viewer')],
    ['/060-authentication-flows/', resolve(directory, '../060-authentication-flows')],
    ['/061-ingestion-statistics/', resolve(directory, '../061-ingestion-statistics')],
    ['/062-launcher-connections/', resolve(directory, '../062-launcher-connections')],
    ['/063-profile-workbench/', resolve(directory, '../063-profile-workbench')],
    ['/064-history-continuation/', resolve(directory, '../064-history-continuation')],
    ['/065-session-lifecycle/', resolve(directory, '../065-session-lifecycle')],
    ['/067-live-session-workspace/', resolve(directory, '../067-live-session-workspace')],
    ['/history/', resolve(directory, '../059-historical-viewer')],
    ['/auth/', resolve(directory, '../060-authentication-flows')],
    ['/ingestion/', resolve(directory, '../061-ingestion-statistics')],
    ['/connections/', resolve(directory, '../062-launcher-connections')],
    ['/profiles/', resolve(directory, '../063-profile-workbench')],
    ['/session-lab/', resolve(directory, '../067-live-session-workspace')],
    ['/055-orchestrator-mock-lab/', directory],
    ...['053-orchestrator-overview', '054-orchestrator-session', '055-orchestrator-mock-lab',
      '058-native-history-access', '059-historical-viewer', '060-authentication-flows',
      '061-ingestion-statistics', '062-launcher-connections', '063-profile-workbench',
      '064-history-continuation', '065-session-lifecycle', '067-live-session-workspace']
      .map(name => [`/spikes/${name}/`, resolve(directory, '..', name)]),
    ['/docs/spikes/', resolve(repo, 'experiments/docs/spikes')],
    ['/docs/', resolve(repo, 'docs')],
  ];
  let details;
  let liveLab;
  const server = createServer();
  let vite;
  try {
    vite = await createViteServer({ configFile: join(directory, 'vite.config.ts'), appType: 'custom',
      cacheDir: join(stateDirectory, 'vite-cache'), logLevel: 'error',
      server: { middlewareMode: true, hmr: { server }, fs: { allow: [repo, aiuiRoot, stateDirectory] } },
    });
  } catch (error) { await rm(stateDirectory, { recursive: true, force: true }); throw error; }
  const viteRequest = (req, res) => vite.middlewares(req, res, () => { res.writeHead(404); res.end('Not found'); });
  server.on('request', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/__session-lab/')) {
        liveLab ??= await import('../067-live-session-workspace/server.mjs');
        if (await liveLab.handleRequest(req, res, url)) return;
        res.writeHead(404); res.end('Unknown live-session operation'); return;
      }
      // Each disposable working application owns its actual operations and lab
      // state. Merely opening the host does not ingest, create profiles or log in.
      if (url.pathname.startsWith('/__ingestion/')) {
        const { handleIngestionRequest } = await import('../061-ingestion-statistics/server.mjs');
        if (await handleIngestionRequest(req, res, url)) return;
        res.writeHead(404); res.end('Unknown ingestion operation'); return;
      }
      if (url.pathname.startsWith('/__management-lab/')) {
        const { handleRequest } = await import('../062-launcher-connections/server.mjs');
        if (await handleRequest(req, res, url)) return;
        res.writeHead(404); res.end('Unknown management operation'); return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (url.pathname === '/live/sessions') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ available: false, reason: 'This mock lab has no server-side model-session backend.' })); return;
      }
      if (url.pathname === '/__instance') {
        res.setHeader('Content-Type', 'application/json'); res.end(req.method === 'HEAD' ? undefined : JSON.stringify({
          ...details, providerCalls: liveLab ? null : 0,
          providerCallTracking: liveLab ? 'Not aggregated here; use provider-specific usage evidence' : 'No live-session backend loaded',
        })); return;
      }
      if (url.pathname === '/__history/catalog') {
        res.setHeader('Content-Type', 'application/json');
        let catalog;
        try { catalog = { ...(await history.catalog()), available: true }; }
        catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          catalog = { version: 1, available: false, sessions: [], reason: 'No local native-history export yet. Run the 058 exporter or select the labelled rendering specimen.' };
        }
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(catalog)); return;
      }
      if (url.pathname === '/__history/families') {
        res.setHeader('Content-Type', 'application/json');
        const catalog = await families.catalog();
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(catalog)); return;
      }
      const historyFamily = url.pathname.match(/^\/__history\/family\/([^/]+)$/);
      if (historyFamily) {
        res.setHeader('Content-Type', 'application/json');
        const family = await families.family(decodeURIComponent(historyFamily[1]));
        if (!family) {
          res.writeHead(404); res.end(req.method === 'HEAD' ? undefined : JSON.stringify({available:false,reason:'Unknown selected family'})); return;
        }
        if (!family.available) res.writeHead(family.code === 'missing-export' ? 503 : 400);
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(family)); return;
      }
      const historyDocument = url.pathname.match(/^\/__history\/document\/([^/]+)$/);
      if (historyDocument) {
        res.setHeader('Content-Type', 'application/json');
        const document = await history.document(decodeURIComponent(historyDocument[1]));
        if (!document) { res.writeHead(404); res.end(JSON.stringify({ error: 'Unknown native-history document' })); return; }
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(document)); return;
      }
      if (url.pathname.startsWith('/__history/assets/')) {
        const filename = url.pathname.slice('/__history/assets/'.length);
        // Only explicit exported raster assets. Original machine paths are never HTTP routes.
        const types = {png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', gif:'image/gif'};
        const match = filename.match(/^[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif)$/);
        let listed=false;
        if(match)try {listed=(await history.catalog()).sessions.some(entry =>
          entry.source?.assets?.some(asset => asset.path === `assets/${filename}`));}
        catch(error){if(error?.code!=='ENOENT')throw error;}
        if(listed){res.setHeader('Content-Type',types[match[1]]);
          res.end(req.method==='HEAD'?undefined:await readFile(join(historyDirectory,'assets',filename)));return;}
        const asset=match?await families.asset(filename):null;
        if(!asset){res.writeHead(404);res.end('Unknown exported image');return;}
        res.setHeader('Content-Type',asset.contentType);res.end(req.method==='HEAD'?undefined:asset.bytes);return;
      }
      let path = decodeURIComponent(url.pathname);
      if (path === '/') path = '/055-orchestrator-mock-lab/index.html';
      if (path === '/053-orchestrator-overview/data-engine.js') path = '/053-orchestrator-overview/data-engine.ts';
      for (const [prefix] of mounts) if (path === prefix.slice(0, -1)) { res.writeHead(302, { Location: prefix }); res.end(); return; }
      const mount = mounts.find(([prefix]) => path.startsWith(prefix));
      if (!mount) { viteRequest(req, res); return; }
      const [prefix, base] = mount;
      const relative = path.slice(prefix.length) || 'index.html';
      const file = resolve(base, relative);
      if (!file.startsWith(base + sep) || !(await stat(file)).isFile()) { res.writeHead(404); res.end('Not found'); return; }
      if (extname(file) === '.md' && url.searchParams.get('raw') !== '1') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(req.method === 'HEAD' ? undefined : markdownPage(await readFile(file, 'utf8'), { pathname: path }));
        return;
      }
      if (extname(file) === '.html') {
        const html = await readFile(file, 'utf8');
        const transformed = await vite.transformIndexHtml(path, html.replace(/src="\.\/(src\/main\.tsx|main\.tsx)"/g,
          (_, entry) => `src="/@fs/${resolve(base, entry)}"`));
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(req.method === 'HEAD' ? undefined : transformed); return;
      }
      if (!prefix.startsWith('/__') && ['.ts', '.tsx', '.js', '.mjs', '.css'].includes(extname(file))) {
        req.url = `/@fs/${file}${url.search}`; viteRequest(req, res); return;
      }
      res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
      res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch (error) {
      res.writeHead(error?.code === 'ENOENT' ? 404 : 400); res.end('Preview resource unavailable');
    }
  });
  let closing;
  const close = () => closing ??= (async () => {
    const httpClosed = new Promise((done, reject) => {
      server.close(error => error ? reject(error) : done());
      server.closeIdleConnections();
    });
    await liveLab?.closeLiveLab();
    await vite.close();
    await httpClosed;
    await rm(stateDirectory, { recursive: true, force: true });
  })();
  try {
    await new Promise((done, reject) => { server.once('error', reject); server.listen(port, host, done); });
    details = { type: 'mock-ready', id, pid: process.pid, url: `http://localhost:${server.address().port}/`, stateDirectory,
      mode: 'AIUI source-linked mock lab', duckdbVersion: data.version, history: 'read-only exported native records', providerCalls: 0 };
    await writeFile(join(stateDirectory, 'instance.json'), JSON.stringify(details, null, 2));
    return { ...details, close };
  } catch (error) { if (server.listening) await close(); else await rm(stateDirectory, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const preview = await startMockServer({ port: Number(process.env.PORT ?? 0), host: process.env.MOCK_HOST ?? '0.0.0.0',
    aiuiRoot: process.env.AIUI_CHECKOUT ?? defaults.aiuiRoot });
  console.log(JSON.stringify({ ...preview, close: undefined }));
  // Vite's dependency optimizer may finish a late cache write after close().
  // Only this CLI owner's directory is swept once more at actual process exit.
  process.once('exit', () => rmSync(preview.stateDirectory, { recursive: true, force: true }));
  const stop = () => { void preview.close().then(() => { process.exitCode = 0; }, error => { console.error(String(error)); process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
