import {expect,it}from'vitest';import{projectFamily}from'./family';import{exampleBookmarks,resolveExample}from'./examples';
const documents=[{key:'codex-math',sessionId:'s',provider:'codex',title:'Fixture',source:{kind:'fixture',method:'fixture',capturedAt:'',version:'fixture'},payload:{thread:{id:'s',turns:[{id:'t',items:[{id:'m',type:'agentMessage',phase:'final_answer',text:'Math'}]}]}}}];
const bookmark={id:'math',label:'Math',documentKey:'codex-math',provider:'codex',role:'assistant',phase:'final_answer',turnId:'t',itemId:'m',uuid:null,features:['math']};
it('curated collections do not manufacture a root or parent-child relation',()=>{
 const family=projectFamily(documents,{groupKind:'collection',rootKey:'codex-math',relationships:{documents:[{key:'codex-math',label:'Mathematical prose'}],bookmarks:[bookmark]}});
 expect(family.groupKind).toBe('collection');expect(family.lanes[0].parentStatus).toBe('unknown');expect(family.lanes[0].parentKey).toBeNull();expect(family.lanes[0].displayLabel).toBe('Mathematical prose');
 expect(resolveExample(family.lanes,exampleBookmarks([bookmark])[0]).available).toBe(true);
});
it('native identity, actor and phase must agree; ordinals are not a fallback',()=>{
 const lanes=projectFamily(documents).lanes;
 expect(resolveExample(lanes,{...bookmark,itemId:'missing'}).available).toBe(false);
 expect(resolveExample(lanes,{...bookmark,role:'user'}).available).toBe(false);
 expect(resolveExample(lanes,{...bookmark,turnId:'wrong'}).available).toBe(false);
 expect(resolveExample(lanes,{...bookmark,phase:'commentary'}).available).toBe(false);
});
