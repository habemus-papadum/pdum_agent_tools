/** Pure, synthetic overview data. Nothing here describes an actual process. */
export const PROVIDERS = ['Codex', 'Claude', 'HP Node', 'HP Browser'];
export const HOSTS = ['atlas · local', 'forge-a', 'forge-b', 'this tab'];
export const STATUSES = ['working', 'waiting', 'idle', 'complete', 'error'];
export const GROUP_FIELDS = ['status', 'host', 'cwd', 'project', 'provider'];
export const STATUS_GROUP_ORDER = ['waiting', 'error', 'working', 'idle', 'complete'];
export const STATUS_LABELS = { working: 'Working', waiting: 'Needs input', idle: 'Idle', complete: 'Complete', error: 'Failed' };
const titles = [
  'SDK transport', 'History index', 'Prompt workshop', 'Orchestrator shell',
  'Context inspector', 'Worker cancellation', 'Session renderer', 'Profile migration',
  'Browser companion', 'Tool parallelism', 'Cost projection', 'Source annotations',
  'Relay reconnect', 'Credentials flow', 'Cell observer', 'Transcript fixtures',
  'Schema review', 'File reference resolver', 'CLI ergonomics', 'Research librarian',
  'Subagent mailbox', 'Model selector', 'Query optimizer', 'Test triage',
  'Browser scratchpad', 'Fork semantics', 'Agent inventory', 'Evidence exporter',
  'Async job adapter', 'Documentation pass', 'Accessibility review', 'Metrics ingestion',
  'Trace comparison', 'Prompt assistant', 'Release notes', 'Sandbox diagnosis',
];
const providers = ['Codex', 'HP Node', 'Claude', 'Codex', 'HP Node', 'Codex', 'Claude', 'Claude', 'HP Browser', 'HP Node', 'Codex', 'Claude', 'Codex', 'Claude', 'HP Node', 'HP Node', 'Codex', 'Claude', 'Codex', 'Claude', 'HP Node', 'Codex', 'HP Node', 'Claude', 'HP Browser', 'Codex', 'HP Node', 'HP Node', 'Codex', 'Claude', 'HP Browser', 'HP Node', 'Codex', 'HP Browser', 'Claude', 'Codex'];
const statuses = ['working', 'error', 'waiting', 'working', 'working', 'working', 'idle', 'waiting', 'idle', 'working', 'complete', 'working', 'working', 'waiting', 'working', 'complete', 'idle', 'working', 'complete', 'idle', 'working', 'working', 'working', 'error', 'working', 'idle', 'working', 'complete', 'working', 'complete', 'working', 'error', 'working', 'idle', 'complete', 'waiting'];
const activities = {
  working: ['Running the focused test suite', 'Reading the transport implementation', 'Comparing session event ordering', 'Preparing a small patch', 'Inspecting tool output'],
  waiting: ['Which profile should this run use?', 'Choose the session to resume', 'Need your preference for the empty state', 'Review the proposed file changes'],
  idle: ['Ready for the next task', 'Last turn finished; session remains open', 'Draft prepared for review'],
  complete: ['Finished; result available in history', 'Checks passed; report is ready'],
  error: ['Tool exited with code 1', 'Query failed: missing fixture table', 'Remote tool connection closed'],
};
export function createAgents(count = 36) {
  if (![36, 500].includes(count)) throw new Error('Supported fixture counts are 36 and 500');
  return Array.from({ length: count }, (_, i) => {
    const base = i % titles.length;
    const name = titles[base] + (i >= titles.length ? ` · ${String(Math.floor(i / titles.length) + 1).padStart(2, '0')}` : '');
    const provider = providers[base];
    const local = provider === 'HP Browser';
    const status = statuses[base];
    const host = local ? 'this tab' : HOSTS[i % 3];
    const stale = !local && [5, 12, 27].includes(base);
    const context = [2, 7, 13, 19, 25, 34].includes(base) ? null : 18 + ((i * 13 + 26) % 77);
    const cost = i % 7 === 2 ? null : Math.round((0.12 + ((i * 31 + 51) % 240) / 100) * 100) / 100;
    const profile = local ? 'page-local' : ['sdk-dev', 'research', 'workspace'][i % 3];
    return {
      id: `mock-agent-${String(i + 1).padStart(2, '0')}`, name, provider, local, host, profile, status,
      fresh: !stale, age: stale ? 6 * 60 + i * 2 : i % 5 + 1,
      model: provider === 'Claude' ? 'Haiku' : 'GPT-6 Luna',
      purpose: i < 8 ? 'Long-lived' : i < 25 ? 'Consultant' : 'Temporary',
      context, contextUsed: context === null ? null : context * 2000, contextLimit: context === null ? null : 200000,
      cost, coverage: cost === null ? 'unknown' : i % 5 === 1 ? 'partial' : 'complete',
      tools: 4 + i * 3, children: local ? 0 : i % 4, jobs: status === 'working' ? i % 3 : 0,
      cwd: local ? null : `/work/${i % 2 === 0 ? 'pdum_agent_tools' : 'pdum_aiui'}`,
      project: local ? 'browser-workspace' : i % 2 === 0 ? 'agent-tools' : 'aiui',
      activity: activities[status][i % activities[status].length],
      events: [
        { time: '11:42:08', type: 'observation', text: activities[status][i % activities[status].length] },
        { time: '11:41:52', type: 'tool', text: local ? 'Read published application state' : 'Read source and compare with the current task' },
        { time: '11:41:26', type: 'message', text: 'Identified the narrow change to investigate.' },
        { time: '11:40:03', type: 'turn', text: 'Task accepted; turn started' },
      ],
    };
  });
}
export function isAttention(agent) { return !agent.fresh || ['waiting', 'error'].includes(agent.status); }
export function groupValue(agent, field) { return GROUP_FIELDS.includes(field) ? String(agent[field] ?? '') : ''; }
/** Partition already ordered rows; the browser query engine owns ordering. */
export function groupAgents(agents, field) {
  if (!GROUP_FIELDS.includes(field)) return [];
  const groups = new Map();
  for (const agent of agents) {
    const value = groupValue(agent, field);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(agent);
  }
  return [...groups].map(([value, items]) => ({ value, agents: items }));
}
export function selectAgents(agents, filters) {
  const query = (filters.query || '').toLocaleLowerCase().trim();
  const result = agents.filter(a => (!query || [a.id, a.name, a.host, a.profile, a.activity, a.provider, a.project, a.cwd].join(' ').toLocaleLowerCase().includes(query))
    && (!filters.provider || a.provider === filters.provider)
    && (!filters.host || a.host === filters.host)
    && (!filters.status || (filters.status === 'attention' ? isAttention(a) : filters.status === 'stale' ? !a.fresh : a.status === filters.status)));
  return result.sort((a, b) => {
    const groupOrder = filters.group === 'status'
      ? STATUS_GROUP_ORDER.indexOf(a.status) - STATUS_GROUP_ORDER.indexOf(b.status)
      : groupValue(a, filters.group).localeCompare(groupValue(b, filters.group));
    if (groupOrder) return groupOrder;
    return filters.sort === 'name' ? a.name.localeCompare(b.name)
      : filters.sort === 'recent' ? a.age - b.age || a.id.localeCompare(b.id)
      : Number(isAttention(b)) - Number(isAttention(a)) || Number(b.status === 'waiting') - Number(a.status === 'waiting') || a.id.localeCompare(b.id);
  });
}
export function summarize(agents) {
  return { total: agents.length, working: agents.filter(a => a.status === 'working').length, waiting: agents.filter(a => a.status === 'waiting').length,
    attention: agents.filter(isAttention).length, stale: agents.filter(a => !a.fresh).length,
    knownCost: agents.reduce((sum, a) => sum + (a.cost ?? 0), 0), incomplete: agents.filter(a => a.coverage !== 'complete').length };
}
export function simulate(agents, targetId, scenario, step) {
  const target = agents.find(a => a.id === targetId);
  if (!target) return agents;
  return agents.map(a => {
    if (scenario === 'host-loss') {
      if (a.host !== target.host || a.local) return a;
      return { ...a, fresh: false, age: 360, events: [{ time: `+${step * 5}s`, type: 'gap', text: 'Observation link lost. Execution status is unconfirmed.' }, ...a.events] };
    }
    if (a.id !== targetId) return a;
    const changes = scenario === 'stale' ? { fresh: false, age: 360 }
      : scenario === 'input' ? { status: 'waiting', fresh: true, age: 0, activity: 'Need your choice: use the existing profile or a new one?' }
      : scenario === 'failure' ? { status: 'error', fresh: true, age: 0, activity: 'Tool failed: scripted test process exited with code 1' }
      : { status: 'working', fresh: true, age: 0, activity: ['Read the next source file', 'Focused checks are progressing', 'Compared results with the task'][step % 3], tools: a.tools + 1, context: a.context === null ? null : Math.min(a.context + 1, 98), contextUsed: a.context === null ? null : Math.min(a.context + 1, 98) * 2000, cost: a.cost === null ? null : Math.round((a.cost + 0.01) * 100) / 100 };
    const text = scenario === 'stale' ? 'No new observation. Last known execution state retained.' : changes.activity;
    return { ...a, ...changes, events: [{ time: `+${step * 5}s`, type: scenario === 'stale' ? 'gap' : scenario, text }, ...a.events] };
  });
}
export function evidenceFor(agent) {
  return { fixture: true, source: agent.local ? 'this-tab mock' : 'coordinator summary mock', observedAt: '2026-10-19T11:42:08-04:00',
    agentId: agent.id, provider: agent.provider, owner: agent.local ? 'this browser tab' : agent.host, profile: agent.profile, project: agent.project, cwd: agent.cwd,
    observation: { fresh: agent.fresh, ageSeconds: agent.age, executionStatus: agent.status, confirmedCurrent: agent.fresh },
    context: { usedTokens: agent.contextUsed, limitTokens: agent.contextLimit, percent: agent.context, source: 'synthetic fixture, not provider evidence' },
    usage: { estimatedApiEquivalentUsd: agent.cost, coverage: agent.coverage, actualBillingUsd: null, pricing: 'illustrative amounts; not a pricing calculation' },
    activity: agent.activity, events: agent.events };
}

/** Presentation-only focus/collapse. The caller keeps query aggregates unchanged.
 * @param {any[]} groups
 * @param {string} field
 * @param {string[]} collapsedKeys
 * @param {{field: string, value: string} | null} focus
 */
export function presentGroups(groups, field, collapsedKeys = [], focus = null) {
  const activeFocus = focus?.field === field ? focus.value : null;
  return groups.filter(group => activeFocus === null || group.value === activeFocus).map(group => ({
    ...group, collapsed: collapsedKeys.includes(JSON.stringify([field, group.value])),
  }));
}
