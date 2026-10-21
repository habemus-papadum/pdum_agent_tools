import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory } from './inventory.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const nativeRoot = process.env.CODEX_SOURCE_CHECKOUT ?? join(root, 'vendor/codex');
const pin = '6c372fbef45f730b6d8aa727b0ec8332365588db';
const git = (args) => execFileSync('git', ['-C', nativeRoot, ...args], { encoding: 'utf8' }).trim();
assert.equal(git(['rev-parse', 'HEAD']), pin, 'Audit requires the recorded native source pin');
const fingerprints = new Map();
async function inspect(reference, native) {
  const absolute = join(native ? nativeRoot : root, reference.path);
  const text = await readFile(absolute, 'utf8');
  const key = `${native ? 'native' : 'hp'}:${reference.path}`;
  if (!fingerprints.has(key)) fingerprints.set(key, { side: native ? 'native' : 'hp', path: reference.path,
    sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) });
  const at = reference.anchor ? text.indexOf(reference.anchor) : 0;
  assert(at >= 0, `Citation anchor missing: ${reference.path}: ${reference.anchor}`);
  const line = text.slice(0, at).split('\n').length;
  return { ...reference, line, ...(native ? { url: `https://github.com/habemus-papadum/codex/blob/${pin}/${reference.path}#L${line}` } : {}) };
}
const items = [];
for (const item of inventory) {
  assert(['P0', 'P1', 'P2'].includes(item.priority));
  assert(['retain-early', 'defer', 'host-specific'].includes(item.decision));
  assert(item.confidence.hp, `Feature needs an explicit HP confidence boundary: ${item.id}`);
  assert(item.native.length && item.tests.length, 'Every row needs source and test/inspection references');
  items.push({ ...item,
    native: await Promise.all(item.native.map((ref) => inspect(ref, true))),
    tests: await Promise.all(item.tests.map((ref) => inspect(ref, true))),
    hpFiles: await Promise.all(item.hpFiles.map((ref) => inspect(ref, false))),
  });
}
const report = { date: new Date().toISOString(), native: { revision: pin, dirty: git(['status', '--porcelain']) !== '' },
  node: process.version, inventoryItems: items.length,
  priorities: Object.fromEntries(['P0', 'P1', 'P2'].map((priority) => [priority, items.filter((item) => item.priority === priority).length])),
  proof: 'Source-citation and file-fingerprint verification ONLY; does not execute referenced Rust/HP tests or establish parity.',
  modelRequests: 0, estimatedUsd: 0, items, files: [...fingerprints.values()] };
const artifacts = join(root, 'artifacts/046-hp-power-user-audit');
await mkdir(artifacts, { recursive: true });
await writeFile(join(artifacts, 'inventory.json'), JSON.stringify(report, null, 2));
const links = (refs) => refs.map((ref) => `[${ref.path.split('/').slice(-2).join('/')}:${ref.line}](${ref.url})`).join('<br>');
const hpLinks = (refs) => refs.map((ref) => `[${ref.path.split('/').slice(-2).join('/')}:${ref.line}](../../${ref.path})`).join('<br>');
const rows = items.map((item) => `| ${item.priority} · ${item.id} | ${item.decision} | ${item.contract.replaceAll('|', '\\|')} | ${links(item.native)} | ${links(item.tests)} | ${item.hpEvidence.replaceAll('|', '\\|')}<br>${hpLinks(item.hpFiles)} | ${item.confidence.native}; HP: ${item.confidence.hp} |`);
const markdown = `# Power-user feature matrix\n\nRegenerate from experiments/: \`node spikes/046-hp-power-user-audit/audit.mjs --write-doc\`. Native reference: \`${pin}\`.\n\n${report.proof}\n\nCurrent HP evidence distinguishes 047's final 17 portable controls passing unchanged in Node and real Chrome 155, 13 original Node runtime tests, and 049's six browser integration scenarios: 23 portable cases passed in Chrome. Final browser summary: ignored \`artifacts/049-hp-control-integration/browser-controls-final.json\`. Selected live evidence remains the Node six-response control flow and the separate six-response actual-browser 045 model-selected delegation recheck. These qualify named flows, not every row or native parity. This report contains source analysis and summarized outcomes only, with no raw captures, prompts or credentials.\n\n| Feature | Decision | Observable native contract | Native source | Native test references (not run by this audit) | Current HP evidence / remaining gate / source | Confidence boundary |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`;
await writeFile(join(artifacts, 'inventory.md'), markdown);
if (process.argv.includes('--write-doc')) await writeFile(fileURLToPath(new URL('./feature-matrix.md', import.meta.url)), markdown);
console.log(JSON.stringify({ inventoryItems: items.length, priorities: report.priorities, files: fingerprints.size,
  nativeRevision: pin, nativeDirty: report.native.dirty, artifact: join(artifacts, 'inventory.json'), modelRequests: 0, estimatedUsd: 0, proof: report.proof }, null, 2));
