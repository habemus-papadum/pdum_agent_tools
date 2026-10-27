import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function launch(extraEnv = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./serve.mjs', import.meta.url))], {
    env: { ...process.env, PORT: '0', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let errors = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { errors += text; });
  const lines = createInterface({ input: child.stdout });
  try {
    const ready = await Promise.race([
      new Promise((resolve, reject) => lines.once('line', line => { try { resolve(JSON.parse(line)); } catch (error) { reject(error); } })),
      exited.then(() => { throw Error(`Preview exited before readiness: ${errors}`); }),
    ]);
    return { child, ready, exited, async stop() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); return exited; } };
  } catch (error) { child.kill('SIGTERM'); await exited; throw error; }
  finally { lines.close(); }
}

test('two actual preview processes have separate identities/state/ports and independent cleanup', { timeout: 30000 }, async () => {
  const a = await launch(); let b;
  try {
    b = await launch();
    assert.notEqual(a.ready.pid, b.ready.pid); assert.notEqual(a.ready.id, b.ready.id);
    assert.notEqual(a.ready.url, b.ready.url); assert.notEqual(a.ready.stateDirectory, b.ready.stateDirectory);
    for (const instance of [a, b]) {
      const response = await fetch(instance.ready.url); assert.equal(response.status, 200);
      assert.match(await response.text(), /interaction studies/i);
      const info = await (await fetch(new URL('/__instance', instance.ready.url))).json(); assert.equal(info.id, instance.ready.id);
      for (const path of ['/__aiui-design/site.css', '/__aiui-design/tokens.css', '/__aiui-design/@fontsource/cormorant-garamond/400.css', '/__aiui-design/@fontsource-variable/fraunces/full.css', '/053-orchestrator-overview/data-engine.js'])
        assert.equal((await fetch(new URL(path, instance.ready.url))).status, 200, path);
      const wasm = await fetch(new URL(`/__data/duckdb-wasm-assets/${instance.ready.duckdbVersion}/duckdb-eh.wasm`, instance.ready.url), { method: 'HEAD' });
      assert.equal(wasm.status, 200); assert.equal(wasm.headers.get('content-type'), 'application/wasm');
      const note = await fetch(new URL('/053-orchestrator-overview/README.md', instance.ready.url));
      assert.match(note.headers.get('content-type'), /text\/html/);
      const html = await note.text();
      assert.match(html, /<h1 id="overview-interaction-mock">Overview interaction mock<\/h1>/);
      assert.match(html, /<h2 id="[^\"]+">/);
      assert.match(html, /<strong>/);
      const raw = await fetch(new URL('/053-orchestrator-overview/README.md?raw=1', instance.ready.url));
      assert.match(raw.headers.get('content-type'), /text\/plain/);
      assert.match(await raw.text(), /^# Overview interaction mock/);
      assert.equal((await fetch(new URL('/docs/plans/agent-orchestrator/components/09-session-workspace.md', instance.ready.url))).status, 200);
      await access(`${instance.ready.stateDirectory}/instance.json`);
    }
    assert.equal((await a.stop()).code, 0);
    await assert.rejects(access(a.ready.stateDirectory), { code: 'ENOENT' }, a.ready.stateDirectory);
    assert.equal((await fetch(b.ready.url)).status, 200);
    await access(`${b.ready.stateDirectory}/instance.json`);
    assert.equal((await b.stop()).code, 0);
    await assert.rejects(access(b.ready.stateDirectory), { code: 'ENOENT' }, b.ready.stateDirectory);
  } finally { await a.stop(); await b?.stop(); }
});

test('history HTTP surface reads selected native exports without write operations', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pdum-history-http-test-'));
  await mkdir(join(directory, 'documents'));
  await mkdir(join(directory, 'assets'));
  const assetName = `${'a'.repeat(64)}.png`;
  const assetBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNosAAAAASUVORK5CYII=', 'base64');
  await writeFile(join(directory, 'assets', assetName), assetBytes);
  const entry = { version: 1, key: 'codex-synthetic', provider: 'codex', sessionId: 'fixture-1', title: 'HTTP fixture',
    source: { kind: 'synthetic-test', method: 'thread/read', capturedAt: '2026-10-19T00:00:00Z',
      assets: [{reference:'/tmp/fixture.png',path:`assets/${assetName}`,kind:'copied-at-export'}] } };
  const document = { ...entry, payload: { thread: { id: 'fixture-1', turns: [] } } };
  const catalogPath = join(directory, 'catalog.json');
  const documentPath = join(directory, 'documents', 'codex-synthetic.json');
  const catalogBytes = JSON.stringify({ version: 1, sessions: [entry] });
  const documentBytes = JSON.stringify(document);
  await writeFile(catalogPath, catalogBytes); await writeFile(documentPath, documentBytes);
  let instance;
  try {
    instance = await launch({ PDUM_HISTORY_EXPORT_DIR: directory });
    const url = path => new URL(path, instance.ready.url);
    const catalogue = await (await fetch(url('/__history/catalog'))).json();
    assert.equal(catalogue.available, true); assert.deepEqual(catalogue.sessions, [entry]);
    assert.deepEqual(await (await fetch(url('/__history/document/codex-synthetic'))).json(), document);
    assert.equal((await fetch(url('/__history/document/absent'))).status, 404);
    assert.equal((await fetch(url('/__history/document/codex-synthetic'), { method: 'POST', body: '{}' })).status, 405);
    assert.equal((await fetch(url('/__history/document/..%2Fcatalog.json'))).status, 404);
    const image = await fetch(url(`/__history/assets/${assetName}`));
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), assetBytes);
    assert.equal((await fetch(url(`/__history/assets/${'b'.repeat(64)}.png`))).status, 404);
    assert.equal((await fetch(url('/__history/assets/%2e%2e%2fcatalog.json'))).status, 404);
    assert.equal((await fetch(url(`/__history/assets/${assetName}`), {method:'POST'})).status, 405);
    assert.equal(await readFile(catalogPath, 'utf8'), catalogBytes);
    assert.equal(await readFile(documentPath, 'utf8'), documentBytes);
  } finally { await instance?.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('family HTTP routes preserve native identity, report unavailable runs and remain GET-only', {timeout:30000}, async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pdum-family-http-test-'));
  const selected=join(directory,'selected'), invalid=join(directory,'invalid');
  await mkdir(join(selected,'documents'),{recursive:true});await mkdir(join(invalid,'documents'),{recursive:true});
  const source={kind:'synthetic-http-fixture',method:'official helper-shaped test',capturedAt:'2026-10-24T00:00:00Z'};
  const parent={version:1,key:'claude-root',provider:'claude',sessionId:'same-session',title:'Fixture parent',source:{...source,relation:{kind:'root',rootSessionId:'same-session'}},payload:{info:null,messages:[]}};
  const relation={kind:'subagent',rootSessionId:'same-session',agentId:'agent-a',parentResolution:'main-or-unknown',parentDocumentAvailable:null};
  const child={version:1,key:'claude-child',provider:'claude',sessionId:'same-session',title:'Fixture child',source:{...source,relation},payload:{info:null,messages:[{uuid:'child-message',message:{role:'assistant',content:'Native fixture record'}}]}};
  const family={rootKey:'claude-root',rootSessionId:'same-session',members:[{key:'claude-root',kind:'root'},{key:'claude-child',kind:'subagent',agentId:'agent-a'}],edges:[relation]};
  const childPath=join(selected,'documents/claude-child.json'),childBytes=JSON.stringify(child);
  await writeFile(join(selected,'documents/claude-root.json'),JSON.stringify(parent));await writeFile(childPath,childBytes);
  await writeFile(join(selected,'family.json'),JSON.stringify(family));
  await writeFile(join(invalid,'documents/codex-root.json'),JSON.stringify({...parent,key:'codex-root'}));
  await writeFile(join(invalid,'family.json'),JSON.stringify({parentThreadId:'same-session',threads:[{threadId:'same-session'}]}));
  const config=join(directory,'families.json');await writeFile(config,JSON.stringify({families:[
    {id:'chosen',title:'HTTP chosen family',provider:'claude',directory:'selected'},
    {id:'missing',title:'HTTP missing family',provider:'claude',directory:'missing'},
    {id:'invalid',title:'HTTP mismatched family',provider:'codex',directory:'invalid'},
  ]}));
  const originalCatalog='{"version":1,"sessions":[]}';await writeFile(join(directory,'catalog.json'),originalCatalog);
  let instance;
  try {
    instance=await launch({PDUM_HISTORY_EXPORT_DIR:directory,PDUM_HISTORY_FAMILIES_CONFIG:config});
    const url=path=>new URL(path,instance.ready.url);
    const response=await fetch(url('/__history/families'));assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    const catalog=await response.json();assert.equal(catalog.readOnly,true);assert.equal(catalog.families.length,3);
    const entry=catalog.families.find(row=>row.id==='chosen');assert.equal(entry.available,true);assert.equal(entry.members.length,2);
    assert.ok(entry.members.every(member=>!Object.hasOwn(member,'payload')));
    const bundle=await(await fetch(url('/__history/family/chosen'))).json();
    assert.equal(bundle.rootKey,'claude-root');assert.deepEqual(bundle.documents,[parent,child]);assert.deepEqual(bundle.relationships,family);
    const head=await fetch(url('/__history/family/chosen'),{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
    assert.equal((await fetch(url('/__history/family/absent'))).status,404);
    assert.equal((await fetch(url('/__history/family/..%2Fchosen'))).status,404);
    const missing=await fetch(url('/__history/family/missing'));assert.equal(missing.status,503);assert.equal((await missing.json()).code,'missing-export');
    const mismatch=await fetch(url('/__history/family/invalid'));assert.equal(mismatch.status,400);assert.equal((await mismatch.json()).code,'invalid-export');
    for(const path of ['/__history/families','/__history/family/chosen'])assert.equal((await fetch(url(path),{method:'POST',body:'{}'})).status,405);
    assert.deepEqual((await(await fetch(url('/__history/catalog'))).json()).sessions,[]);
    assert.equal(await readFile(join(directory,'catalog.json'),'utf8'),originalCatalog);
    assert.equal(await readFile(childPath,'utf8'),childBytes);
    assert.equal((await(await fetch(url('/__instance'))).json()).providerCalls,0);
  } finally {await instance?.stop();await rm(directory,{recursive:true,force:true});}
});

test('independent collection GET and collection-only raster assets remain read-only', {timeout:30000}, async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pdum-collection-http-test-'));
  const selected=join(directory,'rich');await mkdir(join(selected,'documents'),{recursive:true});await mkdir(join(selected,'assets'));
  const imageName=`${'e'.repeat(64)}.png`,imageBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNosAAAAASUVORK5CYII=','base64');
  const source={kind:'synthetic-http-fixture',method:'native read fixture',capturedAt:'2026-10-24T00:00:00Z',assets:[{reference:'/fixture.png',path:`assets/${imageName}`}]};
  const document={version:1,key:'codex-prompt',provider:'codex',sessionId:'source',title:'Prompt',source,payload:{thread:{id:'source',turns:[{id:'turn',items:[{id:'image-item',type:'userMessage',content:[{type:'localImage',path:'/fixture.png'}]}]}]}}};
  await writeFile(join(selected,'documents/codex-prompt.json'),JSON.stringify(document));await writeFile(join(selected,'assets',imageName),imageBytes);
  const collection={version:1,id:'rich-messages',title:'Rich fixture',kind:'independent-examples',documents:[{key:document.key,file:'documents/codex-prompt.json'}],
    bookmarks:[{id:'prompt',label:'User image',documentKey:document.key,provider:'codex',role:'user',itemId:'image-item',turnId:'turn',ordinal:0,features:['image']}],initialBookmarkId:'prompt',coverage:{gaps:['assistant image absent']}};
  const collectionPath=join(selected,'collection.json');await writeFile(collectionPath,JSON.stringify(collection));
  const config=join(directory,'selection.json');await writeFile(config,JSON.stringify({families:[{id:'rich-messages',title:'Rich fixture',provider:'mixed',kind:'collection',directory:'rich'}]}));
  let instance;
  try {
    // No ordinary history catalog exists, so asset serving must use the selected collection.
    instance=await launch({PDUM_HISTORY_EXPORT_DIR:directory,PDUM_HISTORY_FAMILIES_CONFIG:config});const url=path=>new URL(path,instance.ready.url);
    const entry=(await(await fetch(url('/__history/families'))).json()).families[0];assert.equal(entry.groupKind,'collection');assert.equal(entry.provider,'mixed');assert.equal(entry.rootKey,document.key);
    assert.deepEqual(entry.bookmarks,collection.bookmarks);assert.deepEqual(entry.coverage.native,collection.coverage);
    const response=await fetch(url('/__history/family/rich-messages'));assert.equal(response.status,200);const bundle=await response.json();assert.deepEqual(bundle.documents,[document]);assert.deepEqual(bundle.relationships,collection);assert.equal(bundle.documents[0].source.relation,undefined);
    const image=await fetch(url(`/__history/assets/${imageName}`));assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await image.arrayBuffer()),imageBytes);
    assert.equal((await fetch(url(`/__history/assets/${'f'.repeat(64)}.png`))).status,404);assert.equal((await fetch(url('/__history/assets/..%2Fcollection.json'))).status,404);
    assert.equal((await fetch(url(`/__history/assets/${imageName}`),{method:'POST'})).status,405);
    assert.equal(await readFile(collectionPath,'utf8'),JSON.stringify(collection));assert.deepEqual(await readFile(join(selected,'assets',imageName)),imageBytes);
    const broken=structuredClone(collection);broken.bookmarks[0].itemId='wrong';await writeFile(collectionPath,JSON.stringify(broken));
    const invalid=await fetch(url('/__history/family/rich-messages'));assert.equal(invalid.status,400);assert.equal((await invalid.json()).code,'invalid-export');
  }finally{await instance?.stop();await rm(directory,{recursive:true,force:true});}
});
