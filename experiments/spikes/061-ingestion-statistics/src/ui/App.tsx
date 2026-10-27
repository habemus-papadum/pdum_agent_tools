import {For,Show,isPending,Loading} from 'solid-js';
import {CellView} from '@habemus-papadum/aiui-viz';
import {CommandPalette} from '../../../055-orchestrator-mock-lab/shared/CommandPalette';
import {graph} from '../model/graph';
import {view,provider,search,sort,question,term,configOpen,notesOpen,inspectorOpen,draft,notice,liveJob,refresh,syncNow,saveConfig,selectSession} from '../model/store';
import {sessionKey,providerOf,titleOf,number,money,text,type Row} from '../model/data';
const run=(operation:()=>unknown)=>{Promise.resolve().then(operation).catch(()=>{});};
function Table(props:{rows:Row[];columns?:string[]}){
 const columns=()=>props.columns??Object.keys(props.rows[0]??{});
 return <Show when={props.rows.length} fallback={<p class="ing-empty">No rows returned by this query.</p>}>
 <div class="ing-table-scroll"><table class="ing-data-table"><thead><tr><For each={columns()}>{column=><th>{column.replaceAll('_',' ')}</th>}</For></tr></thead>
 <tbody><For each={props.rows} keyed={false}>{row=><tr><For each={columns()}>{column=><td title={text(row()[column])}>{text(row()[column])}</td>}</For></tr>}</For></tbody></table></div></Show>;
}
export function App(){
 const g=graph;
 const job=()=>liveJob.get()??g().status.latest()?.job;
 const all=()=>g().allTotals.latest();const totals=()=>view.get()==='sessions'?g().filteredTotals.latest():all();
 const busy=()=>job()?.status==='running';
 const reading=()=>isPending(()=>g().snapshot())||isPending(()=>g().analysis())||isPending(()=>g().detail());
 return <div class="ing-app">
 <header class="ing-header"><a href="/">Agent tools</a><span class="ing-divider">/</span><strong>Ingestion & statistics</strong>
 <span class="ing-tag">REAL LOCAL DATA</span><nav><a href="/history/">History ↗</a><a href="/connections/">Machines ↗</a>
 <button onClick={()=>notesOpen.set(!notesOpen.get())}>ⓘ</button><a href="/061-ingestion-statistics/README.md">Notes</a></nav></header>
 <div class="ing-toolbar"><div class="ing-tabs"><For each={['sessions','analysis','sources','runs']}>{name=><button class={view.get()===name?'active':''} onClick={()=>view.set(name)}>{name}</button>}</For></div>
 <div class="ing-actions"><span class={`ing-status ${busy()?'running':''}`}>● <Loading fallback="Reading…">{reading()?'Reading…':job()?.status??'Local snapshot'}</Loading></span>
 <button title="Reread saved data (r)" onClick={()=>refresh.run()}>↻</button><button class={configOpen.get()?'active':''} onClick={()=>configOpen.set(!configOpen.get())}>⚙ Config</button>
 <button class="ing-primary" disabled={busy()} onClick={()=>run(()=>syncNow.run())}>↓ Sync saved config</button></div></div>
 <div class="ing-metrics"><span><b>{number(totals()?.count)}</b> / {number(all()?.count)} sessions</span>
 <span title="API-equivalent estimate of historical captured usage, not this experiment's spend"><b>{money(totals()?.cost)}</b> / {money(all()?.cost)} known cost <small>{all()?.cost?`${Math.round((totals()?.cost??0)/all()!.cost*100)}%`:''}</small></span>
 <span><b>{number(totals()?.input)}</b> input <small>{totals()?.input?`${Math.round(totals()!.cached/totals()!.input*100)}% cached`:''}</small></span>
 <span><b>{number(totals()?.output)}</b> output</span><span class="ing-warning"><b>{number(totals()?.errors)}</b> recorded errors</span>
 <span title="Missing model prices are not counted as zero cost"><b>{number(totals()?.unpriced)}</b> unpriced events</span></div>
 <Show when={notice.get()}><div class="ing-notice">{notice.get()}<button onClick={()=>notice.set('')}>×</button></div></Show>
 <Show when={busy()}><div class="ing-progress"><span/>Syncing saved sources · {job()?.summaries.length??0} source results received. Progress is reported at source boundaries.</div></Show>
 <div class={`ing-body ${configOpen.get()?'with-config':''}`}>
 <main class="ing-main">
 <Show when={notesOpen.get()}><aside class="ing-commentary"><b>Working study.</b> Six selected real transcripts, copied from the 058 review corpus. The database is local and independently writable.
 Cost is historical usage at <b>{g().snapshot.latest()?.pricingVersion??'the toolkit’s saved rates'}</b>, not subscription billing. Source snapshots omit native catalogues and projections; coverage is shown as collected.
 Table filters do not affect analysis questions. MotherDuck publishing and automatic collection are not connected.</aside></Show>
 <Show when={view.get()==='sessions'}>
 <div class="ing-filterbar"><input aria-label="Find a session" placeholder="Find project, session, model…" value={search.get()} onInput={e=>search.set(e.currentTarget.value)}/>
 <select aria-label="Provider" value={provider.get()} onChange={e=>provider.set(e.currentTarget.value)}><option value="all">All providers</option><option value="codex">Codex</option><option value="claude">Claude</option></select>
 <select aria-label="Sort sessions" value={sort.get()} onChange={e=>sort.set(e.currentTarget.value)}><option value="known_usd">Cost ↓</option><option value="input_tokens">Tokens ↓</option><option value="errors">Errors ↓</option><option value="items">Items ↓</option><option value="name">Name</option></select>
 <button title="Show or hide selected-session detail" onClick={()=>inspectorOpen.set(!inspectorOpen.get())}>◧ Detail</button></div>
 <CellView of={g().rows}>{rows=><div class="ing-session-table"><div class="ing-session-head"><span>Session / project</span><span>Known cost</span><span>Input / cache</span><span>Output</span><span>Items</span><span>Errors</span><span>Peak context</span></div>
 <For each={rows()} keyed={sessionKey}>{row=><button class={`ing-session-row ${sessionKey(g().current.latest()??row())===sessionKey(row())?'selected':''}`} onClick={()=>selectSession.run({key:sessionKey(row())})}>
 <span class="ing-session-name"><i class={providerOf(row())}>{providerOf(row())==='codex'?'◈':'✳'}</i><span><strong>{titleOf(row())}</strong><small title={row().cwd??''}>{row().cwd??row().thread_id}</small></span></span>
 <span class="ing-cost"><b>{money(row().known_usd)}{row().unpriced_events?' + ?':''}</b><i style={{width:`${Math.max(1,(row().known_usd??0)/Math.max(1,all()?.cost??1)*100)}%`}}/></span>
 <span>{number(row().input_tokens)}<small>{row().input_tokens?`${Math.round((row().cached_input_tokens??0)/row().input_tokens!*100)}% reused`:'usage unknown'}</small></span>
 <span>{number(row().output_tokens)}</span><span>{number(row().items)}</span><span class={row().errors?'ing-warning':''}>{number(row().errors)}</span>
 <span title={providerOf(row())==='claude'?'The ingestor synthesizes Claude token counters from response usage; these do not establish context occupancy.':'Peak reported context; not accumulated usage'}>{number(row().peak_context)}<small>{providerOf(row())==='claude'?'context unknown':row().context_window?`/ ${number(row().context_window)} reported`:'window unknown'}</small></span>
 </button>}</For><Show when={!rows().length}><p class="ing-empty">No sessions match these filters. Saved data is unchanged.</p></Show></div>}</CellView>
 <Show when={inspectorOpen.get()}><CellView of={g().current}>{row=><Show when={row()}>{current=><section class="ing-detail"><header><strong>{titleOf(current())}</strong><code>{current().thread_id}</code><button onClick={()=>inspectorOpen.set(false)}>×</button></header>
 <CellView of={g().detail} keepLatest={false}>{detail=><Show when={detail()}>{d=><><div class="ing-detail-note">Recorded operation groups · durations are sums of reported item intervals, not session wall time. Historical errors do not imply a currently failing agent.</div>
 <Table rows={d().tools} columns={['item_type','tool','items','timed_items','recorded_duration_ms','errors']}/>
 <details><summary>Usage evidence & coverage</summary><Table rows={d().usage}/><Table rows={d().coverage}/><Table rows={d().ledger}/></details></>}</Show>}</CellView>
 </section>}</Show>}</CellView></Show>
 </Show>
 <Show when={view.get()==='analysis'}><div class="ing-analysis-controls"><select aria-label="Analysis question" value={question.get()} onChange={e=>question.set(e.currentTarget.value)}><For each={g().snapshot.latest()?.questions??[]}>{q=><option value={q.id}>{q.id} · {q.title.replace('__TERM__','…')}</option>}</For></select>
 <Show when={question.get()==='Q5'}><input aria-label="Search term" value={term.get()} onInput={e=>term.set(e.currentTarget.value)}/></Show><span>Whole database</span></div>
 <CellView of={g().analysis} keepLatest={false}>{result=><Show when={result()}>{r=><section class="ing-analysis-result"><h2>{r().title}</h2><Show when={r().error}><p class="ing-warning">{r().error}</p></Show><Table rows={r().result??[]} columns={r().columns}/>
 <p class="ing-subtle">{number(r().rows)} rows · first {r().result?.length??0} displayed · {Number(r().coldMs??0).toFixed(1)} ms · existing agent-history query</p>
 <details><summary>Inspect SQL and interpretation</summary><pre>{r().sql}</pre><p>Queries retain their toolkit-defined scope. Duration is not CPU time; incomplete clocks, usage or model pricing remain incomplete. No health verdict is inferred.</p></details></section>}</Show>}</CellView></Show>
 <Show when={view.get()==='sources'}><CellView of={g().snapshot}>{snapshot=><><div class="ing-section-title">Published source provenance</div><Table rows={snapshot().provenance??[]} columns={['agent','hostname','root','agent_versions','schema_version','ingested_at']}/>
 <div class="ing-section-title">Incremental ledger</div><Table rows={snapshot().ledger??[]}/><p class="ing-subtle">Missing source files are marked gone by the ingestor; stored history is retained. These are copies of selected real transcripts, not a complete machine inventory.</p></>}</CellView></Show>
 <Show when={view.get()==='runs'}><CellView of={g().snapshot}>{snapshot=><><div class="ing-section-title">Recorded ingestion phases</div><Table rows={snapshot().phases??[]} columns={['started_at','source','phase','seconds','rows','detail']}/>
 <Show when={job()}><details open><summary>Last observed operation · {job()?.status}</summary><pre>{JSON.stringify(job(),null,2)}</pre></details></Show></>}</CellView></Show>
 </main>
 <Show when={configOpen.get()}><aside class="ing-config"><header><strong>Native history.yaml</strong><button onClick={()=>configOpen.set(false)}>×</button></header>
 <CellView of={g().config}>{config=><><p class="ing-subtle">Edits save only to this lab. Sync is a separate action.</p><code class="ing-path">{config().path}</code>
 <textarea aria-label="Native ingestion configuration" spellcheck={false} value={draft.get()??config().text??''} onInput={e=>draft.set(e.currentTarget.value)}/>
 <div class="ing-config-actions"><button disabled={draft.get()===null||busy()} onClick={()=>run(()=>saveConfig.run())}>Save configuration</button><button disabled={draft.get()===null} onClick={()=>draft.set(null)}>Discard edits</button></div>
 <b class="ing-section-title">Resolved inputs</b><For each={config().sources??[]}>{source=><div class="ing-source"><strong>{source.agent}</strong><code>{source.root}</code></div>}</For>
 <b class="ing-section-title">Write targets</b><For each={config().targets??[]}>{target=><div class="ing-source"><strong>{target.name} · {target.exists?'exists':'not created'}</strong><code>{target.path}</code></div>}</For>
 <For each={config().notes??[]}>{note=><p class="ing-warning">{note}</p>}</For>
 <p class="ing-subtle">Same parser and fields as pdum-history sync. Sources may be Codex homes, Claude directories or launcher profile roots. This button performs incremental sync; changing parsing/window options may require the existing CLI’s --full reread. Cloud publishing is deferred.</p></>}</CellView></aside></Show>
 </div>
 <footer class="ing-footer"><span>Selected real corpus · reading {g().config.latest()?.targets[0]?.name??'local'} DuckDB · {g().snapshot.latest()?.pricingVersion}</span><span>Historical API-equivalent usage · new inference $0</span></footer>
 <CommandPalette scope="ingestion-statistics" commands={[
 {id:'refresh',group:'Data',label:'Refresh saved data',key:'r',icon:'↻',run:()=>refresh.run()},
 {id:'sync',group:'Data',label:'Sync saved configuration',key:'s',icon:'↓',enabled:()=>!busy(),run:()=>syncNow.run()},
 {id:'config',group:'View',label:'Configuration',key:'c',icon:'⚙',run:()=>configOpen.set(!configOpen.get())},
 {id:'analysis',group:'View',label:'Analysis questions',key:'a',icon:'∑',run:()=>view.set('analysis')},
 {id:'sessions',group:'View',label:'Session table',key:'t',icon:'▤',run:()=>view.set('sessions')},
 {id:'notes',group:'View',label:'Commentary',key:'i',icon:'ⓘ',run:()=>notesOpen.set(!notesOpen.get())},
 ]}/>
 </div>;
}
