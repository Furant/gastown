#!/usr/bin/env node
import { loadConfig } from './config.mjs';
import { WorkerClient } from './client.mjs';
import { discoverCapabilities } from './capabilities.mjs';
import { AgentRunner } from './runner.mjs';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { resolveProject } from './workspace.mjs';

export function parseArgs(args){let configPath,once=false,check=false;for(let i=0;i<args.length;i++){if(args[i]==='--help'||args[i]==='-h')return{help:true};if(args[i]==='--config')configPath=args[++i];else if(args[i]==='--once')once=true;else if(args[i]==='--check')check=true;else throw new Error(`Unknown argument: ${args[i]}`)}if(!configPath)throw new Error('Usage: node console/node/index.mjs --config /absolute/path/node-config.json [--once|--check]');if(once&&check)throw new Error('--once and --check cannot be combined');return{configPath,once,check}}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function capabilityViews(capabilities){
  const list=Array.isArray(capabilities?.tools)?capabilities.tools:Object.entries(capabilities?.tools||{}).map(([tool,value])=>({tool,models:value?.models||[]}));
  const map={};for(const tool of list)map[tool.tool]={models:tool.models||[]};
  return {reported:{tools:list},runner:{tools:map}};
}
export async function checkNode(config,{client=new WorkerClient(config),capabilities,logger=console}={}){
  const projects=[];for(const id of Object.keys(config.projects||{})){const project=await resolveProject(config,id);projects.push({id,path:project.repoPath,baseBranch:project.baseBranch})}
  const configured=Object.entries(config.tools||{});if(!configured.length)throw new Error('Configure at least one execution tool');
  for(const [tool,entry] of configured){const executable=await fs.realpath(entry.command).catch(()=>{throw new Error(`${tool} executable does not exist: ${entry.command}`)});await fs.access(executable,fsConstants.X_OK).catch(()=>{throw new Error(`${tool} executable is not runnable: ${executable}`)})}
  const views=capabilityViews(capabilities||await discoverCapabilities(config));
  for(const [tool] of configured)if(!views.runner.tools[tool]?.models?.length)throw new Error(`${tool} CLI is present, but no supported signed-in models were discovered`);
  await client.heartbeat(views.reported);
  logger.log(`Server authentication: OK (${config.serverUrl})`);for(const project of projects)logger.log(`Project ${project.id}: OK (${project.path}, ${project.baseBranch})`);for(const [tool] of configured)logger.log(`${tool}: OK (${views.runner.tools[tool].models.length} supported models)`);
  return {serverUrl:config.serverUrl,projects,tools:views.runner.tools};
}
export async function startNode(config,{once=false,client:providedClient,capabilities:providedCapabilities,logger=console,signalSource=process,runnerFactory=options=>new AgentRunner(options)}={}){
  const client=providedClient||new WorkerClient(config);
  const views=capabilityViews(providedCapabilities||await discoverCapabilities(config));
  const runner=runnerFactory({config,capabilities:views.runner,client,logger});
  const active=new Map();let stopping=false;
  const onSignal=()=>{stopping=true};signalSource.once('SIGINT',onSignal);signalSource.once('SIGTERM',onSignal);
  const runJob=job=>{const promise=runner.run(job).catch(error=>logger.error('task attempt failed',error.message)).finally(()=>active.delete(job.attemptId));active.set(job.attemptId,promise);return promise};
  let consecutiveFailures=0;
  const handleWorkerError=async error=>{
    if(error.status===401||error.status===403||error.authorizationLost){logger.error('worker authorization was revoked; stopping local tasks');stopping=true;return}
    consecutiveFailures++;logger.error('worker API unavailable; retrying',error.message);
    if(consecutiveFailures>=8){logger.error('worker API retry limit reached; stopping local tasks');stopping=true;return}
    await wait(Math.min(30000,config.pollIntervalMs*2**Math.min(consecutiveFailures-1,5)));
  };
  try{
    let nextHeartbeat=0,nextCapabilityRefresh=Date.now()+300000;
    do{
      if(Date.now()>=nextCapabilityRefresh){try{const updated=capabilityViews(await discoverCapabilities(config));views.reported=updated.reported;views.runner=updated.runner;runner.capabilities=updated.runner}catch(error){logger.error('capability refresh failed',error.message)}nextCapabilityRefresh=Date.now()+300000}
      if(Date.now()>=nextHeartbeat){nextHeartbeat=Date.now()+15000;try{await client.heartbeat(views.reported);consecutiveFailures=0}catch(error){await handleWorkerError(error);if(stopping)break;continue}}
      const capacity=once?config.maxConcurrent:Math.max(0,config.maxConcurrent-Math.max(active.size,runner.running.size));
      let result;try{result=await client.poll({capacity});consecutiveFailures=0}catch(error){await handleWorkerError(error);if(stopping)break;continue}
      for(const cancellation of result.cancellations||[]){
        const session=runner.running.get(cancellation.attemptId);
        if(session&&(!cancellation.taskId||session.job.taskId===cancellation.taskId))await runner.stop(cancellation.attemptId,cancellation.leaseToken).catch(error=>logger.error('stop request failed',error.message));
      }
      const jobs=Array.isArray(result.jobs)?result.jobs:[];
      if(once){for(const job of jobs)await runJob(job);break}
      for(const job of jobs.slice(0,capacity))void runJob(job);
      if(stopping)break;
      await wait(config.pollIntervalMs);
    }while(!stopping);
  }finally{
    if(typeof runner.shutdown==='function')await runner.shutdown();
    else for(const attemptId of runner.running.keys())await runner.stop(attemptId).catch(error=>logger.error('shutdown stop failed',error.message));
    await Promise.allSettled(active.values());signalSource.removeListener('SIGINT',onSignal);signalSource.removeListener('SIGTERM',onSignal);
  }
  return {capabilities:views.reported};
}

if(import.meta.url===new URL(`file://${process.argv[1]}`).href){
  try{const args=parseArgs(process.argv.slice(2));if(args.help)console.log('Gas Town team console execution node\n\nUsage: node console/node/index.mjs --config /absolute/path/node-config.json [--once|--check]\n\nOptions:\n  --config PATH  Load this node\'s private JSON config (mode 0600)\n  --check        Validate paths and tools, discover models, and authenticate without claiming tasks\n  --once         Poll once, execute returned jobs, then exit\n  -h, --help     Show this help\n\nSet GAS_TOWN_NODE_TOKEN in the environment instead of storing a token in the config.');else{const config=await loadConfig(args.configPath);if(args.check)await checkNode(config);else await startNode(config,args)}}catch(error){console.error(error.message);process.exitCode=1}
}
