# HP Node tools, explicit skills and MCP

This bounded research spike supplies usable host tools to the portable
[039 runtime](../039-hp-agent-runtime/README.md). It does not invoke native Codex
to implement tools, submit model requests, or install a daemon. The
[matched coding evaluation](../045-hp-behavior/README.md) can reuse the exports; its
provider compatibility and spend belong to that evaluation, not these local tests.

The copied native patch grammar retains its source attribution in `patch.ts`;
the upstream [license](CODEX-LICENSE) and [notice](CODEX-NOTICE) are included.

## Run

From `experiments/`, using the shared workspace installation:

```sh
pnpm --filter @agent-spike/042-hp-tools-skills test
pnpm --filter @agent-spike/042-hp-tools-skills typecheck
pnpm --filter @agent-spike/042-hp-tools-skills probe
pnpm --filter @agent-spike/042-hp-tools-skills build
pnpm --filter @agent-spike/042-hp-tools-skills native
```

The last command additionally requires the existing pinned native binary at
`artifacts/003-codex-control/target/debug/codex` or `HP_CODEX_BINARY`, and the
[pinned source checkout](../../vendor/README.md). It never builds Codex or runs a
model turn. It uses isolated temporary `HOME`/`CODEX_HOME` and files, then removes
that state. Ordinary tests and HP implementation require no native binary.

Local observed results on 2026-10-18: **20 tests pass**, strict TypeScript passes,
the local probe succeeds, and the browser-target remote/MCP bundle builds.
Tests execute real subprocesses, fix a genuinely failing `node --test` case with
the patch tool, exchange bytes with a yielded process session, kill its owned
process group on cancellation, exercise an eleven-case patch corpus, reload
skills from disk, and perform real HTTP MCP initialization/list/call/error/
cancellation through the official SDK. These are not model-response fixtures.
The existing source-pin native binary (`codex-cli 0.0.0`) matches HP's success/
failure and resultant file bytes on **11/11** corpus cases; native app-server
buffered exit/output and interactive stdin comparisons also pass. Error wording,
session transport envelopes and combined versus separate streams differ.

Generated reports and bundles stay under ignored
`artifacts/042-hp-tools-skills/`: `local-summary.json`, `native-summary.json` and
`remote.js`. Node 26.10.0, pnpm 11.9.0, TypeScript 7.0.2, tsx 4.23.15, esbuild
0.28.2 and official MCP SDK **1.32.1**. Paid requests: **0**, estimated cost USD 0.

## Node API and result conventions

```ts
import { AgentRuntime } from '../039-hp-agent-runtime/src/runtime.ts';
import { createNodeTools, createSkillContext, createSkillTools } from './src/index.ts';

const skills = await createSkillContext({ roots: ['/scratch/task/.agents/skills'] });
const tools = createNodeTools({ cwd: '/scratch/task' });
const runtime = new AgentRuntime({
  connector: hostConnector,
  tools: [...tools, ...createSkillTools(skills)],
  instructions: `${hostInstructions}\n\nAvailable skills:\n${skills.renderCatalog()}`,
});
// The host eventually waits for its runtime work, then releases any remaining processes.
await tools.close();
```

`createNodeTools({cwd})` returns a normal 039 `Tool[]`, augmented with
`close(): Promise<void>` and `sessions()` inspection. The runtime still owns
model rounds, tool-result pairing, cancellation signals and journaling. The
host owns tool lifetime and must call `close()` on shutdown.

| Tool | Input | Output string decoded as JSON |
| --- | --- | --- |
| `exec_command` | Native-like `cmd`, `workdir?`, `shell?`, `login?`, `tty?`, `yield_time_ms?`, `max_output_tokens?` | `{chunk_id,wall_time_seconds,output,exit_code? \| session_id?,termination_signal?}` |
| `write_stdin` | Native-like `session_id`, `chars?`, `yield_time_ms?`, `max_output_tokens?` | Same result; output contains only newly collected stdout/stderr. |
| `apply_patch` | Native custom/freeform patch text; no JSON wrapper | `{output,changes:[{kind,path,move_path?,before,after}]}` |
| `load_skill` (optional) | `{name}` matching a catalog name or full `SKILL.md` path | `{name,description,text,origin}` with exact full source text. |

Nonzero shell exit is a normal result carrying its exit code. Startup failures,
invalid session IDs and cancellation throw, allowing 039 to mark failed tool
execution. A yielded command has no runtime lifetime limit; explicit operation
cancellation or `close()` terminates only the process group created by this
executor, first with SIGTERM, then SIGKILL after 250 ms if necessary. Group
tracking survives leader/stdio closure, so redirected descendants that ignore
TERM remain subject to escalation. Disappeared group IDs are retired; no
process-name cleanup is used. These group semantics were tested on POSIX, not
Windows, and do not cover descendants that deliberately create another session.
Wait/yield
controls when the caller receives output, not when a command is killed.

The shell implementation is deliberately **pipes only**. `tty:true` reports
unsupported; it does not pretend pipes are a terminal. The shell defaults to
`$SHELL` or `/bin/sh`, and `login` defaults true (`-lc`); tests choose false.
Both stdout and stderr enter one ordered capture as Node receives their chunks.
UTF-8 decoders preserve characters split across stream chunks. Session IDs are
local to the returned tool set, and a completed session is removed after its
final output is collected. A signalled process reports `exit_code:-1` plus
`termination_signal`, rather than pretending native signal-code equivalence.

