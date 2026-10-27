/** Local transport fixtures qualify file selection/identity only, not upstream provider compatibility. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createFamilyReader} from './family-reader.mjs';

async function fixture(t, provider='codex') {
  const base=await mkdtemp(join(tmpdir(),'pdum-family-reader-test-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const directory=join(base,'selected');await mkdir(join(directory,'documents'),{recursive:true});
  const source={kind:'synthetic-transport-test',method:'native read fixture',capturedAt:'2026-10-24T00:00:00Z'};
  let documents, relationships;
  if(provider==='codex') {
    documents=['root','child'].map(name=>({version:1,key:`codex-${name}`,provider,sessionId:name,title:name,source,
      unknownEnvelope:{retained:true},payload:{thread:{id:name,turns:[],unknownNative:['untouched']}}}));
    relationships={parentThreadId:'root',threads:[{threadId:'root'},{threadId:'child'}],unresolvedReferences:{unknown:['missing']}};
  } else {
    const relation={kind:'subagent',rootSessionId:'shared-root',agentId:'agent-a',parentAgentIds:[],parentToolUseIds:[],
      parentResolution:'main-or-unknown',candidateParent:'root',parentDocumentAvailable:null};
    documents=[{version:1,key:'claude-root',provider,sessionId:'shared-root',title:'root',source:{...source,relation:{kind:'root',rootSessionId:'shared-root'}},payload:{info:{session_id:'shared-root'},messages:[]}},
      {version:1,key:'claude-child',provider,sessionId:'shared-root',title:'child',source:{...source,relation},payload:{info:null,messages:[{uuid:'child-message',session_id:'shared-root',parent_agent_id:null,parent_tool_use_id:null,message:{role:'assistant',content:[{type:'text',text:'fixture'}]}}]}}];
    relationships={rootKey:'claude-root',rootSessionId:'shared-root',members:[{key:'claude-root',kind:'root'},{key:'claude-child',kind:'subagent',agentId:'agent-a'}],edges:[relation],completeness:{missingParentIdentity:1}};
  }
  for(const document of documents)await writeFile(join(directory,'documents',`${document.key}.json`),JSON.stringify(document));
  await writeFile(join(directory,'family.json'),JSON.stringify(relationships));
  const config=join(base,'selection.json');await writeFile(config,JSON.stringify({families:[
    {id:'selected',title:'Selected local fixture',provider,directory:'selected'},
    {id:'missing',title:'Absent local fixture',provider,directory:'missing'},
  ]}));
  return {base,directory,config,documents,relationships,reader:createFamilyReader(base,{configPath:config})};
}

test('selected Codex family preserves complete native envelopes and relationship evidence',async t=>{
  const f=await fixture(t);const original=await readFile(join(f.directory,'documents/codex-root.json'),'utf8');
  const bundle=await f.reader.family('selected');
  assert.equal(bundle.available,true);assert.equal(bundle.rootKey,'codex-root');
  assert.deepEqual(bundle.documents,f.documents);assert.deepEqual(bundle.relationships,f.relationships);
  assert.equal(bundle.coverage.documentCount,2);assert.ok(bundle.coverage.documentBytes>0);
  const catalog=await f.reader.catalog();assert.equal(catalog.readOnly,true);
  assert.equal(catalog.families[0].members.length,2);
  assert.ok(catalog.families[0].members.every(member=>!Object.hasOwn(member,'payload')));
  assert.deepEqual(catalog.families[0].members[0].unknownEnvelope,{retained:true});
  assert.equal(await readFile(join(f.directory,'documents/codex-root.json'),'utf8'),original);
  assert.equal(await f.reader.family('not-selected'),null);assert.equal(await f.reader.family('../selected'),null);
});

test('Claude child keys remain distinct despite shared root session IDs and uncertain parent metadata',async t=>{
  const f=await fixture(t,'claude');const bundle=await f.reader.family('selected');
  assert.equal(bundle.available,true);assert.equal(bundle.rootKey,'claude-root');
  assert.equal(new Set(bundle.documents.map(document=>document.sessionId)).size,1);
  assert.equal(new Set(bundle.documents.map(document=>document.key)).size,2);
  assert.deepEqual(bundle.documents,f.documents);assert.deepEqual(bundle.relationships,f.relationships);
  const child=(await f.reader.catalog()).families[0].members.find(member=>member.key==='claude-child');
  assert.equal(child.source.relation.agentId,'agent-a');assert.equal(child.source.relation.parentResolution,'main-or-unknown');
  assert.equal(child.source.relation.parentDocumentAvailable,null);
});

test('missing selected exports are explicit and cannot become synthetic success',async t=>{
  const f=await fixture(t);const missing=await f.reader.family('missing');
  assert.equal(missing.available,false);assert.equal(missing.code,'missing-export');assert.equal(missing.rootKey,null);
  assert.equal(Object.hasOwn(missing,'documents'),false);
  const row=(await f.reader.catalog()).families.find(entry=>entry.id==='missing');assert.deepEqual(row.members,[]);
});

test('provider, native identity and member mismatches fail the selected family',async t=>{
  const f=await fixture(t);const path=join(f.directory,'documents/codex-child.json');
  const bad={...f.documents[1],provider:'claude'};await writeFile(path,JSON.stringify(bad));
  let bundle=await f.reader.family('selected');assert.equal(bundle.available,false);assert.equal(bundle.code,'invalid-export');
  await writeFile(path,JSON.stringify({...f.documents[1],payload:{thread:{id:'wrong',turns:[]}}}));
  bundle=await f.reader.family('selected');assert.equal(bundle.code,'invalid-export');
  await rm(path);bundle=await f.reader.family('selected');assert.equal(bundle.code,'invalid-export');
});

test('invalid selection config cannot silently replace duplicate identities',async t=>{
  const f=await fixture(t);await writeFile(f.config,JSON.stringify({families:[
    {id:'same',title:'One',provider:'codex',directory:'selected'},
    {id:'same',title:'Two',provider:'claude',directory:'selected'},
  ]}));
  await assert.rejects(f.reader.catalog(),/duplicate family selection/);
});

async function collectionFixture(t) {
  const base=await mkdtemp(join(tmpdir(),'pdum-collection-reader-test-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const directory=join(base,'selected');await mkdir(join(directory,'documents'),{recursive:true});await mkdir(join(directory,'assets'));
  const filename=`${'c'.repeat(64)}.png`,asset=Buffer.from('synthetic raster fixture bytes');
  const source={kind:'synthetic-transport-test',method:'native read fixture',capturedAt:'2026-10-24T00:00:00Z'};
  const codex={version:1,key:'codex-prompt',provider:'codex',sessionId:'prompt-root',title:'Prompt',source,payload:{thread:{id:'prompt-root',turns:[{id:'turn-1',items:[{type:'userMessage',id:'input-0',content:[{type:'text',text:'fixture prompt'}]},{type:'agentMessage',id:'answer-1',phase:'final_answer',text:'$x = 1$'}]}]}}};
  const claude={version:1,key:'claude-image',provider:'claude',sessionId:'claude-source',title:'Image',source:{...source,assets:[{path:`assets/${filename}`,reference:'/fixture.png'}]},payload:{info:null,messages:[{uuid:'user-0',message:{role:'user',content:[{type:'image',source:{type:'url',url:'/fixture.png'}}]}}]}};
  const documents=[codex,claude];for(const document of documents)await writeFile(join(directory,'documents',`${document.key}.json`),JSON.stringify(document));
  // An unrelated file is not part of an independent collection's declared document set.
  await writeFile(join(directory,'documents/codex-unselected.json'),'not selected JSON');
  await writeFile(join(directory,'assets',filename),asset);
  const manifest={version:1,id:'selected',kind:'independent-examples',title:'Mixed independent examples',documents:documents.map(document=>({key:document.key,file:`documents/${document.key}.json`,provider:document.provider,sessionId:document.sessionId})),
    bookmarks:[{id:'user-image',label:'User image',documentKey:claude.key,provider:'claude',role:'user',phase:null,uuid:'user-0',itemId:'user-0',ordinal:0,features:['image']},
      {id:'math-final',label:'Math final',documentKey:codex.key,provider:'codex',role:'assistant',phase:'final_answer',turnId:'turn-1',itemId:'answer-1',ordinal:1,features:['math']}],
    initialBookmarkId:'user-image',coverage:{gaps:[{feature:'assistant-image',available:false}]}};
  const manifestPath=join(directory,'collection.json');await writeFile(manifestPath,JSON.stringify(manifest));
  const config=join(base,'selection.json');await writeFile(config,JSON.stringify({families:[{id:'selected',title:manifest.title,provider:'mixed',kind:'collection',directory:'selected'}]}));
  return {base,directory,documents,manifest,manifestPath,filename,asset,reader:createFamilyReader(base,{configPath:config})};
}

test('mixed collection preserves native providers and bookmarks without implying a parent',async t=>{
  const f=await collectionFixture(t);const bundle=await f.reader.family('selected');
  assert.equal(bundle.available,true);assert.equal(bundle.provider,'mixed');assert.equal(bundle.groupKind,'collection');
  assert.equal(bundle.rootKey,'claude-image');assert.equal(bundle.initialBookmarkId,'user-image');
  assert.deepEqual(bundle.documents,f.documents);assert.deepEqual(bundle.relationships,f.manifest);assert.deepEqual(bundle.bookmarks,f.manifest.bookmarks);
  assert.equal(bundle.documents.some(document=>document.source.relation),false);
  const row=(await f.reader.catalog()).families[0];assert.equal(row.groupKind,'collection');assert.deepEqual(row.bookmarks,f.manifest.bookmarks);
  assert.deepEqual(row.coverage.native,f.manifest.coverage);assert.equal(row.members.length,2);assert.ok(row.members.every(member=>!Object.hasOwn(member,'payload')));
});

test('collection bookmarks reject identity, role, phase, provider and initial-selection mismatches',async t=>{
  const f=await collectionFixture(t);
  for(const change of [
    manifest=>{manifest.bookmarks[0].documentKey='absent';},
    manifest=>{manifest.bookmarks[0].provider='codex';},
    manifest=>{manifest.bookmarks[0].role='assistant';},
    manifest=>{manifest.bookmarks[0].uuid='wrong';},
    manifest=>{manifest.bookmarks[1].ordinal=0;},
    manifest=>{manifest.bookmarks[1].phase='commentary';},
    manifest=>{manifest.bookmarks.push(manifest.bookmarks[0]);},
    manifest=>{manifest.initialBookmarkId='absent';},
    manifest=>{manifest.documents[0].provider='claude';},
    manifest=>{manifest.documents[0].file='../outside.json';},
  ]){
    const manifest=structuredClone(f.manifest);change(manifest);await writeFile(f.manifestPath,JSON.stringify(manifest));
    const bundle=await f.reader.family('selected');assert.equal(bundle.available,false);assert.equal(bundle.code,'invalid-export');
  }
});

test('collection asset fallback serves only explicitly listed raster filenames',async t=>{
  const f=await collectionFixture(t);const image=await f.reader.asset(f.filename);
  assert.equal(image.contentType,'image/png');assert.deepEqual(image.bytes,f.asset);
  assert.equal(await f.reader.asset('../collection.json'),null);assert.equal(await f.reader.asset(`${'d'.repeat(64)}.png`),null);
  await rm(join(f.directory,'assets',f.filename));assert.equal(await f.reader.asset(f.filename),null);
  assert.deepEqual(JSON.parse(await readFile(f.manifestPath,'utf8')),f.manifest);
});
