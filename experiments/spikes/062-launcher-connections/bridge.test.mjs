import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {bridge,probeEndpoint} from './server.mjs';

test('real launcher profiles preserve native text, exclude auth files and reject wrong-target writes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pdum-profile-study-'));const env={PDUM_PROFILE_LAB_DIR:join(root,'lab')};
 try{
  for(const provider of ['codex','claude']){
   const created=await bridge({operation:'create',provider,name:'base',workspace:resolve('.')},{env});
   const path=created.profile.path;const initial=await bridge({operation:'read',provider,path},{env});
   const text=provider==='codex'?`${initial.text}\n# preserve this native extension\n[unfamiliar_plugin]\nanswer = 42\n`:'{\n "permissions":{"defaultMode":"bypassPermissions"},\n "unfamiliar_plugin":{"answer":42}\n}\n';
   const saved=await bridge({operation:'save',provider,path,text,revision:initial.revision},{env});
   assert.notEqual(saved.revision,initial.revision);
   await assert.rejects(bridge({operation:'save',provider,path,text,revision:initial.revision},{env}),/changed since/);
   const sourceBefore=await readFile(created.profile.nativePath,'utf8');
   const auth=join(path,provider==='codex'?'auth.json':'claude/.credentials.json');await writeFile(auth,'{"synthetic_test_marker":true}');
   const copy=await bridge({operation:'create',provider,name:'copy',source:path,workspace:resolve('.')},{env});
   assert.equal(await readFile(copy.profile.nativePath,'utf8'),sourceBefore);
   await assert.rejects(readFile(join(copy.profile.path,provider==='codex'?'auth.json':'claude/.credentials.json')),/ENOENT/);
   assert.equal(await readFile(created.profile.nativePath,'utf8'),sourceBefore);
   await assert.rejects(bridge({operation:'create',provider,name:'copy'},{env}),/already exists/);
   await assert.rejects(bridge({operation:'save',provider,path,text,revision:saved.revision},{env:{PDUM_PROFILE_LAB_DIR:join(root,'different')}}),/only profiles/);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('an unrelated JSON HTTP200 service is not identified as a provider manager',async()=>{
 const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end('{"hello":"world"}');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const result=await probeEndpoint({url:`http://127.0.0.1:${server.address().port}`,provider:'claude'});assert.equal(result.reachable,false);assert.ok(result.checks.every(c=>c.status===200&&c.error.includes('does not match')));}
 finally{await new Promise(r=>server.close(r));}
});