No blanket process timeout, output quota or initial capture truncation is added.
`max_output_tokens` is explicitly **advisory** in this spike: full output returns,
with `output_budget_note` when the field was supplied. Native token accounting,
truncation/chunk IDs, PTY resize/control characters and stdin EOF controls are
not reproduced. Spawned commands inherit the host environment; it is never
printed or captured by the adapter itself. Tests isolate filesystem state and
unset Node's test-runner-only `NODE_TEST_CONTEXT` for the nested `node --test`
invocation so it runs as an ordinary standalone test process.

## Patch behavior and comparison boundary

[`patch.ts`](src/patch.ts) retains the exact small native Lark grammar from
Codex `6c372fbef45f730b6d8aa727b0ec8332365588db`
[`core/assets/tools/apply_patch.lark`](https://github.com/habemus-papadum/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/assets/tools/apply_patch.lark)
(upstream Apache-2.0). Its independent implementation supports add/overwrite,
update, delete, update-and-move, multiple ordered chunks, `@@` context anchors,
EOF matching, missing trailing newline, and native-style exact → trailing-space
→ trimmed-space → common Unicode punctuation context matching. It creates
missing parent directories. Relative and absolute paths resolve against the
explicit cwd; this is an operator-trusted tool, not a sandbox.

All syntax is parsed before writes. File operations then apply sequentially;
later failure can leave earlier edits, and `PatchFailure.applied` records them.
If a move writes its destination but source removal fails, the error records
that actual destination add/overwrite with `partial_move_from` and
`source_removed:false`; it does not claim that nothing changed. A real
permission-denial test covers that partial-move state.
Successful results include native-style human output plus structured file
changes for history consumers. The additional JSON wrapper is HP's explicit
integration convention, not native output byte identity.

The native probe compares all eleven cases against the actual existing binary's
`--codex-run-as-apply-patch` dispatch and compares buffered exit/output plus
interactive stdin against actual app-server `command/exec`. The latter is
**not** a claim to have directly invoked the model's unified-exec handler. The
source tool options were inspected in
[`shell_spec.rs`](https://github.com/habemus-papadum/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/tools/handlers/shell_spec.rs),
[`apply_patch_spec.rs`](https://github.com/habemus-papadum/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/tools/handlers/apply_patch_spec.rs),
and the apply-patch parser/replacement/source-file modules. Complete native
parser leniency, heredoc wrappers, executor URI paths, environment IDs, mixed
newline preservation and every filesystem race/symlink behavior remain outside
this small parser's claimed coverage.

## Skill acquisition and provenance

Only caller-supplied roots are read. A root can be one `SKILL.md`, a skill
directory, or a directory of immediate child skill directories. No ordinary
agent home, hidden extra search path or credential file is inspected.
`createSkillContext` reads name and description frontmatter for a catalog;
`load(nameOrPath)` reads the full file again and returns its exact text plus
absolute path, SHA-256, modified time and an optional host-supplied revision.
Changed source yields a changed digest. Duplicate names require an explicit full
path rather than silently choosing a different skill.

The frontmatter reader supports common single-line strings, quoted strings and
literal/folded block descriptions. It is not a complete YAML parser. This spike
does not reproduce native discovery precedence, automatic skill invocation,
dependency installation, catalogs from plugins/cloud environments or native
skill-context budgets. Loaded text is data for the host to import with its
origin into aiui-prompts or add to its own model context. Loading does not
execute instructions or mutate runtime prompts implicitly.

## MCP and browser/application separation

```ts
import { connectHttpMcp, createMcpTools } from './src/mcp.ts';
const connection = await connectHttpMcp('http://127.0.0.1:PORT/mcp');
try {
  const tools = await createMcpTools(connection.client, { serverName: 'local' });
  // Supply tools to the runtime. The host owns connection lifetime.
} finally { await connection.close(); }
```

The official client initializes a real MCP Streamable HTTP session and paginates
`tools/list`. Each function adapter keeps its original input JSON Schema and
maps its name to `mcp__SERVER__TOOL`; generated-name collisions fail explicitly.
`tools/call` receives the original server tool name and cancellation signal.
Full content arrays, resource blocks, structured content and metadata survive
as returned JSON. `isError:true` throws `McpToolFailure` whose string is that same
JSON, so 039 marks failure while retaining the complete server result.

The local service is a real disposable TCP server using the official server
transport. Its echo/resource, failure and cancellable wait procedures exercise
the protocol; they do not simulate provider reasoning. MCP resources/prompts,
OAuth flows, reconnects, discovery changes, deferred loading and multimodal
model delivery are not qualified. In particular, 039's tool result remains a
string: preserving image/resource JSON is not equivalent to delivering an image
to the model as multimodal content.

[`remote.ts`](src/remote.ts) is the browser entry. It bundles official HTTP MCP
client support and `createRemoteTools(definitions, invoke)` without Node process
or filesystem imports. A browser/application supplies its own execution RPC,
headers/authentication, transport lifetime and abort propagation. It cannot
start local processes or read disk by importing this adapter.
