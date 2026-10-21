import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgents, selectAgents, summarize, simulate, evidenceFor, groupAgents, presentGroups, groupValue, STATUS_GROUP_ORDER, PROVIDERS } from './model.mjs';

test('the overview covers four hosts/providers with distinct identities', () => {
  const agents = createAgents();
  assert.equal(agents.length, 36);
  assert.equal(new Set(agents.map(a => a.id)).size, 36);
  assert.deepEqual(new Set(agents.map(a => a.provider)), new Set(PROVIDERS));
  for (const agent of agents.filter(a => a.local)) {
    assert.equal(agent.host, 'this tab');
    assert.equal(agent.cwd, null);
    assert.equal(evidenceFor(agent).owner, 'this browser tab');
  }
});

test('filters intersect without mutating the underlying inventory', () => {
  const agents = createAgents();
  const snapshot = structuredClone(agents);
  const result = selectAgents(agents, { provider: 'Codex', host: 'atlas · local', query: ' sdk-dev ', status: 'working' });
  assert.ok(result.length > 0);
  assert.ok(result.every(a => a.provider === 'Codex' && a.host === 'atlas · local' && a.status === 'working'));
  assert.equal(selectAgents(agents, { query: 'no such fixture' }).length, 0);
  assert.deepEqual(agents, snapshot);
});

test('losing observations preserves last known execution rather than inventing failure', () => {
  const agents = createAgents();
  const result = simulate(agents, agents[0].id, 'stale', 1);
  assert.equal(result[0].status, 'working');
  assert.equal(result[0].fresh, false);
  assert.equal(evidenceFor(result[0]).observation.confirmedCurrent, false);
  assert.ok(selectAgents(result, { status: 'attention' }).some(a => a.id === agents[0].id));
  assert.equal(agents[0].fresh, true);
});

test('host observation loss affects that host only; browser-local agents are not remotely owned', () => {
  const agents = createAgents();
  const result = simulate(agents, agents[0].id, 'host-loss', 1);
  for (let i = 0; i < result.length; i += 1) {
    assert.equal(result[i].status, agents[i].status);
    if (agents[i].host === agents[0].host) assert.equal(result[i].fresh, false);
    else assert.deepEqual(result[i], agents[i]);
  }
  const local = agents.find(a => a.local);
  assert.deepEqual(simulate(agents, local.id, 'host-loss', 2), agents);
});

test('unknown context and cost stay unknown through progress; totals retain incomplete coverage', () => {
  const agents = createAgents();
  const unknown = agents.find(a => a.context === null && a.cost === null);
  const result = simulate(agents, unknown.id, 'progress', 1).find(a => a.id === unknown.id);
  assert.equal(result.context, null);
  assert.equal(result.cost, null);
  assert.equal(result.coverage, 'unknown');
  const summary = summarize(agents);
  assert.ok(summary.incomplete > 0);
  assert.equal(evidenceFor(result).usage.actualBillingUsd, null);
});

test('explicit failure is fresh evidence and independent of missing observation', () => {
  const agents = createAgents();
  const failed = simulate(agents, agents[0].id, 'failure', 1)[0];
  assert.equal(failed.status, 'error');
  assert.equal(failed.fresh, true);
  assert.equal(failed.events[0].type, 'failure');
});

test('the 500-agent density fixture has unique identities and preserves provider scope', () => {
  const agents = createAgents(500);
  assert.equal(agents.length, 500);
  assert.equal(new Set(agents.map(a => a.id)).size, 500);
  assert.equal(new Set(agents.map(a => a.name)).size, 500);
  assert.ok(agents.some(a => !a.fresh && a.status === 'working'));
  assert.ok(agents.some(a => a.status === 'error' && a.fresh));
  assert.ok(agents.every(a => !a.local || (a.host === 'this tab' && a.cwd === null)));
  assert.throws(() => createAgents(0), /fixture counts/);
});

test('grouping partitions filtered agents and preserves the independent within-group sort', () => {
  const all = createAgents();
  const rows = selectAgents(all, { provider: 'Codex', group: 'host', sort: 'name' });
  const groups = groupAgents(rows, 'host');
  assert.ok(groups.length > 1);
  assert.deepEqual(groups.flatMap(group => group.agents), rows);
  assert.equal(rows.length, all.filter(agent => agent.provider === 'Codex').length);
  for (const group of groups) {
    assert.ok(group.agents.every(agent => agent.host === group.value));
    const names = group.agents.map(agent => agent.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  }
  const groupedKnownCost = groups.reduce((sum, group) => sum + summarize(group.agents).knownCost, 0);
  assert.ok(Math.abs(groupedKnownCost - summarize(rows).knownCost) < 1e-9);
});

test('execution grouping keeps stale working agents in working and follows attention order', () => {
  const rows = selectAgents(createAgents(), { group: 'status', sort: 'recent' });
  const groups = groupAgents(rows, 'status');
  assert.deepEqual(groups.map(group => group.value), STATUS_GROUP_ORDER);
  assert.ok(groups.find(group => group.value === 'working').agents.some(agent => !agent.fresh));
  for (const group of groups) {
    const ages = group.agents.map(agent => agent.age);
    assert.deepEqual(ages, [...ages].sort((a, b) => a - b));
  }
});

test('project is explicit fixture metadata and null working directories stay in their own group', () => {
  const all = createAgents();
  assert.deepEqual(new Set(all.map(agent => agent.project)), new Set(['agent-tools', 'aiui', 'browser-workspace']));
  const browser = all.find(agent => agent.local);
  assert.equal(groupValue(browser, 'cwd'), '');
  assert.equal(groupValue(browser, 'project'), 'browser-workspace');
  assert.equal(evidenceFor(browser).project, 'browser-workspace');
  const nullCwd = groupAgents(selectAgents(all, { group: 'cwd' }), 'cwd').find(group => group.value === '');
  assert.ok(nullCwd.agents.every(agent => agent.local));
  assert.equal(selectAgents(all, { query: 'browser-workspace' }).length, all.filter(agent => agent.local).length);
  assert.deepEqual(groupAgents(all, ''), []);
});

test('group focus and collapse only alter presentation, preserving the query and aggregate scope', () => {
  const rows = selectAgents(createAgents(), { group: 'host', provider: 'Claude' });
  const groups = groupAgents(rows, 'host');
  const original = structuredClone(groups);
  const key = groups[0].value;
  const shown = presentGroups(groups, 'host', [JSON.stringify(['host', key])], { field: 'host', value: key });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].collapsed, true);
  assert.deepEqual(groups, original);
  assert.equal(summarize(rows).total, 10);
  assert.equal(summarize(rows).knownCost.toFixed(2), '13.60');
});

test('focus and collapsed state are scoped to their grouping dimension, including empty directory groups', () => {
  const rows = selectAgents(createAgents(), { group: 'cwd' });
  const groups = groupAgents(rows, 'cwd');
  const unrelated = presentGroups(groups, 'cwd', [JSON.stringify(['host', ''])], { field: 'host', value: 'forge-a' });
  assert.equal(unrelated.length, groups.length);
  assert.ok(unrelated.every(group => !group.collapsed));
  const local = presentGroups(groups, 'cwd', [], { field: 'cwd', value: '' });
  assert.equal(local.length, 1);
  assert.ok(local[0].agents.every(agent => agent.local));
});
