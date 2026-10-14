import {Rpc} from './rpc.mjs';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const dir=resolve('artifacts/030-codex-remote-operations/large-file-'+Date.now());mkdirSync(dir,{recursive:true});const home=mkdtempSync(join(tmpdir(),'pdum030-large-'));const file=join(home,'large.bin'),bytes=Buffer.alloc(5*1024*1024,0xab);writeFileSync(file,bytes);const rpc=Rpc.stdio(process.env.SPIKE_CODEX_BIN??'/Users/nehal/.local/bin/codex',home,home,join(dir,'wire.jsonl'));try{await rpc.initialize();const r=await rpc.request('fs/readFile',{path:file});const decoded=Buffer.from(r.dataBase64,'base64');assert.deepEqual(decoded,bytes);writeFileSync(dir+'/results.json',JSON.stringify({size:bytes.length,exact:true,paidCalls:0},null,2));console.log(dir)}finally{rpc.close()}
