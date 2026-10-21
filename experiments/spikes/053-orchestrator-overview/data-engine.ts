/** Browser-only mock adapter: actual AIUI crossfilter + Mosaic + DuckDB-WASM.
 * The page owns fixture mutations; the database owns filtering, facets and sorting.
 * Shared by the Solid cell graph and browser checks; a disposable query adapter.
 */
import { Coordinator } from '@uwdata/mosaic-core';
import { contains, eq, literal } from '@uwdata/mosaic-sql';
import { scope, type Scope } from '@habemus-papadum/aiui-viz';
import { crossfilter, crossfilterPredicateSql } from '@habemus-papadum/aiui-viz/crossfilter';
import { instantiateDuckDB, duckdbAssetBundles, duckdbRunner } from '@habemus-papadum/aiui-viz/duckdb';
import { categorySelection, selectionDim } from '@habemus-papadum/aiui-viz/mosaic-selection';
import { duckdbConnector } from '@habemus-papadum/aiui-viz/mosaic-connector';

declare const __DUCKDB_VERSION__: string;
type Agent = { id: string; name: string; provider: string; host: string; profile: string;
  activity: string; status: string; fresh: boolean; age: number; [key: string]: unknown };
type Filters = { query?: string; provider?: string; host?: string; status?: string; sort?: string; group?: string };
const quote = (value: unknown) => String(literal(value));
const columns = ['id', 'name', 'provider', 'host', 'status', 'fresh', 'attention', 'age', 'search_text', 'payload',
  'cwd', 'project', 'cost', 'coverage'];

