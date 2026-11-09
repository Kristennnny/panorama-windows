'use strict';
const {createHash,randomUUID}=require('node:crypto');
const text=(v,max=300)=>typeof v==='string'?v.slice(0,max):'';
const leaf=v=>text(v,1000).replace(/[\\/]+$/,'').split(/[\\/]/).pop()||'Unassigned project';
const needsAttention=s=>['needs_input','possible_input','permission','approval_check'].includes(s.status);
const STATES=new Set(['working','needs_input','possible_input','permission','approval_check','ready','idle','closed','unknown']);

// Do not read transcripts or classify natural language as a decision request.
function normalize(agent,payload,now=Date.now()){
  if(!['claude','codex'].includes(agent)||!payload||typeof payload!=='object')return null;
  const name=text(payload.hook_event_name,80);
  const sessionId=text(payload.session_id,200);
  if(!sessionId)return null; // Never merge separate agents by their project directory.
  const tool=text(payload.tool_name,100),kind=text(payload.notification_type,100);
  let status,message='',title='',confirmed=false;
  if(name==='SessionStart'){status='idle';message='Session opened. Waiting for an activity event.'}
  else if(name==='UserPromptSubmit'){status='working';message='Working on your prompt.';title=text(payload.prompt,100).split(/\r?\n/)[0]}
  else if(name==='PreToolUse'){
    if(/(^|[.:_])(?:AskUserQuestion|request_user_input)$/.test(tool)){
      status='needs_input';confirmed=true;
      const questions=payload.tool_input?.questions;
      message=text(Array.isArray(questions)?questions.map(q=>q?.question).filter(q=>typeof q==='string').join(' '):'',500)||'The agent has opened an input request.';
    }else{status='working';message=tool?'Using '+tool+'.':'Tool activity received.'}
  }else if(name==='PostToolUse'){status='working';message='Tool completed; agent activity resumed.'}
  else if(name==='PermissionRequest'){
    status='approval_check';message='Approval requested'+(tool?' for '+tool:'')+'. This may resolve automatically.';
  }else if(name==='Notification'&&agent==='claude'){
    if(kind==='permission_prompt'){status='permission';confirmed=true;message='Claude Code is waiting for permission.'}
    else if(['elicitation_dialog','elicitation_url_dialog','agent_needs_input'].includes(kind)){
      status='needs_input';confirmed=true;message=text(payload.message,500)||'Claude Code needs your input.';
    }else return null; // idle_prompt is not an explicit input request.
  }else if(name==='Stop'){status='ready';message=text(payload.last_assistant_message,500)||'Response ready. The overall task may still require more work.'}
  else if(name==='SessionEnd'){status='closed';message='Session closed.'}
  else if(name==='Interrupt'){status='idle';message='Turn interrupted.'}
  else return null;
  const rawStamp=Number(payload.panorama_timestamp);
  // Bound client clocks so one malformed timestamp cannot freeze future updates.
  const timestamp=Number.isFinite(rawStamp)&&Math.abs(rawStamp-now)<60000?rawStamp:now;
  const id=agent+'-'+createHash('sha256').update(sessionId).digest('hex').slice(0,24);
  return {id,agent,event:name,tool,status,message,title,confirmed,cwd:text(payload.cwd,1000),project:leaf(payload.cwd),updated:timestamp};
}

class Workspace{
  constructor(saved={}){
    this.sessions=new Map();this.logs=Array.isArray(saved.logs)?saved.logs.slice(0,80):[];
    for(const s of Array.isArray(saved.sessions)?saved.sessions:[]){
      if(typeof s.id!=='string'||!STATES.has(s.status))continue;
      // Window handles are ephemeral; never restore a binding after restart.
      this.sessions.set(s.id,{...s,window:null,status:s.source==='hook'?'unknown':s.status,confirmed:false,previousStatus:s.status,...(s.source==='hook'?{message:'Helper restarted. Waiting for a fresh agent event; previous status: '+s.status+'.'}:{})});
    }
  }
  log(message,now=Date.now()){this.logs.unshift({message:text(message,220),time:now});this.logs=this.logs.slice(0,80)}
  apply(event){
    if(!event)return null;
    const old=this.sessions.get(event.id);
    if(old&&event.updated<old.updated)return null;
    const next={...old,...event,title:event.title||old?.title||event.project+' · '+(event.agent==='claude'?'Claude Code':'Codex'),source:'hook',window:old?.window||null};
    // Dedupe PermissionRequest + delayed confirmation for the same request.
    const newAlert=needsAttention(next)&&(!old||!needsAttention(old));
    if(!needsAttention(next)||newAlert){next.snoozedUntil=0;next.reviewed=false}
    if(newAlert)next.alertId=randomUUID();
    if(!needsAttention(next))next.alertId=null;
    this.sessions.set(next.id,next);
    if(!old||old.status!==next.status)this.log(next.title+' · '+next.status,event.updated);
    return {session:next,newAlert};
  }
  manual(input,now=Date.now()){
    const title=text(input.title,100).trim();if(!title)throw Error('Enter a session title.');
    const s={id:'manual-'+randomUUID(),title,project:text(input.project,80).trim()||'Desktop apps',agent:['claude_app','claude','codex','chatgpt','vscode'].includes(input.agent)?input.agent:'vscode',status:'unknown',message:'Window tracked manually. No automatic question detection.',source:'manual',updated:now,window:null,snoozedUntil:0};
    this.sessions.set(s.id,s);this.log('Tracking '+s.title);return s;
  }
  desktop(observation,now=Date.now()){
    const old=this.sessions.get(observation.id);
    const changed=!old||old.status!==observation.status||old.message!==observation.message;
    const newAlert=needsAttention(observation)&&(!old||!needsAttention(old)||old.evidenceKey!==observation.evidenceKey);
    const next={...old,...observation,updated:changed?now:old.updated};
    if(newAlert){next.alertId=randomUUID();next.snoozedUntil=0;next.reviewed=false}
    if(!needsAttention(next)){next.alertId=null;next.reviewed=false;next.snoozedUntil=0}
    this.sessions.set(next.id,next);if(changed)this.log(next.title+' · '+next.status,now);
    return {session:next,newAlert,changed};
  }
  serialize(){return {sessions:[...this.sessions.values()].filter(s=>s.source!=='desktop').map(s=>({...s,window:null})),logs:this.logs}}
  snapshot(now=Date.now()){
    return [...this.sessions.values()].map(s=>({...s,stale:s.source==='hook'&&s.status==='working'&&now-s.updated>600000,attention:needsAttention(s)&&!s.reviewed&&!(s.snoozedUntil>now)}));
  }
}
module.exports={Workspace,normalize,needsAttention,STATES};
