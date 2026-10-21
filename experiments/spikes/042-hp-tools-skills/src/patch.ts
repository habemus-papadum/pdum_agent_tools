import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// Exact source: Codex 6c372fbef45f730b6d8aa727b0ec8332365588db,
// codex-rs/core/assets/tools/apply_patch.lark (Apache-2.0). No native binary is called.
export const nativeApplyPatchGrammar = String.raw`start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;
interface Chunk { context?: string; old: string[]; next: string[]; eof: boolean }
type Hunk = { kind: 'add'; path: string; text: string } | { kind: 'delete'; path: string } |
  { kind: 'update'; path: string; move?: string; chunks: Chunk[] };
export interface PatchChange { kind: 'add' | 'delete' | 'update'; path: string; move_path?: string; before: string | null; after: string | null; partial_move_from?: string; source_removed?: boolean }
export interface PatchResult { output: string; changes: PatchChange[] }
export class PatchFailure extends Error {
  constructor(message: string, readonly applied: PatchChange[] = []) { super(message); this.name = 'PatchFailure'; }
}
const readText = async (path: string) => new TextDecoder('utf8', { fatal: true }).decode(await readFile(path));
function parse(text: string): Hunk[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') throw new PatchFailure('Patch must begin with *** Begin Patch and end with *** End Patch');
  const result: Hunk[] = []; let i = 1;
  while (i < lines.length - 1) {
    const line = lines[i++]!;
    if (!line.trim()) continue;
    const match = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(line);
    if (!match) throw new PatchFailure(`Invalid patch header at line ${i}: ${line}`);
    const path = match[2]!;
    if (match[1] === 'Delete') { result.push({ kind: 'delete', path }); continue; }
    if (match[1] === 'Add') {
      const added: string[] = [];
      while (lines[i]?.startsWith('+')) added.push(lines[i++]!.slice(1));
      if (!added.length) throw new PatchFailure(`Empty add hunk: ${path}`);
      result.push({ kind: 'add', path, text: added.join('\n') + '\n' }); continue;
    }
    const chunks: Chunk[] = []; let move: string | undefined;
    if (lines[i]?.startsWith('*** Move to: ')) move = lines[i++]!.slice('*** Move to: '.length);
    while (i < lines.length - 1 && !lines[i]!.startsWith('*** ')) {
      let context: string | undefined;
      if (lines[i] === '@@') i++;
      else if (lines[i]?.startsWith('@@ ')) context = lines[i++]!.slice(3);
      else if (chunks.length) throw new PatchFailure(`Expected @@ at line ${i + 1}`);
      const chunk: Chunk = { ...(context !== undefined ? { context } : {}), old: [], next: [], eof: false };
      let count = 0;
      while (i < lines.length - 1 && !lines[i]!.startsWith('@@') && !lines[i]!.startsWith('*** ')) {
        const change = lines[i++]!;
        if (!change.length) { chunk.old.push(''); chunk.next.push(''); count++; continue; }
        const marker = change[0];
        if (marker !== '+' && marker !== '-' && marker !== ' ') throw new PatchFailure(`Invalid change line ${i}: ${change}`);
        if (marker !== '+') chunk.old.push(change.slice(1));
        if (marker !== '-') chunk.next.push(change.slice(1)); count++;
      }
      if (!count) throw new PatchFailure(`Empty update chunk: ${path}`);
      if (lines[i] === '*** End of File') { chunk.eof = true; i++; while (lines[i] === '') i++; }
      chunks.push(chunk);
    }
    if (!chunks.length) throw new PatchFailure(`Empty update hunk: ${path}`);
    result.push({ kind: 'update', path, ...(move ? { move } : {}), chunks });
  }
  return result;
}
const punctuation = (s: string) => s.trim().replace(/[‐‑‒–—―−]/g, '-').replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, ' ');
function seek(lines: string[], pattern: string[], start: number, eof = false): number {
  if (!pattern.length) return eof ? lines.length : start;
  const begin = eof ? Math.max(start, lines.length - pattern.length) : start;
  for (const normalize of [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim(), punctuation]) {
    for (let i = begin; i <= lines.length - pattern.length; i++) {
      if (pattern.every((line, j) => normalize(line) === normalize(lines[i + j]!))) return i;
    }
  }
  return -1;
}
function update(before: string, chunks: Chunk[]): string {
  const lines = before.split(/\r?\n/); if (lines.at(-1) === '') lines.pop();
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      const anchor = seek(lines, [chunk.context], cursor);
      if (anchor < 0) throw new PatchFailure(`Failed to find @@ context: ${chunk.context}`);
      cursor = anchor + 1;
    }
    const at = chunk.old.length ? seek(lines, chunk.old, cursor, chunk.eof) : lines.length;
    if (at < 0) throw new PatchFailure(`Failed to find expected lines:\n${chunk.old.join('\n')}`);
    lines.splice(at, chunk.old.length, ...chunk.next); cursor = at + chunk.next.length;
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** Pragmatic native-format edits. Operations apply in order; later failure can leave earlier edits. */
export async function applyPatch(patch: string, cwd: string, signal?: AbortSignal): Promise<PatchResult> {
  const hunks = parse(patch); const changes: PatchChange[] = [];
  try {
    for (const hunk of hunks) {
      signal?.throwIfAborted(); const path = resolve(cwd, hunk.path);
      if (hunk.kind === 'add') {
        let before: string | null = null;
        try { before = await readText(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await mkdir(dirname(path), { recursive: true }); await writeFile(path, hunk.text);
        changes.push({ kind: 'add', path: hunk.path, before, after: hunk.text });
      } else if (hunk.kind === 'delete') {
        const before = await readText(path); await unlink(path);
        changes.push({ kind: 'delete', path: hunk.path, before, after: null });
      } else {
        const before = await readText(path); const after = update(before, hunk.chunks);
        const destination = resolve(cwd, hunk.move ?? hunk.path);
        let overwritten: string | null = null;
        if (destination !== path) {
          try { overwritten = await readText(destination); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, after);
        if (destination !== path) {
          // The destination already changed. Preserve that fact even if removing
          // the source fails; do not claim a side-effect-free move failure.
          const index = changes.length;
          changes.push({ kind: 'add', path: hunk.move!, before: overwritten, after, partial_move_from: hunk.path, source_removed: false });
          await unlink(path);
          changes[index] = { kind: 'update', path: hunk.path, move_path: hunk.move!, before, after };
        } else changes.push({ kind: 'update', path: hunk.path, before, after });
      }
    }
  } catch (error) { throw new PatchFailure(error instanceof PatchFailure ? error.message : String(error), changes); }
  const order = ['add', 'update', 'delete'];
  const listing = order.flatMap((kind) => changes.filter((change) => change.kind === kind).map((change) => `${kind === 'add' ? 'A' : kind === 'delete' ? 'D' : 'M'} ${change.move_path ?? change.path}`));
  return { output: changes.length ? `Success. Updated the following files:\n${listing.join('\n')}\n` : 'No files were modified.\n', changes };
}