export async function createOverviewData(initialAgents: Agent[], options: { scope?: Scope } = {}) {
  const db = await instantiateDuckDB(duckdbAssetBundles({ prefix: '/__data/', version: __DUCKDB_VERSION__ }));
  const connection = await db.connect();
  // Cache is deliberately off: this small mutable table is replaced incrementally.
  const coordinator = new Coordinator(duckdbConnector({ duckdb: db, connection }), { cache: false, consolidate: false });
  const dataScope = options.scope ?? scope(`overview-check-${crypto.randomUUID()}`);
  const categories = { provider: categorySelection(), host: categorySelection(), status: categorySelection() };
  const selection = crossfilter({ columns: { agents: columns }, include: Object.values(categories) });
  const provider = selectionDim({ name: 'provider', scope: dataScope, kind: 'point', description: 'Filter providers; multiple values are combined with OR.', targets: [{ selection: categories.provider, field: 'provider', table: 'agents' }] });
  const host = selectionDim({ name: 'host', scope: dataScope, kind: 'point', description: 'Filter hosts; multiple values are combined with OR.', targets: [{ selection: categories.host, field: 'host', table: 'agents' }] });
  const status = selectionDim({ name: 'status', scope: dataScope, kind: 'point', description: 'Filter execution states; multiple values are combined with OR.', targets: [{ selection: categories.status, field: 'status', table: 'agents' }] });
  const dims = { provider, host, status };
  const sources = { query: {}, provider: {}, host: {}, status: {} };
  const listeners = new Set<() => void>();
  let selectionRevision = 0;
  const notify = () => { selectionRevision++; for (const listener of listeners) listener(); };
  selection.addEventListener('value', notify);
  let search = '';
  let specialStatus = '';
  let records = new Map<string, string>();
  let writes = 0;
  let lastSql = '';
  let closed = false;
  let pending = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = pending.then(() => { if (closed) throw Error('Overview database is closed'); return run(); });
    pending = next.then(() => undefined, () => undefined);
    return next;
  };
  const rows = (sql: string) => coordinator.query(sql, { type: 'json', cache: false }) as Promise<Record<string, unknown>[]>;
  await coordinator.exec(`CREATE TABLE agents (id VARCHAR PRIMARY KEY, name VARCHAR, provider VARCHAR, host VARCHAR,
    status VARCHAR, fresh BOOLEAN, attention BOOLEAN, age DOUBLE, search_text VARCHAR, payload VARCHAR,
    cwd VARCHAR, project VARCHAR, cost DOUBLE, coverage VARCHAR)`);

  const setAgents = (agents: Agent[]) => serial(async () => {
    const next = new Map(agents.map(a => [a.id, JSON.stringify(a)]));
    if (next.size !== agents.length) throw Error('Fixture IDs must be unique');
    const removed = [...records.keys()].filter(id => !next.has(id));
    const changed = agents.filter(a => next.get(a.id) !== records.get(a.id));
    if (!removed.length && !changed.length) return;
    const statements = ['BEGIN TRANSACTION'];
    if (removed.length) statements.push(`DELETE FROM agents WHERE id IN (${removed.map(quote).join(',')})`);
    if (changed.length) statements.push(`INSERT OR REPLACE INTO agents VALUES ${changed.map(a => `(${[
      a.id, a.name, a.provider, a.host, a.status, a.fresh, !a.fresh || ['waiting', 'error'].includes(a.status), a.age,
      [a.id, a.name, a.host, a.profile, a.activity, a.provider, a.cwd, a.project].filter(Boolean).join(' ').toLocaleLowerCase(), next.get(a.id),
      a.cwd ?? null, a.project ?? null, a.cost ?? null, a.coverage ?? 'unknown',
    ].map(quote).join(',')})`).join(',')}`);
    statements.push('COMMIT');
    try { await coordinator.exec(statements); }
    catch (error) { await coordinator.exec('ROLLBACK').catch(() => {}); throw error; }
    records = next; writes += changed.length + removed.length;
    for (const client of coordinator.clients) client.requestQuery();
    notify();
  });

  const setFilters = (filters: Filters = {}) => {
    if ('query' in filters) {
      search = filters.query?.trim().toLocaleLowerCase() || '';
      selection.update({ source: sources.query, value: search,
        predicate: search ? contains('search_text', literal(search)) : null });
    }
    for (const key of ['provider', 'host', 'status'] as const) {
      if (!(key in filters)) continue;
      const value = filters[key] || '';
      if (key === 'status') {
        specialStatus = ['attention', 'stale'].includes(value) ? value : '';
        selection.update({ source: sources.status, value: specialStatus,
          predicate: specialStatus ? eq(specialStatus === 'stale' ? 'fresh' : 'attention', literal(specialStatus !== 'stale')) : null });
      }
      if (key === 'status' && specialStatus) dims.status.clear();
      else dims[key].set(value ? [value] : null);
    }
  };
  const currentFilters = () => { const activeSpecial = selection.clauses.some(c => c.source === sources.status) ? specialStatus : '';
    return { query: selection.clauses.some(c => c.source === sources.query) ? search : '', provider: dims.provider.get() ?? [], host: dims.host.get() ?? [],
      status: activeSpecial || dims.status.get() || [], specialStatus: activeSpecial }; };
  const settleSelection = async () => {
    // Mosaic include-relays serialize asynchronous value emissions. Await their
    // public queues until no new event was emitted; no timer-based approximation.
    let revision;
    do { revision = selectionRevision; await Promise.all(Object.values(categories).map(category => category.pending('value')));
      await selection.pending('value'); } while (revision !== selectionRevision);
  };
  const snapshotQuery = (filters: Filters = {}) => serial(async () => {
    await settleSelection();
    const where = crossfilterPredicateSql(selection, 'agents');
    const order = filters.sort === 'name' ? 'name, id' : filters.sort === 'recent' ? 'age, id'
      : "attention DESC, (status = 'waiting') DESC, id";
    const group = ['status', 'host', 'cwd', 'project', 'provider'].includes(filters.group ?? '') ? filters.group : '';
    const groupOrder = group === 'status'
      ? "CASE status WHEN 'waiting' THEN 0 WHEN 'error' THEN 1 WHEN 'working' THEN 2 WHEN 'idle' THEN 3 ELSE 4 END"
      : group ? `coalesce(${group}, '')` : '';
    lastSql = `SELECT payload FROM agents WHERE ${where} ORDER BY ${groupOrder ? `${groupOrder}, ` : ''}${order}`;
    const result = await rows(lastSql);
    const groups = group ? await rows(`SELECT coalesce(${group}, '') AS value, count(*)::INTEGER AS count,
      coalesce(sum(cost), 0)::DOUBLE AS knownCost,
      count(*) FILTER (WHERE coverage != 'complete')::INTEGER AS incomplete
      FROM agents WHERE ${where} GROUP BY ${group} ORDER BY ${groupOrder}`) : [];
    const facets: Record<string, { value: string; count: number }[]> = {};
    for (const key of ['provider', 'host', 'status'] as const) {
      // Mosaic removes only this facet's clause: alternatives remain visible while
      // every other active dimension constrains its counts.
      let own = selection.remove(sources[key]);
      for (const clause of categories[key].clauses) own = own.remove(clause.source);
      const ownWhere = crossfilterPredicateSql(own, 'agents');
      facets[key] = (await rows(`SELECT ${key} AS value, count(*)::INTEGER AS count FROM agents
        WHERE ${ownWhere} GROUP BY ${key} ORDER BY ${key}`)) as { value: string; count: number }[];
      if (key === 'status') {
        const totals = (await rows(`SELECT count(*) FILTER (WHERE NOT fresh)::INTEGER AS stale,
          count(*) FILTER (WHERE attention)::INTEGER AS attention FROM agents WHERE ${ownWhere}`))[0];
        facets.status.push({ value: 'stale', count: Number(totals.stale) }, { value: 'attention', count: Number(totals.attention) });
      }
    }
    return { agents: result.map(r => JSON.parse(String(r.payload)) as Agent), facets, groups,
      engine: 'duckdb-wasm+mosaic' as const };
  });
  const query = async (filters: Filters = {}) => {
    setFilters({ query: filters.query ?? '', provider: filters.provider ?? '', host: filters.host ?? '', status: filters.status ?? '' });
    return snapshotQuery(filters);
  };

  try { await setAgents(initialAgents); }
  catch (error) { await connection.close(); await db.terminate(); throw error; }
  const agentConnection = await db.connect();
  return {
    setAgents, query, setFilters, snapshotQuery, currentFilters, coordinator, selection, categories, dims,
    sqlRunner: duckdbRunner(agentConnection), table: 'agents',
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    clear: () => { search = ''; specialStatus = ''; Object.values(dims).forEach(dim => dim.clear());
      Object.values(categories).forEach(category => category.reset()); selection.reset(); notify(); },
    details: () => ({ engine: 'duckdb-wasm+mosaic', duckdbVersion: __DUCKDB_VERSION__, rows: records.size,
      writes, lastSql, clauses: selection.clauses.map(c => ({ value: c.value, predicate: String(c.predicate) })) }),
    close: () => serial(async () => { closed = true; selection.removeEventListener('value', notify); listeners.clear();
      coordinator.clear(); await agentConnection.close(); await connection.close(); await db.terminate(); }),
  };
}
