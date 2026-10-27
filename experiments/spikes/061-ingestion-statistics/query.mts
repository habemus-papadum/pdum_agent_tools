/** Queries belong to the TypeScript side; this disposable process opens the local DB read-only. */
import {HistoryDb} from '../../../typescript/packages/agent-history/src/db.ts';
import {QUESTIONS, runQuestions} from '../../../typescript/packages/agent-history/src/questions.ts';
import {pricesCte, pricingVersion, USD_EXPRESSION} from '../../../typescript/packages/agent-history/src/pricing.ts';

let input='';for await(const chunk of process.stdin)input+=chunk;
const request=JSON.parse(input);
const db=await HistoryDb.open(request.path);
try {
  let value:unknown;
  if(request.action==='question') {
    let selected=QUESTIONS.find(q=>q.id===request.id);
    if(!selected)throw new Error('Unknown analysis question');
    const duplicateIds=await db.query('SELECT thread_id FROM threads GROUP BY thread_id HAVING count(DISTINCT source_id)>1 LIMIT 1');
    if(duplicateIds.length)throw new Error('These borrowed toolkit questions are not qualified for the same thread copied into multiple sources. Use a single-source corpus until source-scoped joins and attribution are qualified.');
    if(selected.id==='Q6')selected={...selected,title:'Codex reported context: peak against the model window',
      sql:selected.sql.replace('FROM token_counts GROUP BY','FROM token_counts WHERE source LIKE \'codex%\' GROUP BY')};
    if(selected.id==='Q12')selected={...selected,title:'Codex compaction: reported context before and after',
      sql:selected.sql.replace("WHERE event_type = 'compacted'","WHERE event_type = 'compacted' AND source LIKE 'codex%'")
        .replace("WHERE item_type = 'contextCompaction'","WHERE item_type = 'contextCompaction' AND source LIKE 'codex%'")};
    value=(await runQuestions(db,{term:request.term||'agent',limitRows:100},[selected]))[0];
  } else if(request.action==='detail') {
    const parameters=[request.sourceId,request.threadId];
    value={
      coverage:await db.query('SELECT * FROM coverage WHERE source_id=? AND thread_id=?',parameters),
      usage:await db.query(`SELECT basis, model, count(*) AS events, sum(input_tokens) AS input_tokens,
        sum(cached_input_tokens) AS cached_input_tokens, sum(output_tokens) AS output_tokens
        FROM usage_events WHERE source_id=? AND thread_id=? GROUP BY 1,2`,parameters),
      tools:await db.query(`SELECT item_type, coalesce(tool,command_program) AS tool, count(*) AS items,
        count(duration_ms) AS timed_items, sum(duration_ms) AS recorded_duration_ms,
        sum(CASE WHEN exit_code<>0 OR mcp_error OR status IN ('failed','error') THEN 1 ELSE 0 END) AS errors
        FROM items WHERE source_id=? AND thread_id=? GROUP BY 1,2 ORDER BY items DESC`,parameters),
      ledger:await db.query('SELECT unit_id,path,status,last_ingested_at,bytes FROM ingest_ledger WHERE source_id=? AND thread_ids LIKE ?',
        [request.sourceId,`%${request.threadId}%`]),
    };
  } else {
    const sessions=await db.query(`WITH ${pricesCte()}, usage AS (
      SELECT u.source_id,u.thread_id,count(*) AS usage_events, string_agg(DISTINCT u.basis,', ') AS usage_basis,
        sum(u.input_tokens) AS input_tokens,sum(u.cached_input_tokens) AS cached_input_tokens,
        sum(u.output_tokens) AS output_tokens, sum(${USD_EXPRESSION}) AS known_usd,
        sum((p.model IS NOT NULL)::int) AS priced_events, sum((p.model IS NULL)::int) AS unpriced_events
      FROM usage_events u LEFT JOIN turns t USING (source_id,thread_id,turn_id)
      LEFT JOIN prices p ON p.model=coalesce(u.model,t.model) GROUP BY 1,2),
      work AS (SELECT source_id,thread_id,count(*) AS items,
        sum(CASE WHEN exit_code<>0 OR mcp_error OR status IN ('failed','error') THEN 1 ELSE 0 END) AS errors
        FROM items GROUP BY 1,2),
      ctx AS (SELECT source_id,thread_id,max(last_total_tokens) AS peak_context,max(model_context_window) AS context_window
        FROM token_counts GROUP BY 1,2)
      SELECT h.source_id,h.thread_id,h.session_id,h.source,h.title,h.cwd,h.repo,h.model,h.updated_at,h.parent_thread_id,
        coalesce(w.items,0) AS items,coalesce(w.errors,0) AS errors,
        u.usage_events,u.usage_basis,u.input_tokens,u.cached_input_tokens,u.output_tokens,u.known_usd,u.priced_events,u.unpriced_events,
        CASE WHEN h.source LIKE 'codex%' THEN ctx.peak_context END AS peak_context,
        CASE WHEN h.source LIKE 'claude%' THEN ctx.peak_context END AS peak_response_tokens,
        ctx.context_window,c.unknown_line_types,c.in_projection,c.rollout_format
      FROM threads h LEFT JOIN usage u USING(source_id,thread_id) LEFT JOIN work w USING(source_id,thread_id)
      LEFT JOIN ctx USING(source_id,thread_id) LEFT JOIN coverage c USING(source_id,thread_id)
      WHERE h.in_window ORDER BY u.known_usd DESC NULLS LAST,h.updated_at DESC`);
    value={sessions,pricingVersion,
      provenance:await db.query('SELECT * FROM provenance ORDER BY agent'),
      ledger:await db.query('SELECT source_id,status,count(*) AS units,sum(bytes) AS bytes,max(last_ingested_at) AS last_ingested_at FROM ingest_ledger GROUP BY 1,2'),
      phases:await db.query('SELECT * FROM ingest_runs ORDER BY started_at DESC LIMIT 40'),
      questions:QUESTIONS.map(({id,title,tables})=>({id,title,tables})),
      capturedAt:new Date().toISOString()};
  }
  console.log(JSON.stringify(value,(_key,v)=>typeof v==='bigint'?Number(v):v));
} finally {db.close();}
