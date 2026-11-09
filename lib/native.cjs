'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFile}=require('node:child_process');
const SCRIPT=fs.readFileSync(path.join(__dirname,'..','native','windows.ps1'),'utf8');
function runNative(action,window=null,note=null,url=''){
  if(process.platform!=='win32')return Promise.reject(Error('Windows actions require Windows.'));
  // No shell interpolation, no changes to PowerShell execution policy. The command
  // is fixed reviewed application code; variable data travels in environment values.
  return new Promise((resolve,reject)=>execFile('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-STA','-Command',SCRIPT],{
    windowsHide:true,timeout:action==='notify'?14000:6000,maxBuffer:4*1024*1024,
    env:{...process.env,PANORAMA_NATIVE_ACTION:action,PANORAMA_WINDOW_HANDLE:window?.handle||'0',PANORAMA_WINDOW_PID:String(window?.pid||0),PANORAMA_NOTIFICATION:Buffer.from(JSON.stringify(note||{})).toString('base64'),PANORAMA_DASHBOARD_URL:url}
  },(error,stdout,stderr)=>{if(error)return reject(Error(stderr.trim().slice(0,350)||error.message));try{resolve(action==='capture'?stdout.trim():action==='notify'?{}:JSON.parse(stdout.replace(/^\uFEFF/,'')))}catch{reject(Error('Windows helper returned an invalid response.'))}}));
}
module.exports={runNative};
