'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const {normalize,Workspace}=require('../lib/state.cjs');const {addHooks,removeHooks}=require('../setup-hooks.cjs');const {createPanorama,keyMatches}=require('../server.cjs');
const base={session_id:'one',cwd:'C:\\Work\\Project',hook_event_name:'UserPromptSubmit',prompt:'Check the data'};
test('distinct sessions in one project and distinct agent providers never merge',()=>{
 const a=normalize('claude',base),b=normalize('claude',{...base,session_id:'two'}),c=normalize('codex',base);assert.equal(new Set([a.id,b.id,c.id]).size,3);assert.equal(a.project,'Project');assert.equal(normalize('claude',{...base,session_id:''}),null);
});
test('idle notification is not an input request; Stop is only a ready response',()=>{
 assert.equal(normalize('claude',{...base,hook_event_name:'Notification',notification_type:'idle_prompt'}),null);
 const stop=normalize('codex',{...base,hook_event_name:'Stop',last_assistant_message:'Which approach would you prefer?'});assert.equal(stop.status,'ready');assert.equal(new Workspace().apply(stop).newAlert,false);
});
test('structured questions and confirmed permissions receive attention',()=>{
 const q=normalize('claude',{...base,hook_event_name:'PreToolUse',tool_name:'AskUserQuestion',tool_input:{questions:[{question:'Which dataset?'}]}});assert.equal(q.status,'needs_input');assert.equal(q.message,'Which dataset?');assert.equal(q.confirmed,true);
 const p=normalize('claude',{...base,hook_event_name:'Notification',notification_type:'permission_prompt'});assert.equal(p.status,'permission');
 assert.equal(normalize('codex',{...base,hook_event_name:'PreToolUse',tool_name:'functions.request_user_input'}).status,'needs_input');
});
test('approval checks are provisional and clear when tool activity resumes',()=>{
 const w=new Workspace();const p=normalize('codex',{...base,hook_event_name:'PermissionRequest'});w.apply(p);assert.equal(w.snapshot()[0].attention,true);assert.equal(w.snapshot()[0].status,'approval_check');w.apply(normalize('codex',{...base,hook_event_name:'PostToolUse'},p.updated+1));assert.equal(w.snapshot()[0].attention,false);
});
test('delayed permission confirmation does not duplicate an alert or cancel snooze',()=>{
 const w=new Workspace();w.apply(normalize('claude',{...base,hook_event_name:'PermissionRequest'}));const s=[...w.sessions.values()][0];s.snoozedUntil=Date.now()+300000;const alertId=s.alertId;
 const r=w.apply(normalize('claude',{...base,hook_event_name:'Notification',notification_type:'permission_prompt'}));assert.equal(r.newAlert,false);assert.equal(r.session.alertId,alertId);assert.ok(r.session.snoozedUntil>Date.now());assert.equal(w.snapshot()[0].attention,false);
});
test('out of order delivery does not replace a newer permission event',()=>{
 const w=new Workspace();const n=Date.now();w.apply(normalize('codex',{...base,hook_event_name:'PermissionRequest',panorama_timestamp:n},n));assert.equal(w.apply(normalize('codex',{...base,panorama_timestamp:n-200},n)),null);assert.equal(w.snapshot()[0].status,'approval_check');
});
test('old working signals are labelled stale without inventing an input request',()=>{
 const w=new Workspace();w.apply(normalize('claude',base,1000000));const s=w.snapshot(1000000+600001)[0];assert.equal(s.stale,true);assert.equal(s.attention,false);assert.equal(s.status,'working');
});
test('restarts discard window bindings and mark old hook statuses unknown',()=>{
 const w=new Workspace();const s=w.apply(normalize('codex',base)).session;s.window={handle:'5',pid:9};const next=new Workspace(w.serialize()).snapshot()[0];assert.equal(next.window,null);assert.equal(next.status,'unknown');assert.match(next.message,/restarted/);
});
test('configuration merge is idempotent and retains unrelated settings and hooks',()=>{
 const original={permissions:{allow:['Read']},hooks:{Stop:[{hooks:[{type:'command',command:'existing.exe'}]}]}};
 for(const agent of ['claude','codex']){
  const once=addHooks(original,agent,'C:\\Folder with spaces\\report.cjs','C:\\Program Files\\nodejs\\node.exe');const twice=addHooks(once,agent,'C:\\Folder with spaces\\report.cjs','C:\\Program Files\\nodejs\\node.exe');assert.deepEqual(once,twice);assert.deepEqual(once.permissions,original.permissions);assert.equal(once.hooks.Stop[0].hooks[0].command,'existing.exe');assert.deepEqual(removeHooks(once),original);
  if(agent==='claude')assert.deepEqual(once.hooks.Stop[1].hooks[0].args,['C:\\Folder with spaces\\report.cjs','claude','panorama-windows-observer']);
 }
});
test('configuration with unexpected hook structure fails before writing',()=>{
 assert.throws(()=>addHooks({hooks:{Stop:{}}},'claude','a'));assert.throws(()=>addHooks({hooks:[]},'codex','a'));
});
test('invalid and unicode authentication values never throw',()=>{
 assert.equal(keyMatches(undefined,'abc'),false);assert.equal(keyMatches('é','a'),false);assert.equal(keyMatches('abc','abc'),true);
});
async function startApp(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'panorama-test-'));const app=createPanorama({dataDir:dir,isWindows:false,...options});const url=await app.start(0);const bridge=JSON.parse(fs.readFileSync(path.join(dir,'bridge.json'),'utf8'));const bootstrap=await fetch(url+'/api/bootstrap').then(r=>r.json());t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true})});return {app,url,bridge,uiKey:bootstrap.key};
}
const post=(url,key,data)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Panorama-Key':key},body:JSON.stringify(data)});
test('API rejects unauthenticated, cross-site and DNS-rebound requests',async t=>{
 const {url,bridge,uiKey}=await startApp(t);
 assert.equal((await fetch(url+'/api/state')).status,401);
 assert.equal((await fetch(url+'/api/bootstrap',{headers:{Origin:'https://example.com'}})).status,403);
 // Fetch owns its Host header. Use raw HTTP to exercise DNS-rebinding defense.
 const invalidHost=await new Promise((resolve,reject)=>{const req=require('node:http').get(url+'/api/bootstrap',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject)});
 assert.equal(invalidHost,403);
 assert.equal((await post(url+'/api/hooks/codex',uiKey,base)).status,401);
 assert.equal((await fetch(url+'/api/state',{headers:{'X-Panorama-Key':bridge.token}})).status,401);
});
test('reporter delivers a real hook through the bridge, emitting no approval decision',async t=>{
 const {app,bridge}=await startApp(t);const child=spawn(process.execPath,[path.join(__dirname,'..','hooks','report.cjs'),'codex'],{env:{...process.env,PANORAMA_DATA_DIR:app.dataDir},stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',s=>output+=s);child.stdin.end(JSON.stringify(base));const code=await new Promise(resolve=>child.on('close',resolve));assert.equal(code,0);assert.equal(output,'{}');assert.equal(app.workspace.snapshot()[0].status,'working');assert.ok(bridge.token.length>30);
});
test('reporter fails silently when helper is absent or stdin is malformed',async()=>{
 for(const input of ['not-json',JSON.stringify(base)]){
  const child=spawn(process.execPath,[path.join(__dirname,'..','hooks','report.cjs'),'claude'],{env:{...process.env,PANORAMA_DATA_DIR:path.join(os.tmpdir(),'panorama-does-not-exist-'+Date.now())},stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',s=>output+=s);child.stdin.end(input);const code=await new Promise(resolve=>child.on('close',resolve));assert.equal(code,0);assert.equal(output,'{}');
 }
});
test('manual tracking survives restart; user status never sends an agent reply',async t=>{
 const {url,uiKey,app}=await startApp(t);const r=await post(url+'/api/session',uiKey,{title:'A manually tracked chat',project:'Writing',agent:'chatgpt'});assert.equal(r.status,200);const {session}=await r.json();assert.equal(session.source,'manual');const response=await post(url+'/api/action',uiKey,{id:session.id,action:'status',status:'needs_input'});assert.equal(response.status,200);assert.equal(app.workspace.snapshot()[0].attention,true);assert.equal(new Workspace(app.workspace.serialize()).snapshot()[0].title,session.title);
});
test('native bindings require an actual enumerated handle and PID',async t=>{
 const calls=[];const native=async(action,win)=>{calls.push([action,win]);return action==='list'?[{handle:'21',pid:100,title:'VS Code - Project',process:'Code'}]:{focused:true,message:'Window brought forward.'}};
 const {url,uiKey,app}=await startApp(t,{native,isWindows:true});await new Promise(r=>setImmediate(r));const s=app.workspace.manual({title:'My session'});
 assert.equal((await post(url+'/api/action',uiKey,{id:s.id,action:'bind',handle:'21',pid:999})).status,409);assert.equal((await post(url+'/api/action',uiKey,{id:s.id,action:'bind',handle:'21',pid:100})).status,200);assert.equal((await post(url+'/api/action',uiKey,{id:s.id,action:'focus'})).status,200);assert.equal(calls.at(-1)[0],'focus');
});
