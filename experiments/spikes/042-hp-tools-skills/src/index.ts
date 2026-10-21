import type { Tool } from '../../039-hp-agent-runtime/src/runtime.ts';
import type { JobRegistry } from '../../039-hp-agent-runtime/src/jobs/registry.ts';
import { ExecSessions, type ExecArgs, type StdinArgs } from './exec.ts';
import { applyPatch, nativeApplyPatchGrammar, PatchFailure } from './patch.ts';
import type { SkillContext } from './skills.ts';
export { ExecSessions } from './exec.ts';
export { applyPatch, nativeApplyPatchGrammar, PatchFailure } from './patch.ts';
export { createSkillContext } from './skills.ts';
export { createMcpTools, connectHttpMcp } from './mcp.ts';
export { createRemoteTools } from './remote.ts';

const string = (description: string) => ({ type: 'string', description });
const number = (description: string) => ({ type: 'number', description });
const func = (name: string, description: string, properties: Record<string, unknown>, required: string[]): Tool['definition'] => ({
  type: 'function', name, description, strict: false, parameters: { type: 'object', properties, required, additionalProperties: false },
});
export type NodeTools = Tool[] & {
  close(): Promise<void>; sessions(): ReturnType<ExecSessions['sessions']>;
  terminate(sessionId: number): ReturnType<ExecSessions['terminate']>; jobs: JobRegistry; ownerId: string;
};
/** Native-name tools with host-owned Node implementations; no Codex executable dependency. */
export function createNodeTools(options: { cwd: string; jobs?: JobRegistry; ownerId?: string }): NodeTools {
  const sessions = new ExecSessions(options.cwd, options);
  const tools: Tool[] = [
    {
      definition: func('exec_command', 'Runs a command in a PTY, returning output or a session ID for ongoing interaction. HP currently supports pipes only; tty:true reports unsupported.', {
        cmd: string('Shell command to execute.'), workdir: string('Working directory for the command. Defaults to the turn cwd.'),
        shell: string("Shell binary to launch. Defaults to the user's default shell."),
        login: { type: 'boolean', description: 'True runs the shell with -l/-i semantics; false disables them. Defaults to true.' },
        tty: { type: 'boolean', description: 'HP pipes implementation supports false; true requires an application PTY adapter.' },
        yield_time_ms: number('Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.'),
        max_output_tokens: number('Advisory output budget in this spike; all captured output is returned without truncation.'),
      }, ['cmd']),
      async execute(text, context) {
        const provenance = { ...(context.threadId === undefined ? {} : { threadId: context.threadId }),
          ...(context.turnId === undefined ? {} : { turnId: context.turnId }) };
        return JSON.stringify(await sessions.exec(JSON.parse(text) as ExecArgs, context.signal, provenance));
      },
    },
    {
      definition: func('write_stdin', 'Writes characters to an existing unified exec session and returns recent output.', {
        session_id: number('Identifier of the running unified exec session.'), chars: string('Bytes to write to stdin. Defaults to empty, which polls without writing.'),
        yield_time_ms: number('Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls default to 5000 ms and cap at 300000 ms.'),
        max_output_tokens: number('Advisory output budget in this spike; all captured output is returned without truncation.'),
      }, ['session_id']),
      async execute(text, context) { return JSON.stringify(await sessions.write(JSON.parse(text) as StdinArgs, context.signal)); },
    },
    {
      definition: { type: 'custom', name: 'apply_patch',
        description: 'The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.',
        format: { type: 'grammar', syntax: 'lark', definition: nativeApplyPatchGrammar } },
      async execute(patch, context) {
        try { return JSON.stringify(await applyPatch(patch, options.cwd, context.signal)); }
        catch (error) {
          if (error instanceof PatchFailure && error.applied.length) throw new Error(`${error.message}\nAlready applied changes: ${JSON.stringify(error.applied)}`);
          throw error;
        }
      },
    },
  ];
  return Object.assign(tools, { close: () => sessions.close(), sessions: () => sessions.sessions(),
    terminate: (sessionId: number) => sessions.terminate(sessionId), jobs: sessions.jobs, ownerId: sessions.ownerId });
}
/** Explicit loading is a separate action from listing the catalog in the prompt. */
export function createSkillTools(skills: SkillContext): Tool[] {
  return [{
    definition: func('load_skill', 'Load the exact SKILL.md text and source provenance for one catalog skill. Use its full path when names are ambiguous.', { name: string('Catalog skill name or full SKILL.md path.') }, ['name']),
    async execute(text) { return JSON.stringify(await skills.load((JSON.parse(text) as { name: string }).name)); },
  }];
}
