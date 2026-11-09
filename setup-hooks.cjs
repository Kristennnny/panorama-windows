'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const MARKER='panorama-windows-observer';
const ours=h=>String(h.command||'').includes(MARKER)||(Array.isArray(h.args)&&h.args.includes(MARKER));
function addHooks(existing,agent,reportPath,nodePath=process.execPath){
  const out=structuredClone(existing);out.hooks??={};
  if(!out.hooks||typeof out.hooks!=='object'||Array.isArray(out.hooks))throw Error('Expected a hooks object.');
  const quote=v=>'"'+v.replace(/\\/g,'/').replace(/"/g,'\\"')+'"';
  // Unquoted executable name works in PowerShell, cmd and Git Bash. Node must be
  // on PATH for Codex; Claude's exec form uses the exact executable directly.
  const command='node '+quote(reportPath)+' '+agent+' '+MARKER;
  const names=['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Stop','SessionEnd',...(agent==='claude'?['Notification']:['Interrupt'])];
  for(const name of names){
    const groups=out.hooks[name]??[];if(!Array.isArray(groups))throw Error('Unexpected hook format for '+name);
    const cleaned=groups.map(g=>({...g,hooks:Array.isArray(g.hooks)?g.hooks.filter(h=>!ours(h)):g.hooks})).filter(g=>!Array.isArray(g.hooks)||g.hooks.length);
    const hook={type:'command',command,timeout:2};
    if(agent==='codex')hook.commandWindows=command;
    if(agent==='claude'){hook.command=nodePath;hook.args=[reportPath,agent,MARKER];hook.onFailure='continue'}
    // Observe the event synchronously, but network waits are capped at 1.2s.
    cleaned.push({hooks:[hook]});out.hooks[name]=cleaned;
  }
  return out;
}
function removeHooks(existing){
  const out=structuredClone(existing);for(const key of Object.keys(out.hooks||{})){
    out.hooks[key]=out.hooks[key].map(g=>({...g,hooks:g.hooks.filter(h=>!ours(h))})).filter(g=>g.hooks.length);
    if(!out.hooks[key].length)delete out.hooks[key];
  }return out;
}
if(require.main===module){
  const remove=process.argv.includes('--remove');
  const plan=[['claude',path.join(os.homedir(),'.claude','settings.json')],['codex',path.join(os.homedir(),'.codex','hooks.json')]];
  // Validate both files before making either change; preserve unrelated settings.
  const writes=plan.map(([agent,file])=>{const exists=fs.existsSync(file),original=exists?fs.readFileSync(file,'utf8'):null;const current=original?JSON.parse(original.replace(/^\uFEFF/,'')):{};return {file,original,next:remove?removeHooks(current):addHooks(current,agent,path.join(__dirname,'hooks','report.cjs'))}});
  for(const {file,original,next}of writes){
    fs.mkdirSync(path.dirname(file),{recursive:true});
    if(original!==null)fs.writeFileSync(file+'.panorama-backup-'+Date.now(),original,{flag:'wx'});
    fs.writeFileSync(file+'.panorama-tmp',JSON.stringify(next,null,2)+'\n');fs.renameSync(file+'.panorama-tmp',file);
    console.log((remove?'Removed observer hooks from ':'Merged observer hooks into ')+file);
  }
  console.log('Existing settings were preserved and backed up. Restart the agents. Review and trust the Codex hooks in its Hooks settings or /hooks.');
  console.log('This setup does not change approval policies, enable managed hooks, or modify config.toml.');
}
module.exports={addHooks,removeHooks,MARKER};
