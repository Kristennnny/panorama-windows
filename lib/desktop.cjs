'use strict';
const {createHash}=require('node:crypto');
const DEFAULTS={
 workingButtons:['Stop response','Stop generating','Stop generating response','Stop Claude','停止生成','停止回复'],
 composerNames:['Reply to Claude','Message Claude','Write a message','Send a message','回复 Claude','向 Claude 发送消息'],
 assistantNames:["Claude's response",'Claude response','Assistant response','Response from Claude','Claude 回复'],
 assistantIds:['assistant-message','assistant_response','claude-message'],
 userNames:['Your message','User message','你的消息'],userIds:['user-message','user_message'],
 inputLabels:['Waiting for your input','Your input is required','Waiting for your response','等待你的输入','等待您的输入'],
 approvalButtons:['Allow once','Allow this time','Approve','允许一次'],rejectButtons:['Deny','Reject','拒绝']
};
const fingerprint=v=>createHash('sha256').update(v).digest('hex').slice(0,20);
const exact=(value,list)=>list.some(v=>value.toLowerCase()===v.toLowerCase());
function analyze(snapshot,profile={}){
 const p={...DEFAULTS,...profile},nodes=Array.isArray(snapshot?.nodes)?snapshot.nodes:[];
 if(snapshot?.unavailable)return {status:'unknown',message:snapshot.unavailable,key:'unavailable',confidence:'unavailable'};
 const visible=nodes.filter(n=>!n.offscreen),active=visible.filter(n=>n.enabled!==false);
 const controls=active.filter(n=>n.type==='Button');
 if(controls.some(n=>exact(n.name||'',p.workingButtons)))return {status:'working',message:'Claude is generating a response (Stop response control detected).',key:'working',confidence:'control'};
 const input=active.find(n=>(n.type==='StatusBar'||n.type==='Text'&&/status|pending|waiting|input[-_]required/i.test(n.automationId||''))&&exact(n.name||'',p.inputLabels));
 if(input)return {status:'needs_input',message:'Claude is displaying: '+input.name,key:'input:'+input.name,confidence:'control'};
 // An approval label anywhere in an old transcript is not sufficient.
 const containers=visible.filter(n=>n.id!==0&&(n.type==='Window'||/permission|approval|access request|权限|授权/i.test(n.name||'')));
 function within(node,parent){let current=node;const visited=new Set();while(current&&!visited.has(current.id)){if(current.id===parent.id)return true;visited.add(current.id);current=nodes.find(n=>n.id===current.parent)}return false}
 for(const container of containers){const buttons=controls.filter(n=>within(n,container));if(buttons.some(n=>exact(n.name||'',p.approvalButtons))&&buttons.some(n=>exact(n.name||'',p.rejectButtons)))return {status:'permission',message:'Claude has an open approval dialog.',key:'permission:'+container.name,confidence:'control'}}
 if(snapshot.truncated||controls.some(n=>exact(n.name||'',['Scroll to bottom','Jump to latest','Scroll to latest','滚动到底部'])))return {status:'unknown',message:'The latest conversation content is not fully readable. Scroll to the latest message or check diagnostics.',key:'incomplete',confidence:'unavailable'};
 const composer=active.some(n=>n.type==='Edit'&&exact(n.name||'',p.composerNames));
 const role=(n,kind)=>exact(n.name||'',p[kind+'Names'])||p[kind+'Ids'].some(id=>(n.automationId||'').toLowerCase().startsWith(id.toLowerCase()));
 // Semantic message boundaries only. Never search the entire window for '?'.
 const assistants=nodes.filter(n=>role(n,'assistant')),users=nodes.filter(n=>role(n,'user'));
 const last=assistants.at(-1);let response='';
 if(last&&!last.offscreen&&!users.some(n=>n.id>last.id)){
  response=String(last.text||visible.filter(n=>n.type==='Text'&&within(n,last)).map(n=>n.name||'').join('\n')||'').trim().slice(-3000);
 }
 const responseKey=response?fingerprint(response):'';
 if(response&&composer&&/[?？][\s"'”’)*_`]*$/.test(response))return {status:'possible_input',message:'Possible reply needed: '+response.slice(-450),key:'question:'+responseKey,responseKey,composer,confidence:'heuristic'};
 return {status:'unknown',message:composer?'Claude is open; waiting for a detectable activity signal.':'Claude has not exposed recognizable chat controls. Open the conversation and check monitoring diagnostics.',key:'unknown',responseKey,composer,confidence:'unavailable'};
}
class DesktopMonitor{
 constructor(profile={}){this.profile=profile;this.windows=new Map()}
 observe(window,snapshot,now=Date.now()){
  const id='desktop-claude-'+window.pid+'-'+window.handle,context=window.title;
  let previous=this.windows.get(id);if(previous?.context!==context)previous=null;
  const result=analyze(snapshot,this.profile);
  const stable=previous?.key===result.key?previous.stable+1:1;
  let status=result.status,message=result.message;
  if(result.status==='possible_input'&&stable<2){status='unknown';message='Checking whether the latest Claude response is asking for input…'}
  if(result.status==='unknown'&&!snapshot?.unavailable&&result.composer&&previous?.workingSeen&&stable>=2){status='ready';message='Claude stopped generating; a response appears ready.'}
  // Preserve ready while the same readable chat remains stable.
  if(result.status==='unknown'&&result.composer&&previous?.lastStatus==='ready'&&stable>=2){status='ready';message='Claude response appears ready.'}
  const memory={context,key:result.key,stable,workingSeen:result.status==='working'||(result.status==='unknown'&&previous?.workingSeen),lastStatus:status};
  this.windows.set(id,memory);
  return {id,agent:'claude_app',source:'desktop',title:window.title||'Claude desktop',project:'Claude app',status,message,confidence:result.confidence,evidenceKey:result.key,lastChecked:now,window:{handle:window.handle,pid:window.pid,title:window.title}};
 }
 forgetExcept(windows){const ids=new Set(windows.map(w=>'desktop-claude-'+w.pid+'-'+w.handle));for(const id of this.windows.keys())if(!ids.has(id))this.windows.delete(id)}
}
module.exports={analyze,DesktopMonitor,DEFAULTS};
