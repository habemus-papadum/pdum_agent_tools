import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createIsolatedProfile } from "../../014-claude-app-server/src/launch.js";
import { createManager } from "./server.js";

test("management helpers are isolated and invalid history never launches a worker",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"spike016-management-"));
  const a=createIsolatedProfile(join(dir,"a"));const b=createIsolatedProfile(join(dir,"b"));b.workDirectory=a.workDirectory;
  const manager=await createManager({profiles:{a,b},outputDirectory:join(dir,"manager"),host:"127.0.0.1"});
  try{
    for(const id of ["a","b"]){
      const response=await fetch(`${manager.url}/api/profiles/${id}/sessions`);
      assert.equal(response.status,200);assert.deepEqual(await response.json(),[]);
    }
    const response=await fetch(`${manager.url}/api/workers`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({profileId:"a",resume:"00000000-0000-4000-8000-000000000000"})});
    assert.equal(response.status,404);
    assert.deepEqual(await fetch(`${manager.url}/api/workers`).then(r=>r.json()),[]);
  }finally{await manager.close();rmSync(dir,{recursive:true,force:true});}
});
