'use strict';
// Observer only: always exits 0 and returns {}, never approves or blocks a tool.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const timestamp=Date.now();let input='',finished=false;
function finish(){if(finished)return;finished=true;process.stdout.write('{}');process.exit(0)}
const deadline=setTimeout(finish,1200);
process.stdin.setEncoding('utf8');
process.stdin.on('data',s=>{input+=s;if(input.length>1024*1024)finish()});
process.stdin.on('error',finish);
process.stdin.on('end',()=>{
  try{
    const payload=JSON.parse(input);payload.panorama_timestamp=timestamp;
    const bridge=JSON.parse(fs.readFileSync(path.join(process.env.PANORAMA_DATA_DIR||path.join(os.homedir(),'.panorama'),'bridge.json'),'utf8'));
    const agent=process.argv[2];if(!['claude','codex'].includes(agent))return finish();
    const body=JSON.stringify(payload);
    const req=http.request({hostname:'127.0.0.1',port:bridge.port,path:'/api/hooks/'+agent,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'X-Panorama-Key':bridge.token},timeout:700},res=>{res.resume();res.on('end',finish)});
    req.on('timeout',()=>{req.destroy();finish()});req.on('error',finish);req.end(body);
  }catch{finish()}
});
