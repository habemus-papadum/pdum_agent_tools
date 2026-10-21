import type { NativeItem } from '../../../038-hp-sdk-fit/src/connector.ts';
import type { Tool } from '../runtime.ts';
function functionTool(name: string, description: string, properties: NativeItem, required: string[], execute: Tool['execute']): Tool {
  return { definition: { type: 'function', name, description, parameters: { type: 'object', properties, required, additionalProperties: false }, strict: true }, execute };
}
const parseMessage = (text: string) => {
  const p = JSON.parse(text);
  if (Object.keys(p).some((key) => !['target', 'message'].includes(key)) || typeof p.target !== 'string' || typeof p.message !== 'string') throw new Error('Expected only target and message');
  return p as { target: string; message: string };
};
/** Native-v2 operation meanings translated to public function-tool JSON framing. Spawn remains prototype-shaped. */
export const agentControlTools: Tool[] = [
  functionTool('send_message', 'Queue an agent message. Does not start an idle recipient.', { target: { type: 'string' }, message: { type: 'string' } }, ['target', 'message'], async (text, ctx) => { const p = parseMessage(text); ctx.runtime.sendMessage(ctx.threadId, p.target, p.message); return ''; }),
  functionTool('followup_task', 'Start a new task on an idle child, or deliver it to a running child at a safe boundary.', { target: { type: 'string' }, message: { type: 'string' } }, ['target', 'message'], async (text, ctx) => { const p = parseMessage(text); ctx.runtime.followupTask(ctx.threadId, p.target, p.message); return ''; }),
  functionTool('wait_agent', 'Wait for incoming agent activity or new input. Completed child content arrives through the mailbox.', { timeout_ms: { type: ['integer', 'null'] } }, ['timeout_ms'], async (text, ctx) => {
    const p = JSON.parse(text); if (Object.keys(p).some((key) => key !== 'timeout_ms')) throw new Error('wait_agent accepts only timeout_ms');
    const result = await ctx.runtime.waitAgent(ctx.threadId, { ...(p.timeout_ms == null ? {} : { timeoutMs: p.timeout_ms }), signal: ctx.signal });
    return JSON.stringify({ message: result.message, timed_out: result.timed_out, ...(result.warning ? { warning: result.warning } : {}) });
  }),
  functionTool('interrupt_agent', 'Interrupt one spawned agent, preserving its previous status. Does not interrupt descendants.', { target: { type: 'string' } }, ['target'], async (text, ctx) => {
    const p = JSON.parse(text); if (Object.keys(p).some((key) => key !== 'target') || typeof p.target !== 'string') throw new Error('Expected only target');
    return JSON.stringify(ctx.runtime.interruptAgent(ctx.threadId, p.target));
  }),
];
/** Backward-compatible prototype names. wait is targeted; send_input explicitly starts or steers a task. */
export const agentTools: Tool[] = [
  functionTool('spawn_agent', 'Start an independent child agent and return its ID.', { message: { type: 'string' } }, ['message'], async (text, ctx) => JSON.stringify(ctx.runtime.spawn(ctx.threadId, JSON.parse(text).message))),
  functionTool('send_input', 'Start or steer a child task (prototype compatibility operation).', { id: { type: 'string' }, message: { type: 'string' } }, ['id', 'message'], async (text, ctx) => { const p = JSON.parse(text); return JSON.stringify(await ctx.runtime.message(p.id, p.message)); }),
  functionTool('wait', 'Wait for a child or return when new input arrives. Does not cancel the child.', { id: { type: 'string' } }, ['id'], async (text, ctx) => JSON.stringify(await ctx.runtime.waitForChild(ctx.threadId, JSON.parse(text).id, { signal: ctx.signal }))),
  ...agentControlTools,
];
