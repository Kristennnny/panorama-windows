'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomBytes,timingSafeEqual}=require('node:crypto');const {Workspace,normalize,needsAttention,STATES}=require('./lib/state.cjs');const {runNative}=require('./lib/native.cjs');
const {DesktopMonitor}=require('./lib/desktop.cjs');
function keyMatches(a,b){if(typeof a!=='string')return false;const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right)}
function createPanorama(options={}){
  const dataDir=options.dataDir||process.env.PANORAMA_DATA_DIR||path.join(os.homedir(),'.panorama');
  const stateFile=path.join(dataDir,'state.json');fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
  let saved={};try{saved=JSON.parse(fs.readFileSync(stateFile,'utf8'))}catch{}
  const workspace=new Workspace(saved),hookKey=randomBytes(32).toString('hex'),uiKey=randomBytes(32).toString('hex');
  let origin='',windows=[],nativeError='',lastWindowScan=0,scanning=false,capturing=false,notifications=true,closing=false;
  const captures=new Map(),notificationTimers=new Set(),desktopSnapshots=new Map();let persistTimer;
  let monitorClaude=true;let profile={};try{profile=JSON.parse(fs.readFileSync(path.join(__dirname,'claude-profile.json'),'utf8'))}catch{}
  const desktopMonitor=new DesktopMonitor(profile);
  const native=options.native||runNative,isWindows=options.isWindows??process.platform==='win32';
  const persist=()=>{clearTimeout(persistTimer);persistTimer=setTimeout(()=>{fs.writeFileSync(stateFile+'.tmp',JSON.stringify(workspace.serialize()),{mode:0o600});fs.renameSync(stateFile+'.tmp',stateFile)},150)};
  async function scan(){if(!isWindows||scanning||closing)return;scanning=true;try{
    windows=await native('list');if(!Array.isArray(windows))windows=[];
    windows=windows.filter(w=>/^\d+$/.test(w.handle)&&Number.isInteger(w.pid)&&typeof w.title==='string');lastWindowScan=Date.now();nativeError='';
    for(const s of workspace.sessions.values())if(s.window&&!windows.some(w=>w.handle===s.window.handle&&w.pid===s.window.pid))s.window=null;
    const valid=new Set(windows.map(w=>w.handle));for(const key of captures.keys())if(!valid.has(key))captures.delete(key);
    const claudeWindows=windows.filter(w=>w.process?.toLowerCase()==='claude');
    desktopMonitor.forgetExcept(claudeWindows);
    const liveDesktopIds=new Set(claudeWindows.map(w=>'desktop-claude-'+w.pid+'-'+w.handle));
    for(const s of workspace.sessions.values())if(s.source==='desktop'&&(!monitorClaude||!liveDesktopIds.has(s.id)))workspace.sessions.delete(s.id);
    for(const handle of desktopSnapshots.keys())if(!claudeWindows.some(w=>w.handle===handle))desktopSnapshots.delete(handle);
    if(monitorClaude)for(const window of claudeWindows){
      let snapshot;try{snapshot=await native('inspect',window)}catch(e){snapshot={nodes:[],unavailable:e.message}}
      if(closing||!monitorClaude)break;desktopSnapshots.set(window.handle,snapshot);
      const result=workspace.desktop(desktopMonitor.observe(window,snapshot));
      if(result.changed)persist();if(result.newAlert)sendNotification(result.session);
    }
  }catch(e){nativeError=e.message;windows=[];for(const s of workspace.sessions.values())if(s.source==='desktop')workspace.desktop({...s,status:'unknown',window:null,message:'Window monitoring is unavailable: '+e.message});}finally{scanning=false}}
  function sendNotification(s){
    if(!isWindows||!notifications)return;
    const alertId=s.alertId;
    // Wait briefly so an auto-resolved approval doesn't create an unnecessary pop-up.
    const timer=setTimeout(()=>{notificationTimers.delete(timer);const current=workspace.sessions.get(s.id);
      if(!current||current.alertId!==alertId||!needsAttention(current)||current.reviewed||current.snoozedUntil>Date.now())return;
      native('notify',current.window,{title:({codex:'Codex',claude:'Claude Code',claude_app:'Claude app'}[current.agent]||'Agent')+' · '+(current.status==='possible_input'?'Possible reply needed':current.status==='approval_check'?'Approval requested':'Needs you'),message:current.message.slice(0,220)},origin+'/#session='+encodeURIComponent(current.id)).catch(e=>{nativeError=e.message});
    },s.status==='approval_check'?3000:300);notificationTimers.add(timer);
  }
  const state=()=>({sessions:workspace.snapshot(),logs:workspace.logs.slice(0,25),windows,native:{supported:isWindows,error:nativeError,lastScan:lastWindowScan,notifications,monitorClaude},captures:Object.fromEntries([...captures].map(([key,value])=>[key,{updated:value.updated,error:value.error||''}]))});
  function json(res,code,value){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value))}
  async function body(req){if(!String(req.headers['content-type']).startsWith('application/json'))throw Error('Expected JSON.');let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1024*1024)throw Error('Request too large.')}return JSON.parse(raw||'{}')}
  const server=http.createServer(async(req,res)=>{
    // Localhost binding + strict Host and Origin checks protect against DNS rebinding
    // and web pages attempting cross-site calls. No CORS permissions are granted.
    if(req.headers.host!==new URL(origin).host)return json(res,403,{error:'Invalid host.'});
    if(req.headers.origin&&req.headers.origin!==origin)return json(res,403,{error:'Cross-origin request rejected.'});
    if(req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'Cross-site request rejected.'});
    const url=new URL(req.url,origin);
    try{
      if(req.method==='GET'&&url.pathname==='/'){
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"});return res.end(fs.readFileSync(path.join(__dirname,'ui','index.html')))
      }
      if(req.method==='GET'&&url.pathname==='/api/bootstrap')return json(res,200,{key:uiKey});
      if(req.method==='POST'&&url.pathname.startsWith('/api/hooks/')){
        if(!keyMatches(req.headers['x-panorama-key'],hookKey))return json(res,401,{error:'Invalid bridge key.'});
        const event=normalize(url.pathname.split('/').at(-1),await body(req));const result=workspace.apply(event);
        if(result){persist();if(result.newAlert)sendNotification(result.session)}return json(res,200,{accepted:Boolean(result)});
      }
      if(!keyMatches(req.headers['x-panorama-key'],uiKey))return json(res,401,{error:'Open the dashboard to authorize this request.'});
      if(req.method==='GET'&&url.pathname==='/api/state')return json(res,200,state());
      if(req.method==='GET'&&url.pathname==='/api/claude/diagnostic'){
        const snapshot=desktopSnapshots.get(url.searchParams.get('handle'));if(!snapshot)return json(res,404,{error:'No accessibility sample for this Claude window yet.'});
        // Export control labels, not message text or editor values.
        return json(res,200,{unavailable:snapshot.unavailable||'',truncated:Boolean(snapshot.truncated),nodes:(snapshot.nodes||[]).filter(n=>['Button','Edit','Window','Group','Pane'].includes(n.type)).map(n=>({id:n.id,parent:n.parent,type:n.type,name:String(n.name||'').slice(0,80),automationId:n.automationId,enabled:n.enabled,offscreen:n.offscreen}))});
      }
      if(req.method==='GET'&&url.pathname==='/api/thumbnail'){
        const capture=captures.get(url.searchParams.get('handle'));if(!capture?.image)return json(res,404,{error:'No captured preview.'});
        res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store'});return res.end(Buffer.from(capture.image,'base64'));
      }
      if(req.method!=='POST')return json(res,404,{error:'Not found.'});
      const input=await body(req);
      if(url.pathname==='/api/session'){
        const s=workspace.manual(input);persist();return json(res,200,{session:s});
      }
      if(url.pathname==='/api/settings'){
        if(Object.hasOwn(input,'notifications'))notifications=Boolean(input.notifications);
        if(Object.hasOwn(input,'monitorClaude')){monitorClaude=Boolean(input.monitorClaude);if(!monitorClaude){desktopSnapshots.clear();desktopMonitor.windows.clear();for(const s of workspace.sessions.values())if(s.source==='desktop')workspace.sessions.delete(s.id)}}
        return json(res,200,{notifications,monitorClaude});
      }
      if(url.pathname==='/api/test-alert'){
        if(!isWindows)return json(res,409,{error:'Native pop-ups require Windows.'});
        native('notify',null,{title:'Panorama · Test notification',message:'Your Windows notification bridge is running.'},origin).catch(e=>{nativeError=e.message});return json(res,200,{message:'Test sent. Windows notification settings may suppress the pop-up.'});
      }
      if(url.pathname!=='/api/action')return json(res,404,{error:'Not found.'});
      const s=workspace.sessions.get(input.id);if(!s)return json(res,404,{error:'Session not found.'});
      if(input.action==='bind'){
        const selected=windows.find(w=>w.handle===input.handle&&w.pid===Number(input.pid));if(!selected)return json(res,409,{error:'Window no longer available. Refresh the window list.'});
        s.window={handle:selected.handle,pid:selected.pid,title:selected.title};return json(res,200,{message:'Linked to this window. Select the conversation inside the app when needed.'});
      }
      if(input.action==='focus'){
        if(!s.window||!windows.some(w=>w.handle===s.window.handle&&w.pid===s.window.pid))return json(res,409,{error:'Choose a window for this session first.'});
        return json(res,200,await native('focus',s.window));
      }
      if(input.action==='capture'){
        if(!s.window)return json(res,409,{error:'Link a window first.'});if(capturing)return json(res,429,{error:'Another preview is being captured. Try again shortly.'});
        capturing=true;try{
          const image=await native('capture',s.window);if(!/^[A-Za-z0-9+/=\r\n]+$/.test(image)||image.length<100)throw Error('This app did not provide a usable preview.');
          captures.set(s.window.handle,{image,updated:Date.now()});return json(res,200,{message:'Preview refreshed. Some GPU-rendered windows may return a blank frame.'});
        }catch(e){captures.set(s.window.handle,{updated:Date.now(),error:e.message});throw e}finally{capturing=false}
      }
      if(input.action==='snooze'){s.snoozedUntil=Date.now()+300000;workspace.log('Snoozed '+s.title+' for 5 minutes.');persist();return json(res,200,{message:'Snoozed for 5 minutes.'})}
      if(input.action==='review'){s.reviewed=true;workspace.log('Reviewed '+s.title);persist();return json(res,200,{message:'Alert reviewed. Reply or approve in the original app.'})}
      if(input.action==='status'&&s.source==='manual'&&STATES.has(input.status)){s.status=input.status;s.updated=Date.now();s.reviewed=false;s.snoozedUntil=0;persist();return json(res,200,{message:'Manual status updated.'})}
      if(input.action==='remove'){workspace.sessions.delete(s.id);persist();return json(res,200,{message:'Removed from the dashboard. The agent is unchanged.'})}
      return json(res,400,{error:'Unknown action.'});
    }catch(e){return json(res,400,{error:e.message||'Request failed.'})}
  });
  server.requestTimeout=5000;server.headersTimeout=7000;
  let interval;
  async function start(port=4317){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});origin='http://127.0.0.1:'+server.address().port;
    fs.writeFileSync(path.join(dataDir,'bridge.json'),JSON.stringify({port:server.address().port,token:hookKey}),{mode:0o600});
    scan();interval=setInterval(()=>{scan();for(const s of workspace.sessions.values())if(s.snoozedUntil&&s.snoozedUntil<=Date.now()){
      s.snoozedUntil=0;if(needsAttention(s)&&!s.reviewed){workspace.log(s.title+' · snooze ended');s.alertId=randomBytes(12).toString('hex');sendNotification(s)}persist();
    }},5000);return origin;
  }
  async function close(){closing=true;clearInterval(interval);clearTimeout(persistTimer);for(const t of notificationTimers)clearTimeout(t);fs.writeFileSync(stateFile,JSON.stringify(workspace.serialize()),{mode:0o600});await new Promise(resolve=>server.close(resolve))}
  return {start,close,server,workspace,dataDir};
}
if(require.main===module){
  const app=createPanorama();app.start(Number(process.env.PANORAMA_PORT)||4317).then(url=>{
    console.log('\nPanorama is running at '+url+'\nKeep this terminal open. No cloud service or API key is used.');
    if(process.platform==='win32'&&!process.argv.includes('--no-open'))require('node:child_process').execFile('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true},()=>{});
  }).catch(e=>{console.error('Could not start Panorama: '+e.message);process.exit(1)});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().finally(()=>process.exit(0)));
}
module.exports={createPanorama,keyMatches};
