import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeJournal } from './journal.mjs';

const execFileAsync=promisify(execFile);
const [marker]=process.argv.slice(2);
const config=JSON.parse(process.env.GT_NODE_CONFIG_JSON||'{}');
const invocation=JSON.parse(process.env.GT_NODE_INVOCATION_JSON||'{}');
const record=JSON.parse(process.env.GT_NODE_RECORD_JSON||'{}');
delete process.env.GT_NODE_CONFIG_JSON;delete process.env.GT_NODE_INVOCATION_JSON;delete process.env.GT_NODE_RECORD_JSON;
if(!marker||!invocation.command||!Array.isArray(invocation.args)||!record.attemptId)process.exit(64);
try{
  const {stdout}=await execFileAsync('ps',['-p',String(process.pid),'-o','lstart=,pgid='],{timeout:2000});
  const match=stdout.trim().match(/^(.{24})\s+(\d+)$/);if(!match)throw new Error('cannot identify supervisor process');
  record.phase='running';record.pid=process.pid;record.marker=marker;record.identity={startTime:match[1].trim(),pgid:Number(match[2])};
  await writeJournal(config,record);
}catch{process.exit(70)}
const child=spawn(invocation.command,invocation.args,{cwd:invocation.cwd,env:invocation.env,shell:false,stdio:'inherit',windowsHide:true});
child.once('error',()=>process.exit(71));child.once('exit',(code,signal)=>{process.exitCode=code??(signal?1:0)});
process.on('SIGTERM',()=>child.kill('SIGTERM'));process.on('SIGINT',()=>child.kill('SIGINT'));
