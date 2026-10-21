export interface PatchCase { name: string; files: Record<string, string>; patch: string; succeeds: boolean; expected?: Record<string, string> }
const wrap = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
export const patchCorpus: PatchCase[] = [
  { name: 'add nested and overwrite', files: { 'old.txt': 'before\n' }, patch: wrap('*** Add File: nested/new.txt\n+one\n+\n+three\n*** Add File: old.txt\n+after'), succeeds: true, expected: { 'nested/new.txt': 'one\n\nthree\n', 'old.txt': 'after\n' } },
  { name: 'update and move', files: { 'old.txt': 'one\ntwo\nthree\n' }, patch: wrap('*** Update File: old.txt\n*** Move to: nested/moved.txt\n@@\n one\n-two\n+TWO\n three'), succeeds: true, expected: { 'nested/moved.txt': 'one\nTWO\nthree\n' } },
  { name: 'delete', files: { 'gone.txt': 'gone\n' }, patch: wrap('*** Delete File: gone.txt'), succeeds: true, expected: {} },
  { name: 'named context and whitespace fallback', files: { 'x.txt': 'section\n    old   \nend\n' }, patch: wrap('*** Update File: x.txt\n@@ section\n-old\n+new'), succeeds: true, expected: { 'x.txt': 'section\nnew\nend\n' } },
  { name: 'EOF repeated lines', files: { 'x.txt': 'same\nmiddle\nsame\n' }, patch: wrap('*** Update File: x.txt\n@@\n-same\n+final\n*** End of File'), succeeds: true, expected: { 'x.txt': 'same\nmiddle\nfinal\n' } },
  { name: 'pure append and missing newline', files: { 'x.txt': 'old' }, patch: wrap('*** Update File: x.txt\n@@\n+new'), succeeds: true, expected: { 'x.txt': 'old\nnew\n' } },
  { name: 'two ordered chunks', files: { 'x.txt': 'a\nb\nc\nd\n' }, patch: wrap('*** Update File: x.txt\n@@\n-a\n+A\n@@\n-d\n+D'), succeeds: true, expected: { 'x.txt': 'A\nb\nc\nD\n' } },
  { name: 'missing context fails unchanged', files: { 'x.txt': 'present\n' }, patch: wrap('*** Update File: x.txt\n@@\n-absent\n+replacement'), succeeds: false, expected: { 'x.txt': 'present\n' } },
  { name: 'missing delete fails', files: {}, patch: wrap('*** Delete File: missing.txt'), succeeds: false, expected: {} },
  { name: 'malformed header rejects all', files: {}, patch: wrap('*** Add File: a.txt\n+one\n*** Broken: bad'), succeeds: false, expected: {} },
  { name: 'later failure retains previous edit', files: {}, patch: wrap('*** Add File: a.txt\n+one\n*** Delete File: absent.txt'), succeeds: false, expected: { 'a.txt': 'one\n' } },
];
