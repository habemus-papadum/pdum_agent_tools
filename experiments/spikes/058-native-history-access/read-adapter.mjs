/** Disposable local mock transport, not an agent-history ingestion schema. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function validateCatalog(catalog) {
  if (catalog?.version !== 1 || !Array.isArray(catalog.sessions)) throw new Error('Invalid native history catalog');
  const keys = new Set();
  for (const entry of catalog.sessions) {
    if (!/^(codex|claude)-[a-zA-Z0-9_-]+$/.test(entry.key) || keys.has(entry.key)) throw new Error('Invalid or duplicate document key');
    if (!['codex', 'claude'].includes(entry.provider) || !entry.sessionId || !entry.source?.method) throw new Error('Missing native history identity');
    keys.add(entry.key);
  }
  return catalog;
}

export function createHistoryReader(directory) {
  const catalog = async () => validateCatalog(JSON.parse(await readFile(join(directory, 'catalog.json'), 'utf8')));
  return {
    catalog,
    async document(key) {
      const entry = (await catalog()).sessions.find(entry => entry.key === key);
      if (!entry) return null;
      const document = JSON.parse(await readFile(join(directory, 'documents', `${entry.key}.json`), 'utf8'));
      if (document.key !== key || document.provider !== entry.provider || document.sessionId !== entry.sessionId) throw new Error('Document identity differs from catalog');
      return document;
    },
  };
}

export async function readCatalog(directory) {
  return createHistoryReader(directory).catalog();
}

export async function readDocument(directory, key) {
  return createHistoryReader(directory).document(key);
}
