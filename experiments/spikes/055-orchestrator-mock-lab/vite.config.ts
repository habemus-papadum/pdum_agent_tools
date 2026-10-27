import { defineConfig, type UserConfig, type Plugin } from 'vite';
import aiui from '@habemus-papadum/aiui-source-processor';
import solid from 'vite-plugin-solid';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const duckdbPackage = resolve(dirname(require.resolve('@duckdb/duckdb-wasm')), '../package.json');
const version = JSON.parse(readFileSync(duckdbPackage, 'utf8')).version;
const shared = ['solid-js', '@solidjs/web', '@solidjs/signals',
  '@habemus-papadum/aiui-viz', '@habemus-papadum/aiui-design', '@habemus-papadum/aiui-dock',
  '@uwdata/vgplot', '@uwdata/mosaic-core', '@uwdata/mosaic-sql', '@duckdb/duckdb-wasm',
  'marked', 'katex', 'mermaid', 'highlight.js'];

// Resolve public package exports from the host's declared dependencies. The
// sibling entry points and linked library must share one framework runtime.
function sharedDependencies(): Plugin {
  return { name: 'mock-lab:shared-runtime', enforce: 'pre',
    async resolveId(id, _importer, options) {
      if (!shared.some(name => id === name || id.startsWith(name + '/'))) return;
      return this.resolve(id, resolve(directory, 'shared/dock.tsx'), { ...options, skipSelf: true });
    } };
}

export function mockViteConfig(command: 'build' | 'serve' = 'serve'): UserConfig {
  return {
    root: command === 'build' ? resolve(directory, '..') : directory,
    plugins: [sharedDependencies(), aiui({ locator: { stampRoots: [
      resolve(directory, '../053-orchestrator-overview'), resolve(directory, '../054-orchestrator-session'),
      resolve(directory, '../059-historical-viewer'), resolve(directory, '../060-authentication-flows'),
      resolve(directory, '../061-ingestion-statistics'), resolve(directory, '../062-launcher-connections'),
      resolve(directory, '../063-profile-workbench'), resolve(directory, '../067-live-session-workspace'),
    ] } }), solid()],
    define: { __DUCKDB_VERSION__: JSON.stringify(version) },
    optimizeDeps: { exclude: ['@solidjs/web/performance-tracks', '@habemus-papadum/aiui-viz', '@habemus-papadum/aiui-design', '@habemus-papadum/aiui-dock'] },
    build: {
      outDir: resolve(directory, '../../artifacts/055-orchestrator-mock-lab/build'), emptyOutDir: true,
      rollupOptions: { input: { overview: resolve(directory, '../053-orchestrator-overview/index.html'),
        session: resolve(directory, '../054-orchestrator-session/index.html'), lab: resolve(directory, 'index.html'),
        history: resolve(directory, '../059-historical-viewer/index.html'),
        authentication: resolve(directory, '../060-authentication-flows/index.html'),
        ingestion: resolve(directory, '../061-ingestion-statistics/index.html'),
        connections: resolve(directory, '../062-launcher-connections/index.html'),
        profiles: resolve(directory, '../063-profile-workbench/index.html'),
        liveSession: resolve(directory, '../067-live-session-workspace/index.html') } },
    },
  };
}
export default defineConfig(({ command }) => mockViteConfig(command));
