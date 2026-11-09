'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {analyze,DesktopMonitor}=require('../lib/desktop.cjs');const {Workspace}=require('../lib/state.cjs');const {createPanorama}=require('../server.cjs');
const node=(id,type,name,parent=0,extra={})=>({id,type,name,parent,enabled:true,offscreen:false,...extra});
const root=node(0,'Window','Claude',-1),composer=node(100,'Edit','Reply to Claude');
const w={handle:'22',pid:200,title:'Research - Claude',process:'Claude'};
test('Stop response control detects generation, disabled or hidden buttons do not',()=>{
 assert.equal(analyze({nodes:[root,node(1,'Button','Stop response')]}).status,'working');
 assert.equal(analyze({nodes:[root,node(1,'Button','Stop response',0,{offscreen:true})]}).status,'unknown');
 assert.equal(analyze({nodes:[root,node(1,'Button','Stop response',0,{enabled:false})]}).status,'unknown');
});
test('older questions and sidebar text never become input alerts',()=>{
 const snapshot={nodes:[root,node(1,'Text','Can you choose a dataset?'),node(2,'Button','Old question?'),composer]};assert.equal(analyze(snapshot).status,'unknown');
 assert.equal(analyze({nodes:[root,node(1,'Text','Waiting for your input')]}).status,'unknown');
});
test('only latest readable assistant message gets a tentative question alert',()=>{
 const m=new DesktopMonitor(),snapshot={nodes:[root,node(1,'Group',"Claude's response"),node(2,'Text','Which dataset should I use?',1),composer]};
 assert.equal(m.observe(w,snapshot).status,'unknown');const s=m.observe(w,snapshot);assert.equal(s.status,'possible_input');assert.equal(s.confidence,'heuristic');
 const answered={nodes:[...snapshot.nodes,node(110,'Group','Your message'),node(111,'Text','Use the main dataset.',110)]};assert.equal(analyze(answered).status,'unknown');
});
test('permissions require approval and rejection buttons in the same dialog',()=>{
 const dialog={nodes:[root,node(1,'Window','Permission request'),node(2,'Button','Allow once',1),node(3,'Button','Deny',1)]};assert.equal(analyze(dialog).status,'permission');
 assert.equal(analyze({nodes:[root,node(2,'Button','Allow once'),node(3,'Button','Deny')]}).status,'unknown');
});
test('readiness needs an observed working-to-idle transition, not mere inactivity',()=>{
 const m=new DesktopMonitor(),idle={nodes:[root,composer]};assert.equal(m.observe(w,idle).status,'unknown');assert.equal(m.observe(w,idle).status,'unknown');
 m.observe(w,{nodes:[root,node(1,'Button','Stop response')]});assert.equal(m.observe(w,idle).status,'unknown');assert.equal(m.observe(w,idle).status,'ready');
 assert.equal(m.observe({...w,title:'Different chat'},idle).status,'unknown');
});
test('minimized or unreadable chats are Unknown, not completed or waiting',()=>{
 const m=new DesktopMonitor();m.observe(w,{nodes:[node(1,'Button','Stop response')]});const s=m.observe(w,{nodes:[],unavailable:'Claude is minimized.'});assert.equal(s.status,'unknown');assert.match(s.message,/minimized/);
});
test('desktop observations retain snoozes, deduplicate alerts and separate windows',()=>{
 const monitor=new DesktopMonitor(),workspace=new Workspace();const snap={nodes:[root,node(1,'StatusBar','Waiting for your input')]};const first=workspace.desktop(monitor.observe(w,snap));assert.equal(first.newAlert,true);
 first.session.snoozedUntil=Date.now()+300000;assert.equal(workspace.desktop(monitor.observe(w,snap)).newAlert,false);assert.equal(workspace.snapshot()[0].attention,false);
 const second=monitor.observe({...w,handle:'99'},snap);assert.notEqual(second.id,first.session.id);workspace.desktop(second);assert.equal(workspace.snapshot().length,2);assert.equal(workspace.serialize().sessions.length,0);
});
test('editable profiles can recognize different composer and stop-button labels',()=>{
 assert.equal(analyze({nodes:[root,node(1,'Button','End response')]},{workingButtons:['End response']}).status,'working');
});
test('truncated trees and history scrolling do not classify old questions as current',()=>{
 const nodes=[root,node(1,'Group',"Claude's response"),node(2,'Text','Proceed?',1),composer];
 assert.equal(analyze({nodes,truncated:true}).status,'unknown');
 assert.equal(analyze({nodes:[...nodes,node(101,'Button','Scroll to bottom')]}).status,'unknown');
 assert.equal(analyze({nodes:[...nodes,node(102,'Group',"Claude's response",0,{offscreen:true})]}).status,'unknown');
});
test('server automatically discovers Claude app and reports accessibility evidence',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'panorama-desktop-'));const calls=[];
 const native=async action=>{calls.push(action);if(action==='list')return [w];if(action==='inspect')return {nodes:[root,node(1,'Button','Stop response')]};return {}};
 const app=createPanorama({dataDir:dir,isWindows:true,native});const url=await app.start(0);
 t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true})});
 await new Promise(resolve=>setImmediate(resolve));const s=app.workspace.snapshot()[0];assert.equal(s.agent,'claude_app');assert.equal(s.source,'desktop');assert.equal(s.status,'working');assert.equal(s.window.handle,w.handle);assert.ok(calls.includes('inspect'));
 const key=(await fetch(url+'/api/bootstrap').then(r=>r.json())).key;
 const r=await fetch(url+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json','X-Panorama-Key':key},body:JSON.stringify({monitorClaude:false})});assert.equal(r.status,200);assert.equal(app.workspace.snapshot().length,0);const settings=await r.json();assert.equal(settings.notifications,true);
});
