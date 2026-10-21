import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export interface SkillOrigin extends Record<string, string> { kind: 'skill-file'; path: string; sha256: string; modifiedAt: string; revision?: string }
export interface SkillEntry { name: string; description: string; path: string; origin: SkillOrigin }
/** Narrow string frontmatter reader, not a general YAML interpreter. Fails on unsupported value shapes. */
function field(header: string, key: string): string {
  const lines = header.split(/\r?\n/); const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index < 0) throw new Error(`SKILL.md requires ${key} frontmatter`);
  const raw = lines[index]!.slice(key.length + 1).trim();
  if (raw === '|' || raw === '>' || raw === '|-' || raw === '>-') {
    const subsequent: string[] = [];
    for (let i = index + 1; i < lines.length && /^\s/.test(lines[i]!); i++) subsequent.push(lines[i]!.trim());
    return subsequent.join(raw.startsWith('>') ? ' ' : '\n').trim();
  }
  if (raw.startsWith('"')) return JSON.parse(raw) as string;
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  if (!raw || /^[\[{]/.test(raw)) throw new Error(`Unsupported ${key} frontmatter value`);
  return raw.replace(/\s+#.*$/, '');
}
async function inspect(path: string, revision?: string): Promise<{ entry: SkillEntry; text: string }> {
  const [text, metadata] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error(`Missing frontmatter: ${path}`);
  const name = field(match[1]!, 'name'); const description = field(match[1]!, 'description');
  if (!name.trim() || !description.trim()) throw new Error(`Empty skill metadata: ${path}`);
  return { text, entry: { name, description, path, origin: {
    kind: 'skill-file', path, sha256: createHash('sha256').update(text).digest('hex'), modifiedAt: metadata.mtime.toISOString(), ...(revision ? { revision } : {}),
  } } };
}

/** Explicit roots only: a root SKILL.md, or immediate child skill directories. No implicit home reads. */
export async function createSkillContext(options: { roots: string[]; revision?: string }) {
  const paths = new Set<string>();
  for (const input of options.roots) {
    const root = resolve(input);
    if (basename(root) === 'SKILL.md') { paths.add(root); continue; }
    try { if ((await stat(join(root, 'SKILL.md'))).isFile()) { paths.add(join(root, 'SKILL.md')); continue; } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const path = join(root, entry.name, 'SKILL.md');
      try { if ((await stat(path)).isFile()) paths.add(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  const catalog = await Promise.all([...paths].sort().map(async (path) => (await inspect(path, options.revision)).entry));
  return {
    catalog,
    renderCatalog: () => catalog.map((skill) => `- ${skill.name}: ${skill.description} (file: ${skill.path})`).join('\n'),
    async load(nameOrPath: string) {
      const matches = catalog.filter((skill) => skill.name === nameOrPath || skill.path === nameOrPath);
      if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous skill ${nameOrPath}; use its full path` : `Unknown catalog skill ${nameOrPath}`);
      const loaded = await inspect(matches[0]!.path, options.revision);
      return { text: loaded.text, origin: loaded.entry.origin, name: loaded.entry.name, description: loaded.entry.description };
    },
  };
}
export type SkillContext = Awaited<ReturnType<typeof createSkillContext>>;
