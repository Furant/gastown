import { randomBytes } from 'node:crypto';
const fixtureToken = randomBytes(24).toString('hex');
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerApiError, WorkerClient } from '../client.mjs';

test('worker requests use bearer auth and unwrap the API envelope',async()=>{
  let seen;const client=new WorkerClient({serverUrl:'http://localhost:8768/',token:'node-secret',fetchImpl:async(url,init)=>{seen={url,init};return{ok:true,json:async()=>({data:{jobs:[],cancellations:[{attemptId:'a'}]}})}}});
  const result=await client.poll();assert.deepEqual(result,{jobs:[],cancellations:[{attemptId:'a'}]});assert.equal(seen.url,'http://localhost:8768/api/v1/worker/poll');assert.equal(seen.init.headers.authorization,'Bearer node-secret');
});

test('worker API errors are surfaced without exposing request credentials',async()=>{
  const client=new WorkerClient({serverUrl:'http://localhost',token:'secret',fetchImpl:async()=>({ok:false,status:401,json:async()=>({error:{message:'Unauthorized'}})})});
  await assert.rejects(client.heartbeat({tools:[]}),/authorization failed \(401\)/);
});

test('worker authorization errors retain only safe status and code metadata',async()=>{
  const client=new WorkerClient({serverUrl:'http://localhost',token:fixtureToken,fetchImpl:async()=>({ok:false,status:403,json:async()=>({error:{code:'node_revoked',message:fixtureToken + ' leaked by server'}})})});
  await assert.rejects(client.poll(),error=>error instanceof WorkerApiError&&error.status===403&&error.code==='node_revoked'&&error.authorizationLost&&!error.message.includes(fixtureToken));
});

test('poll sends available capacity so the server never leases work the node cannot start',async()=>{
  let body;const client=new WorkerClient({serverUrl:'http://localhost',token:'node-secret',fetchImpl:async(_url,init)=>{body=JSON.parse(init.body);return{ok:true,json:async()=>({data:{jobs:[],cancellations:[]}})}}});
  await client.poll({capacity:0});assert.deepEqual(body,{capacity:0});
});
