import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { buildInvocation, parsePlan } from './tools.mjs';
import { ensureWorktree, makeCheckpoint, resolveProject } from './workspace.mjs';

const OUTPUT_LIMIT=256*1024, LINE_LIMIT=32*1024, LOG_LIMIT=3500;
const execFileAsync=promisify(execFile);
const REDACTIONS=[[/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,'Bearer [redacted]'],[/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g,'[redacted credential]'],[/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[:=]\s*)[^\s"']+/gi,'$1[redacted]']];

export function sanitizeOutput(input) {
  let value=String(input??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'');
  for(const [pattern,replacement] of REDACTIONS)value=value.replace(pattern,replacement);
  return value.slice(0,OUTPUT_LIMIT);
}
function finalTextOf(record) {
  if(typeof record?.result==='string')return record.result;
  if(record?.type==='item.completed'&&['agent_message','assistant_message'].includes(record.item?.type)&&typeof record.item.text==='string')return record.item.text;
  return '';
}
const QUOTA_ERROR_CODES=new Set(['usage_limit_reached','insufficient_quota','quota_exceeded']);
function quotaFailure(text) {
  for(const line of String(text??'').split('\n')){try{const value=JSON.parse(line);if(value?.type!=='error')continue;const codes=[value.code,value.error?.code,value.error?.type];if(codes.some(code=>QUOTA_ERROR_CODES.has(code)))return true}catch{}}
  return false;
}
export function looksLikeQuotaExhaustion(message) { return quotaFailure(String(message??'')); }

function makePrompt(job) {
  if(job.kind==='plan')return [
    'Inspect this approved project and prepare a read-only implementation plan.',
    'Do not edit files, install packages, commit, push, create a pull request, or invoke external services.',
    'Return only JSON shaped as {"summary":"...","steps":[{"title":"...","acceptance":"..."}]}. Provide 1-12 concrete steps with verifiable acceptance conditions.',
    'Task: '+job.title,'Request: '+job.description
  ].join('\n\n');
  const steps=job.plan.steps.map((step,i)=>(i+1)+'. '+step.title+': '+step.acceptance).join('\n');
  const delivery=job.allowPR?'After tests, commit and push only this task branch. Create a pull request against the mapped project default branch. Report its URL. NEVER merge it.':job.allowPush?'After tests, commit and push only this task branch. Do not open or merge a pull request.':'Do not commit, push, create a pull request, or merge.';
  return [
    'Implement only the human-approved task plan below in this isolated worktree.',
    'Preserve existing project instructions and unrelated changes. Never switch branches, clean the worktree, amend commits or modify the default branch.',
    'Run relevant tests and report factual results and remaining issues.',delivery,
    'Task: '+job.title,'Request: '+job.description,'Approved plan:\n'+steps
  ].join('\n\n');
}
function processSignal(child,signal,platform=process.platform) {
  if(platform!=='win32'&&child.pid){try{process.kill(-child.pid,signal);return true}catch(error){if(error.code!=='ESRCH')throw error;return false}}
  try{return child.kill(signal)}catch(error){if(error.code!=='ESRCH')throw error;return false}
}
function processGroupAlive(child,platform=process.platform){
  if(platform==='win32'||!child.pid)return child.exitCode===null&&child.signalCode===null;
  try{process.kill(-child.pid,0);return true}catch(error){if(error.code==='ESRCH')return false;if(error.code==='EPERM')return true;throw error}
}
async function verifyPullRequest(worktree){
  let stdout;
  try{({stdout}=await execFileAsync('gh',['pr','view','--json','url,baseRefName,headRefName','--jq','.url + "\\n" + .baseRefName + "\\n" + .headRefName'],{cwd:worktree.path,timeout:5000,maxBuffer:4096,windowsHide:true}))}
  catch(error){throw new Error(`Push was allowed, but a pull request could not be verified with gh: ${sanitizeOutput(error.message)}`)}
  const [url,base,head]=stdout.trim().split(/\r?\n/);if(!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(url)||base!==worktree.project.baseBranch||head!==worktree.branch)throw new Error('Push was allowed, but no pull request targeting the mapped base branch from this task branch could be verified');
  return url;
}

export class AgentRunner {
  constructor({config,capabilities,client,spawnImpl=nodeSpawn,signalProcess,forceSignalProcess,processGroupAlive:groupAlive=processGroupAlive,verifyPullRequestImpl=verifyPullRequest,resolveProjectImpl=resolveProject,ensureWorktreeImpl=ensureWorktree,stopTimeoutMs=8000,logger=console}){
    this.config=config;this.capabilities=capabilities;this.client=client;this.spawnImpl=spawnImpl;
    this.signalProcess=signalProcess||((child)=>processSignal(child,'SIGTERM'));
    this.forceSignalProcess=forceSignalProcess||((child)=>processSignal(child,'SIGKILL'));
    this.processGroupAlive=groupAlive;
    this.verifyPullRequest=verifyPullRequestImpl;
    this.resolveProject=resolveProjectImpl;this.ensureWorktree=ensureWorktreeImpl;this.closing=false;
    this.stopTimeoutMs=stopTimeoutMs;this.logger=logger;this.running=new Map();this.taskAttempts=new Map();this.inFlight=new Set();
  }
  emit(session,type,message,data){
    if(session.stopping&&type!=='stopped')return Promise.resolve();
    const request=this.client.event({attemptId:session.job.attemptId,leaseToken:session.job.leaseToken,type,message:sanitizeOutput(message),...(data===undefined?{}:{data})});
    this.inFlight.add(request);request.catch(error=>{session.lastEventError=error}).finally(()=>this.inFlight.delete(request));return request;
  }
  async run(job){
    let session;
    try{
      this.assertCanLaunch();
      this.validate(job);
      if(this.running.has(job.attemptId))throw new Error('Attempt is already running on this node');
      if(this.taskAttempts.has(job.taskId))throw new Error('Another attempt already writes to this task on this node');
      this.taskAttempts.set(job.taskId,job.attemptId);
      const project=await this.resolveProject(this.config,job.projectId);this.assertCanLaunch();
      const invocation=buildInvocation({...job,prompt:makePrompt(job)},{...this.config,capabilities:this.capabilities});
      const worktree=await this.ensureWorktree(project,job.taskId);this.assertCanLaunch();
      invocation.cwd=worktree.path;
      const childEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
      const child=this.spawnImpl(invocation.command,invocation.args,{cwd:invocation.cwd,env:{...childEnv,GIT_TERMINAL_PROMPT:'0',CI:'1'},shell:false,detached:process.platform!=='win32',windowsHide:true,stdio:['ignore','pipe','pipe']});
      session={job,project,worktree,child,output:'',pendingLine:'',stopping:false,terminalState:'running',eventPromises:[]};
      this.running.set(job.attemptId,session);
      session.closed=new Promise(resolve=>{let ended=false;const finish=x=>{if(!ended){ended=true;resolve(x)}};child.once('error',error=>finish({code:1,error}));child.once('close',(code,signal)=>finish({code,signal}))});
      child.stdout?.on('data',bytes=>this.readOutput(session,bytes));child.stderr?.on('data',bytes=>this.readOutput(session,bytes));
      const outcome=await session.closed;this.readOutput(session,Buffer.alloc(0),true);session.exitOutcome=outcome;
      if(session.stopping)throw new Error('Task execution was stopped before completion');
      await this.terminateProcessGroup(child);
      session.processGroupStopped=true;
      const output=this.finalText(session.output);
      if(outcome.error||outcome.code!==0){
        const isQuota=quotaFailure(session.output);
        const checkpoint=isQuota?await makeCheckpoint(worktree):undefined;
        await this.emit(session,isQuota?'quota_exhausted':'failed',output||outcome.error?.message||('Tool exited with status '+outcome.code),checkpoint?{checkpoint}:undefined);
        throw new Error('AI tool execution failed');
      }
      if(job.kind==='plan'){
        const plan=parsePlan(output);
        await this.emit(session,'plan_ready',plan.summary,plan);
        return {status:'plan_ready',plan,worktree};
      }
      const checkpoint=await makeCheckpoint(worktree);
      if(session.stopping)throw new Error('Task execution was stopped before completion');
      session.terminalState='completed';
      const prUrl=job.allowPR?await this.verifyPullRequest(worktree):undefined;
      await this.emit(session,'completed',prUrl?`Pull request created: ${prUrl}`:output.slice(0,8000)||'Task process completed',{branch:checkpoint.branch,summary:output.slice(0,8000),...(prUrl?{prUrl}:{})});
      return {status:job.allowPR?'awaiting_review':'completed',worktree,checkpoint,summary:output,...(prUrl?{prUrl}:{})};
    }catch(error){
      const alreadyReported=error.message==='AI tool execution failed'||error.message==='Task execution was stopped before completion'||error.code==='NODE_SHUTTING_DOWN';
      let safeToReport=true;
      if(session&&!session.processGroupStopped){try{await this.terminateProcessGroup(session.child);session.processGroupStopped=true}catch(stopError){safeToReport=false;this.logger.error('unable to verify process-group shutdown',sanitizeOutput(stopError.message))}}
      if(!alreadyReported&&safeToReport){
        if(session)await this.emit(session,'failed',error.message).catch(()=>{});
        else await this.client.event({attemptId:job?.attemptId,leaseToken:job?.leaseToken,type:'failed',message:sanitizeOutput(error.message)}).catch(()=>{});
      }
      throw error;
    }finally{
      if(session){
        await Promise.allSettled(session.eventPromises);
        if(session.lastEventError)this.logger.error('node event delivery failed',sanitizeOutput(session.lastEventError.message));
        if(session.processGroupStopped){this.running.delete(session.job.attemptId);if(this.taskAttempts.get(session.job.taskId)===session.job.attemptId)this.taskAttempts.delete(session.job.taskId)}
      } else if(this.taskAttempts.get(job?.taskId)===job?.attemptId)this.taskAttempts.delete(job.taskId);
    }
  }
  validate(job){
    for(const key of ['attemptId','leaseToken','taskId','projectId','connectionId','model','mode','title','description'])
      if(typeof job?.[key]!=='string'||!job[key].trim()||job[key].length>20000)throw new Error('Invalid '+key+' in worker job');
    if(!['plan','execute'].includes(job.kind))throw new Error('Invalid worker job kind');
    if(job.kind==='execute'&&(!job.plan||!Array.isArray(job.plan.steps)||job.plan.steps.length<1||job.plan.steps.length>12))throw new Error('Execution job lacks a valid approved plan');
    if(typeof job.allowPush!=='boolean'||typeof job.allowPR!=='boolean'||job.allowPR&&!job.allowPush)throw new Error('Invalid delivery authorization in worker job');
    if(!['codex','cursor'].includes(job.tool)||!this.config[job.tool]||!this.capabilities?.tools?.[job.tool]?.models?.length)throw new Error('Tool is not available on this node');
  }
  assertCanLaunch(){if(this.closing){const error=new Error('Node is shutting down; refusing to launch task');error.code='NODE_SHUTTING_DOWN';throw error}}
  async shutdown(){this.closing=true;const results=await Promise.allSettled([...this.running.keys()].map(id=>this.stop(id)));for(const result of results)if(result.status==='rejected')this.logger.error('shutdown stop failed',sanitizeOutput(result.reason?.message));return results}
  readOutput(session,bytes,flush=false){
    if(session.output.length>=OUTPUT_LIMIT)return;
    session.pendingLine+=bytes.toString('utf8');
    let index;while((index=session.pendingLine.indexOf('\n'))>=0){const line=session.pendingLine.slice(0,index);session.pendingLine=session.pendingLine.slice(index+1);this.processLine(session,line)}
    if(flush&&session.pendingLine){this.processLine(session,session.pendingLine);session.pendingLine=''}
    if(session.pendingLine.length>LINE_LIMIT){session.output+=sanitizeOutput(session.pendingLine.slice(0,LOG_LIMIT));this.processLine(session,'[truncated overlong tool output line]');session.pendingLine=''}
  }
  processLine(session,line){
    if(!line)return;
    const safe=sanitizeOutput(line);session.output=(session.output+safe+'\n').slice(-OUTPUT_LIMIT);
    let parsed;try{parsed=JSON.parse(line)}catch{parsed=null}
    if(parsed?.type==='thinking')return;
    const final=parsed&&(parsed.type==='result'||parsed.type==='item.completed'&&['agent_message','assistant_message'].includes(parsed.item?.type));
    if(!final)session.eventPromises.push(this.emit(session,'log',safe.slice(0,LOG_LIMIT)));
  }
  finalText(output){
    const results=[];for(const line of output.split('\n').filter(Boolean)){try{const value=finalTextOf(JSON.parse(line));if(value)results.push(value)}catch{}}
    return sanitizeOutput(results.at(-1)||output.slice(-8000)).trim();
  }
  async stop(attemptId,leaseToken){
    const session=this.running.get(attemptId);
    if(!session)throw new Error('No active tool attempt exists on this node');
    if(leaseToken!==undefined&&session.job.leaseToken!==leaseToken)throw new Error('Stop request lease does not match the active attempt');
    if(session.stopping&&session.stopPromise)return session.stopPromise;
    if(session.terminalState==='completed')throw new Error('Tool attempt already completed; refusing stopped acknowledgment');
    session.stopping=true;
    session.terminalState='stopping';
    session.stopPromise=(async()=>{
      const child=session.child;
      await this.terminateProcessGroup(child);
      session.processGroupStopped=true;
      const closed=await Promise.race([session.closed.then(()=>true),delay(this.stopTimeoutMs).then(()=>false)]);
      if(!closed)throw new Error('Unable to verify the tool process exited; refusing stopped acknowledgment');
      await session.closed;this.readOutput(session,Buffer.alloc(0),true);
      await Promise.allSettled([...this.inFlight,...session.eventPromises]);
      const checkpoint=await makeCheckpoint(session.worktree);
      await this.client.event({attemptId,leaseToken:session.job.leaseToken,type:'stopped',message:'Source process stopped; worktree checkpoint recorded',data:{checkpoint}});
      session.terminalState='stopped';
      return {stopped:true,checkpoint};
    })().catch(error=>{session.stopPromise=null;throw error});
    return session.stopPromise;
  }
  async terminateProcessGroup(child){
    const waitForGroupExit=async()=>{const deadline=Date.now()+this.stopTimeoutMs;while(await this.processGroupAlive(child)){if(Date.now()>=deadline)return false;await delay(25)}return true};
    if(!await this.processGroupAlive(child))return;
    await this.signalProcess(child,'SIGTERM');
    if(!await waitForGroupExit()){
      await this.forceSignalProcess(child,'SIGKILL');
      if(!await waitForGroupExit())throw new Error('Unable to verify the tool process group stopped; refusing checkpoint or stopped acknowledgment');
    }
  }
}
