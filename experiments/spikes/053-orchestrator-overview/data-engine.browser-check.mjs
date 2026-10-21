import { createOverviewData } from './data-engine.js';
import { createAgents, selectAgents, simulate } from './model.mjs';

/** Run from a served browser page. Exercises real WASM/SQL, not a mocked connector. */
export async function checkDataEngine() {
  const passed = [];
  const check = (condition, name) => { if (!condition) throw Error(name); passed.push(name); };
  const fixtures = createAgents();
  const engine = await createOverviewData(fixtures);
  try {
    for (const filters of [{}, { provider: 'Claude', host: 'forge-a', status: 'waiting' },
      { status: 'stale' }, { status: 'attention', sort: 'recent' }, { query: 'RETRY' }, { query: "' OR true --" }]) {
      const actual = await engine.query(filters);
      check(JSON.stringify(actual.agents.map(a => a.id)) === JSON.stringify(selectAgents(fixtures, filters).map(a => a.id)),
        `SQL agrees with independent fixture selection: ${JSON.stringify(filters)}`);
    }
    const filtered = await engine.query({ provider: 'Codex', host: 'forge-a' });
    check(filtered.facets.provider.find(r => r.value === 'Claude').count === 4,
      'Provider facet retains other providers under the host filter');
    check(filtered.facets.host.find(r => r.value === 'forge-b').count === 3,
      'Host facet retains other hosts under the provider filter');
    const byProvider = await engine.query({ host: 'forge-a', group: 'provider', sort: 'recent' });
    check(byProvider.groups.reduce((n, g) => n + g.count, 0) === byProvider.agents.length,
      'Groups partition the filtered set, not the whole fleet');
    check(Math.abs(byProvider.groups.reduce((n, g) => n + g.knownCost, 0)
      - byProvider.agents.reduce((n, a) => n + (a.cost ?? 0), 0)) < 1e-8,
      'Group known costs add up to the visible known cost');
    for (const g of byProvider.groups) {
      const records = byProvider.agents.filter(a => a.provider === g.value);
      check(records.every((a, i) => !i || a.age >= records[i - 1].age), `Recent sort stays within ${g.value}`);
    }
    const byStatus = await engine.query({ group: 'status' });
    check(byStatus.groups.map(g => g.value).join(',') === 'waiting,error,working,idle,complete',
      'Execution groups retain explicit attention-first order');
    const byCwd = await engine.query({ provider: 'HP Browser', group: 'cwd' });
    check(byCwd.groups.length === 1 && byCwd.groups[0].value === '' && byCwd.groups[0].count === 4,
      'Browser agents remain a separate no-working-directory group');
    const byProject = await engine.query({ group: 'project' });
    check(byProject.groups.map(g => g.value).sort().join(',') === 'agent-tools,aiui,browser-workspace',
      'Explicit project metadata is distinct from working-directory grouping');
    check((await engine.query({ query: 'Prompt workshop' })).agents[0].context === null, 'Unknown context survives SQL round trip');
    const originalWrites = engine.details().writes;
    await engine.setAgents(fixtures);
    check(engine.details().writes === originalWrites, 'Unchanged snapshot performs no row writes');
    const updated = simulate(fixtures, 'mock-agent-06', 'failure', 1);
    await engine.setAgents(updated);
    check(engine.details().writes === originalWrites + 1, 'One fixture change updates one row');
    check((await engine.query({ status: 'stale' })).agents.length === 2, 'Facet query sees updated freshness without stale cache');
    let duplicateRejected = false;
    try { await engine.setAgents([fixtures[0], fixtures[0]]); } catch { duplicateRejected = true; }
    check(duplicateRejected && (await engine.query()).agents.length === 36, 'Duplicate IDs reject without changing the table');
    await engine.setAgents(fixtures.slice(0, 3));
    check((await engine.query()).agents.length === 3, 'Snapshot deletion removes missing rows');
    await engine.setAgents([]);
    check((await engine.query()).agents.length === 0, 'Empty inventory is valid');
    const loading = engine.setAgents(createAgents(500));
    const read = engine.query();
    await loading;
    check((await read).agents.length === 500, 'Read queued behind update sees all 500 committed rows');
    return { passed, engine: engine.details() };
  } finally { await engine.close(); }
}
