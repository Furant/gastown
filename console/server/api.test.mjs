import { randomBytes } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './db.mjs';
import { createApp } from './app.mjs';
import { generateCheckpointKeys, sealCheckpoint, openCheckpoint } from '../shared/checkpoint-crypto.mjs';
import { changePassword } from './member-admin.mjs';
import { hashPassword } from './auth.mjs';

const fixtureCredentials = new Map();
function fixturePassword(label) {
  if (!fixtureCredentials.has(label)) fixtureCredentials.set(label, randomBytes(24).toString('hex'));
  return fixtureCredentials.get(label);
}

async function fixture() {
  const db = await createDatabase({ dataDir: ':memory:' });
  const app = await createApp({ db });
  const base = await new Promise(resolve => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${srv.address().port}`));
  });
  return { db, app, base, close: async () => { await new Promise(r => app.close(r)); await db.close(); } };
}

async function req(f, path, {method='GET',body,token,cookie,csrf}={}) {
  const headers={};
  if(body!==undefined) headers['content-type']='application/json';
  if(token) headers.authorization=`Bearer ${token}`;
  if(cookie) headers.cookie=cookie;
  if(csrf) headers['x-csrf-token']=csrf;
  if(['POST','PATCH','PUT','DELETE'].includes(method)) headers.origin=f.base;
  const res=await fetch(f.base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  const json=await res.json();
  return {status:res.status,json,headers:res.headers};
}

async function ownerFixture(t) {
  const f=await fixture(); t.after(f.close);
  const status=await req(f,'/api/v1/auth/status');
  assert.equal(status.json.data.needsBootstrap,true);
  const boot=await req(f,'/api/v1/auth/bootstrap',{method:'POST',body:{organization:'Example',name:'Owner',email:'owner@example.test',password:fixturePassword('very-long-test-password')}});
  assert.equal(boot.status,201);
  const cookie=boot.headers.get('set-cookie').split(';')[0];
  const csrf=boot.json.data.csrfToken;
  const auth={cookie,csrf};
  const team=await req(f,'/api/v1/teams',{method:'POST',...auth,body:{name:'Engineering',memberIds:[]}});
  assert.equal(team.status,201);
  const project=await req(f,'/api/v1/projects',{method:'POST',...auth,body:{name:'Repo',repoUrl:'https://github.com/team/repo.git',baseBranch:'main',visibility:'private'}});
  assert.equal(project.status,201);
  const node=await req(f,'/api/v1/nodes',{method:'POST',...auth,body:{name:'Owner Mac',visibility:'private',projectIds:[project.json.data.id]}});
  assert.equal(node.status,201);
  const token=node.json.data.token;
  const caps=await req(f,'/api/v1/capabilities?nodeId='+node.json.data.id,{cookie,csrf});
  assert.equal(caps.status,200);
  assert.equal(caps.json.data.tools.length,0);
  await req(f,'/api/v1/worker/heartbeat',{method:'POST',token,body:{capabilities:{tools:[
    {tool:'codex',models:[{id:'codex-default',name:'Codex default',modes:['low','high'],nativeByMode:{low:'codex-low',high:'codex-high'}}]},
    {tool:'cursor',models:[{id:'cursor-default',name:'Cursor default',modes:['fast','deep'],nativeByMode:{fast:'cursor-fast',deep:'cursor-deep'}}]}
  ]}}});
  const source=await req(f,'/api/v1/connections',{method:'POST',...auth,body:{name:'Codex',nodeId:node.json.data.id,tool:'codex',visibility:'private',projectIds:[project.json.data.id],model:'codex-default',mode:'high',allowedModels:['codex-default'],allowOverride:true,maxConcurrency:2}});
  assert.equal(source.status,201,JSON.stringify(source.json));
  const target=await req(f,'/api/v1/connections',{method:'POST',...auth,body:{name:'Cursor',nodeId:node.json.data.id,tool:'cursor',visibility:'private',projectIds:[project.json.data.id],model:'cursor-default',mode:'deep',allowedModels:['cursor-default'],allowOverride:true,maxConcurrency:2}});
  assert.equal(target.status,201);
  return {f,auth,token,project:project.json.data.id,source:source.json.data.id,target:target.json.data.id};
}

async function approvedRunning(t) {
  const x=await ownerFixture(t);
  const made=await req(x.f,'/api/v1/tasks',{method:'POST',...x.auth,body:{title:'Implement feature',description:'Add a feature with tests',projectId:x.project,connectionId:x.source}});
  assert.equal(made.status,201);
  const plan=await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{}});
  assert.equal(plan.json.data.jobs[0].kind,'plan');
  const planning=plan.json.data.jobs[0];
  await req(x.f,'/api/v1/worker/events',{method:'POST',token:x.token,body:{attemptId:planning.attemptId,leaseToken:planning.leaseToken,type:'plan_ready',message:'plan',data:{summary:'Do the work',steps:[{title:'Implement',acceptance:'Tests pass'}]}}});
  const approval=await req(x.f,`/api/v1/tasks/${made.json.data.id}/approve`,{method:'POST',...x.auth,body:{allowPush:true,allowPR:true}});
  assert.equal(approval.status,200);
  const execution=await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{}});
  assert.equal(execution.json.data.jobs[0].kind,'execute');
  return {...x,task:made.json.data.id,attempt:execution.json.data.jobs[0]};
}

test('bootstrap, user cookie, CSRF and second bootstrap rejection',async t=>{
 const f=await fixture();t.after(f.close);
 assert.equal((await req(f,'/api/v1/auth/status')).json.data.needsBootstrap,true);
 const first=await req(f,'/api/v1/auth/bootstrap',{method:'POST',body:{organization:'Org',name:'Owner',email:'owner@example.test',password:fixturePassword('long-enough-password')}});
 assert.equal(first.status,201); assert.match(first.headers.get('set-cookie'),/HttpOnly/);assert.match(first.headers.get('set-cookie'),/SameSite=Strict/);
 assert.equal((await req(f,'/api/v1/auth/bootstrap',{method:'POST',body:{organization:'Bad',name:'Root',email:'x@example.test',password:fixturePassword('long-enough-password')}})).status,409);
 const cookie=first.headers.get('set-cookie').split(';')[0];
 assert.equal((await req(f,'/api/v1/projects',{method:'POST',cookie,body:{name:'X',repoUrl:'https://github.com/a/b.git',baseBranch:'main',visibility:'private'}})).status,403);
 assert.equal((await req(f,'/api/v1/projects',{method:'POST',cookie,csrf:first.json.data.csrfToken,body:{name:'X',repoUrl:'https://github.com/a/b.git',baseBranch:'main',visibility:'private'}})).status,201);
});

test('member disable revokes login, session and owned node credentials while protecting the last admin',async t=>{
 const x=await ownerFixture(t);
 const made=await req(x.f,'/api/v1/members',{method:'POST',...x.auth,body:{name:'Member',email:'disable@example.test',password:fixturePassword('disable-member-password')}});
 const memberLogin=await req(x.f,'/api/v1/auth/login',{method:'POST',body:{email:'disable@example.test',password:fixturePassword('disable-member-password')}});
 const memberAuth={cookie:memberLogin.headers.get('set-cookie').split(';')[0],csrf:memberLogin.json.data.csrfToken};
 assert.equal((await req(x.f,`/api/v1/members/${made.json.data.id}`,{method:'PATCH',...memberAuth,body:{name:'Nope'}})).status,403);
 assert.equal((await req(x.f,'/api/v1/members/'+(await req(x.f,'/api/v1/auth/me',{cookie:x.auth.cookie})).json.data.user.id,{method:'PATCH',...x.auth,body:{disabled:true}})).json.error.code,'self_disable_forbidden');
 assert.equal((await req(x.f,'/api/v1/members/'+(await req(x.f,'/api/v1/auth/me',{cookie:x.auth.cookie})).json.data.user.id,{method:'PATCH',...x.auth,body:{role:'member'}})).json.error.code,'last_admin');
 const node=await req(x.f,'/api/v1/nodes',{method:'POST',...memberAuth,body:{name:'Member node',visibility:'private',projectIds:[]}});
 assert.equal(node.status,201);
 const sharedNode=await req(x.f,'/api/v1/nodes',{method:'POST',...x.auth,body:{name:'Shared node',visibility:'custom',memberIds:[made.json.data.id],projectIds:[x.project]}});
 assert.equal(sharedNode.status,201);
 const disabled=await req(x.f,`/api/v1/members/${made.json.data.id}`,{method:'PATCH',...x.auth,body:{disabled:true}});
 assert.equal(disabled.status,200);assert.ok(disabled.json.data.disabledAt);
 assert.equal((await req(x.f,'/api/v1/auth/me',{cookie:memberAuth.cookie})).status,401);
 assert.equal((await req(x.f,'/api/v1/auth/login',{method:'POST',body:{email:'disable@example.test',password:fixturePassword('disable-member-password')}})).status,401);
 assert.equal((await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{}})).status,200);
 assert.equal((await req(x.f,'/api/v1/worker/poll',{method:'POST',token:node.json.data.token,body:{}})).status,401);
 const nodes=(await req(x.f,'/api/v1/nodes',{cookie:x.auth.cookie})).json.data;
 const scrubbed=nodes.find(item=>item.id===sharedNode.json.data.id);
 assert.deepEqual(scrubbed.memberIds,[]);
});

test('password change verifies current password and invalidates other sessions; administrator reset invalidates all sessions',async t=>{
 const x=await ownerFixture(t);
 const newPassword=fixturePassword('change-password-long-enough');
 const login=await req(x.f,'/api/v1/auth/login',{method:'POST',body:{email:'owner@example.test',password:fixturePassword('very-long-test-password')}});
 const second={cookie:login.headers.get('set-cookie').split(';')[0],csrf:login.json.data.csrfToken};
 assert.equal((await req(x.f,'/api/v1/auth/change-password',{method:'POST',...x.auth,body:{currentPassword:'incorrect-password',newPassword}})).status,403);
 assert.equal((await req(x.f,'/api/v1/auth/change-password',{method:'POST',...x.auth,body:{currentPassword:fixturePassword('very-long-test-password'),newPassword}})).status,200);
 assert.equal((await req(x.f,'/api/v1/auth/me',{cookie:second.cookie})).status,401);
 const reset=await req(x.f,'/api/v1/members/'+(await req(x.f,'/api/v1/auth/me',{cookie:x.auth.cookie})).json.data.user.id+'/reset-password',{method:'POST',...x.auth,body:{password:fixturePassword('new-reset-password-long')}});
 assert.equal(reset.status,200);
 assert.equal((await req(x.f,'/api/v1/auth/me',{cookie:x.auth.cookie})).status,401);
});

test('password change cannot overwrite a reset that wins before its transaction lock',async t=>{
 const x=await ownerFixture(t);
 const owner=(await req(x.f,'/api/v1/auth/me',{cookie:x.auth.cookie})).json.data.user;
 const resetPassword=fixturePassword('race-reset-password');
 const changePasswordValue=fixturePassword('race-change-password');
 const resetHash=await hashPassword(resetPassword);
 const raceDb={
  query:(...args)=>x.f.db.query(...args),
  transaction:async fn=>{await x.f.db.query('UPDATE users SET password_hash=$2 WHERE id=$1',[owner.id,resetHash]);return x.f.db.transaction(fn)}
 };
 await assert.rejects(changePassword(raceDb,{id:owner.id,org_id:owner.organizationId},{currentPassword:fixturePassword('very-long-test-password'),newPassword:changePasswordValue},'preserve-session'),/Current password is incorrect/);
 assert.equal((await req(x.f,'/api/v1/auth/login',{method:'POST',body:{email:owner.email,password:resetPassword}})).status,200);
 assert.equal((await req(x.f,'/api/v1/auth/login',{method:'POST',body:{email:owner.email,password:changePasswordValue}})).status,401);
});

test('team edits require owner or admin and constrain membership to enabled same-organization users',async t=>{
 const x=await ownerFixture(t);
 const team=(await req(x.f,'/api/v1/teams',{cookie:x.auth.cookie})).json.data[0];
 const created=await req(x.f,'/api/v1/members',{method:'POST',...x.auth,body:{name:'Teammate',email:'team@example.test',password:fixturePassword('team-member-password')}});
 const updated=await req(x.f,`/api/v1/teams/${team.id}`,{method:'PATCH',...x.auth,body:{name:'Platform',memberIds:[created.json.data.id]}});
 assert.equal(updated.status,200);assert.equal(updated.json.data.name,'Platform');assert.deepEqual(new Set(updated.json.data.memberIds),new Set([created.json.data.id,(await req(x.f,'/api/v1/auth/me',{cookie:x.auth.cookie})).json.data.user.id]));
 assert.equal((await req(x.f,`/api/v1/teams/${team.id}`,{method:'PATCH',...x.auth,body:{memberIds:['outside-organization']}})).status,400);
 const login=await req(x.f,'/api/v1/auth/login',{method:'POST',body:{email:'team@example.test',password:fixturePassword('team-member-password')}});
 const memberAuth={cookie:login.headers.get('set-cookie').split(';')[0],csrf:login.json.data.csrfToken};
 assert.equal((await req(x.f,`/api/v1/teams/${team.id}`,{method:'PATCH',...memberAuth,body:{name:'Hijack'}})).status,403);
 const visibleTeam=(await req(x.f,'/api/v1/teams',{cookie:memberAuth.cookie})).json.data[0];
 assert.ok(visibleTeam.memberIds.includes(created.json.data.id));
 assert.ok(visibleTeam.memberIds.includes((await req(x.f,'/api/v1/auth/me',{cookie:x.auth.cookie})).json.data.user.id));
});

test('removing a member from a shared team requests worker stop and cancels without requeueing',async t=>{
 const x=await ownerFixture(t);
 const member=await req(x.f,'/api/v1/members',{method:'POST',...x.auth,body:{name:'Shared member',email:'shared@example.test',password:fixturePassword('shared-member-password')}});
 const team=(await req(x.f,'/api/v1/teams',{cookie:x.auth.cookie})).json.data[0];
 await req(x.f,`/api/v1/teams/${team.id}`,{method:'PATCH',...x.auth,body:{memberIds:[member.json.data.id]}});
 const project=await req(x.f,'/api/v1/projects',{method:'POST',...x.auth,body:{name:'Team repo',repoUrl:'https://github.com/team/shared.git',baseBranch:'main',visibility:'custom',memberIds:[member.json.data.id]}});
 const node=await req(x.f,'/api/v1/nodes',{method:'POST',...x.auth,body:{name:'Team runner',visibility:'team',teamId:team.id,projectIds:[project.json.data.id]}});
 const caps={tools:[{tool:'codex',models:[{id:'codex-default',name:'Codex default',modes:['high']}]}]};
 await req(x.f,'/api/v1/worker/heartbeat',{method:'POST',token:node.json.data.token,body:{capabilities:caps}});
 const conn=await req(x.f,'/api/v1/connections',{method:'POST',...x.auth,body:{name:'Team Codex',nodeId:node.json.data.id,tool:'codex',visibility:'custom',memberIds:[member.json.data.id],projectIds:[project.json.data.id],model:'codex-default',mode:'high',allowedModels:['codex-default'],allowOverride:false,maxConcurrency:1}});
 const login=await req(x.f,'/api/v1/auth/login',{method:'POST',body:{email:'shared@example.test',password:fixturePassword('shared-member-password')}});
 const memberAuth={cookie:login.headers.get('set-cookie').split(';')[0],csrf:login.json.data.csrfToken};
 const made=await req(x.f,'/api/v1/tasks',{method:'POST',...memberAuth,body:{title:'Shared work',description:'Must stop when team access is removed',projectId:project.json.data.id,connectionId:conn.json.data.id}});
 assert.equal(made.status,201,JSON.stringify(made.json));
 const plan=(await req(x.f,'/api/v1/worker/poll',{method:'POST',token:node.json.data.token,body:{}})).json.data.jobs[0];
 await req(x.f,'/api/v1/worker/events',{method:'POST',token:node.json.data.token,body:{attemptId:plan.attemptId,leaseToken:plan.leaseToken,type:'plan_ready',data:{summary:'Plan',steps:[{title:'Work',acceptance:'Done'}]}}});
 await req(x.f,`/api/v1/tasks/${made.json.data.id}/approve`,{method:'POST',...memberAuth,body:{allowPush:false,allowPR:false}});
 const run=(await req(x.f,'/api/v1/worker/poll',{method:'POST',token:node.json.data.token,body:{}})).json.data.jobs[0];
 assert.equal(run.kind,'execute');
 const queued=await req(x.f,'/api/v1/tasks',{method:'POST',...memberAuth,body:{title:'Queued shared work',description:'Must not be claimed after access is removed',projectId:project.json.data.id,connectionId:conn.json.data.id}});
 assert.equal(queued.status,201);
 const baseTransaction=x.f.db.transaction.bind(x.f.db);
 let markLocked,releaseLocked;
 const orgLockHeld=new Promise(resolve=>{markLocked=resolve});
 const allowTeamEdit=new Promise(resolve=>{releaseLocked=resolve});
 const transactionQueries=[];
 let gate=true;
 x.f.db.transaction=fn=>baseTransaction(tx=>fn({query:async(sql,params)=>{transactionQueries.push(sql);const result=await tx.query(sql,params);if(gate&&sql.includes('SELECT id FROM orgs WHERE id=$1 FOR UPDATE')){gate=false;markLocked();await allowTeamEdit;}return result}}));
 const removalPromise=req(x.f,`/api/v1/teams/${team.id}`,{method:'PATCH',...x.auth,body:{memberIds:[]}});
 await orgLockHeld;
 const pollPromise=req(x.f,'/api/v1/worker/poll',{method:'POST',token:node.json.data.token,body:{}});
 releaseLocked();
 const [removed,racedPoll]=await Promise.all([removalPromise,pollPromise]);
 x.f.db.transaction=baseTransaction;
 assert.equal(removed.status,200);
 assert.match(transactionQueries[0],/SELECT id FROM orgs .*FOR UPDATE/);
 assert.ok(transactionQueries.some(sql=>sql.includes('SELECT * FROM teams WHERE id=$1 AND org_id=$2 FOR UPDATE')));
 assert.ok(transactionQueries.some(sql=>sql.includes('SELECT id FROM nodes WHERE id=$1 FOR UPDATE')));
 assert.equal(racedPoll.json.data.jobs.length,0);
 assert.equal(racedPoll.json.data.cancellations[0].reason,'cancel');
 assert.equal((await x.f.db.query('SELECT status FROM tasks WHERE id=$1',[queued.json.data.id])).rows[0].status,'planning_queued');
 const cancel=racedPoll.json.data.cancellations[0];
 assert.equal(cancel.reason,'cancel');
 const flushed=await req(x.f,'/api/v1/worker/events',{method:'POST',token:node.json.data.token,body:{attemptId:run.attemptId,leaseToken:run.leaseToken,type:'usage',data:{eventId:'final-usage',inputTokens:11,outputTokens:4}}});
 assert.equal(flushed.status,200);assert.equal(flushed.json.data.duplicate,false);
 assert.equal((await req(x.f,'/api/v1/worker/events',{method:'POST',token:node.json.data.token,body:{attemptId:run.attemptId,leaseToken:run.leaseToken,type:'stopped'}})).json.data.status,'canceled');
 assert.equal((await req(x.f,'/api/v1/worker/poll',{method:'POST',token:node.json.data.token,body:{}})).json.data.jobs.length,0);
});

test('usage reports idempotent actual measurements and budget blocks later planning or execution claims',async t=>{
 const x=await ownerFixture(t);
 const budget=await req(x.f,`/api/v1/projects/${x.project}/budget`,{method:'PUT',...x.auth,body:{enabled:true,maxRunsPerDay:1}});
 assert.equal(budget.status,200);assert.equal(budget.json.data.timezone,'UTC');
 const task=await req(x.f,'/api/v1/tasks',{method:'POST',...x.auth,body:{title:'Budget task',description:'Track actual usage',projectId:x.project,connectionId:x.source}});
 const planning=(await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{}})).json.data.jobs[0];
 const usage={attemptId:planning.attemptId,leaseToken:planning.leaseToken,type:'usage',data:{eventId:'usage-1',inputTokens:100,outputTokens:20,cachedInputTokens:8,costMicros:55}};
 assert.equal((await req(x.f,'/api/v1/worker/events',{method:'POST',token:x.token,body:usage})).json.data.duplicate,false);
 assert.equal((await req(x.f,'/api/v1/worker/events',{method:'POST',token:x.token,body:usage})).json.data.duplicate,true);
 const totals=await req(x.f,`/api/v1/usage?projectId=${x.project}`,{cookie:x.auth.cookie});
 assert.equal(totals.json.data.inputTokens,100);assert.equal(totals.json.data.recordedCostMicros,55);assert.equal(totals.json.data.costCoverage.unknownRuns,0);
 await req(x.f,'/api/v1/worker/events',{method:'POST',token:x.token,body:{attemptId:planning.attemptId,leaseToken:planning.leaseToken,type:'plan_ready',data:{summary:'Plan',steps:[{title:'Work',acceptance:'Done'}]}}});
 await req(x.f,`/api/v1/tasks/${task.json.data.id}/approve`,{method:'POST',...x.auth,body:{allowPush:false,allowPR:false}});
 assert.equal((await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{}})).json.data.jobs.length,0);
 const listed=await req(x.f,'/api/v1/tasks',{cookie:x.auth.cookie});
 assert.match(listed.json.data.find(row=>row.id===task.json.data.id).budgetBlockReason,/run limit/i);
 assert.equal((await req(x.f,`/api/v1/projects/${x.project}/budget`,{cookie:x.auth.cookie})).json.data.maxRunsPerDay,1);
});

test('worker recovery pauses verified stopped work and fences unknown work without a duplicate claim',async t=>{
 const x=await approvedRunning(t);
 const unknown=await req(x.f,'/api/v1/worker/recover',{method:'POST',token:x.token,body:{attemptId:x.attempt.attemptId,leaseToken:x.attempt.leaseToken,outcome:'unknown',message:'PID identity could not be verified'}});
 assert.equal(unknown.status,200);assert.equal(unknown.json.data.status,'recovery_required');
 assert.equal((await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{}})).json.data.jobs.length,0);
 const task=(await req(x.f,`/api/v1/tasks/${x.task}`,{cookie:x.auth.cookie})).json.data;
 assert.equal(task.status,'recovery_required');assert.equal(task.currentAttemptId,x.attempt.attemptId);
 const stopped=await req(x.f,'/api/v1/worker/recover',{method:'POST',token:x.token,body:{attemptId:x.attempt.attemptId,leaseToken:x.attempt.leaseToken,outcome:'stopped'}});
 assert.equal(stopped.status,200);assert.equal(stopped.json.data.status,'paused');
});

test('node credentials stay private and shared node credentials cannot be repurposed by another account',async t=>{
 const x=await ownerFixture(t);
 const member=await req(x.f,'/api/v1/members',{method:'POST',...x.auth,body:{name:'Member',email:'member@example.test',password:fixturePassword('member-test-password')}});
 assert.equal(member.status,201);
 const login=await req(x.f,'/api/v1/auth/login',{method:'POST',body:{email:'member@example.test',password:fixturePassword('member-test-password')}});
 assert.equal(login.status,200);
 const memberAuth={cookie:login.headers.get('set-cookie').split(';')[0],csrf:login.json.data.csrfToken};
 const nodes=await req(x.f,'/api/v1/nodes',{...memberAuth});
 assert.equal(nodes.status,200);
 assert.equal(JSON.stringify(nodes.json).includes(x.token),false);
 assert.equal(JSON.stringify(nodes.json).includes('tokenHash'),false);
 const project=(await req(x.f,'/api/v1/projects',{...memberAuth})).json.data[0];
 assert.equal(project,undefined);
 const created=await req(x.f,'/api/v1/connections',{method:'POST',...memberAuth,body:{name:'Impersonated',nodeId:(await req(x.f,'/api/v1/nodes',{...x.auth})).json.data[0].id,tool:'codex',projectIds:[x.project],model:'codex-default',mode:'high',allowedModels:['codex-default'],allowOverride:true,maxConcurrency:1}});
 assert.equal(created.status,403);
});

test('plans wait for human approval and tasks inherit the connection model settings',async t=>{
 const x=await ownerFixture(t);
 const c=await req(x.f,`/api/v1/connections/${x.source}`,{cookie:x.auth.cookie});
 assert.equal(c.status,200);
 const made=await req(x.f,'/api/v1/tasks',{method:'POST',...x.auth,body:{title:'Implement',description:'Tested implementation',projectId:x.project,connectionId:x.source}});
 assert.equal(made.status,201);
 let poll=await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{}});
 assert.equal(poll.json.data.jobs[0].kind,'plan');assert.equal(poll.json.data.jobs[0].mode,'high');
 const job=poll.json.data.jobs[0];
 await req(x.f,'/api/v1/worker/events',{method:'POST',token:x.token,body:{attemptId:job.attemptId,leaseToken:job.leaseToken,type:'plan_ready',message:'',data:{summary:'Implementation plan',steps:[{title:'Implement',acceptance:'Tests pass'}]}}});
 assert.equal((await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{}})).json.data.jobs.length,0);
 assert.equal((await req(x.f,`/api/v1/tasks/${made.json.data.id}/approve`,{method:'POST',...x.auth,body:{allowPush:true,allowPR:true}})).status,200);
 poll=await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{}});
 assert.equal(poll.json.data.jobs[0].kind,'execute');
});

test('task pause waits for worker stop acknowledgment and retry starts a fresh generation',async t=>{
 const x=await ownerFixture(t);
 const made=await req(x.f,'/api/v1/tasks',{method:'POST',...x.auth,body:{title:'Pause me',description:'Keep work resumable',projectId:x.project,connectionId:x.source}});
 const planning=(await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{}})).json.data.jobs[0];
 const pause=await req(x.f,`/api/v1/tasks/${made.json.data.id}/pause`,{method:'POST',...x.auth});
 assert.equal(pause.status,202);assert.equal(pause.json.data.status,'stopping');
 const cancel=(await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{}})).json.data.cancellations[0];
 assert.equal(cancel.reason,'pause');
 await req(x.f,'/api/v1/worker/events',{method:'POST',token:x.token,body:{attemptId:planning.attemptId,leaseToken:planning.leaseToken,type:'stopped',data:{}}});
 assert.equal((await req(x.f,`/api/v1/tasks/${made.json.data.id}`,{cookie:x.auth.cookie})).json.data.status,'paused');
 assert.equal((await req(x.f,`/api/v1/tasks/${made.json.data.id}/resume`,{method:'POST',...x.auth})).json.data.status,'planning_queued');
 assert.equal((await req(x.f,`/api/v1/tasks/${made.json.data.id}/cancel`,{method:'POST',...x.auth})).json.data.status,'canceled');
 const retry=await req(x.f,`/api/v1/tasks/${made.json.data.id}/retry`,{method:'POST',...x.auth});
 assert.equal(retry.json.data.retryGeneration,1);assert.equal(retry.json.data.status,'planning_queued');
});

test('decomposition validates DAG and parent approval schedules only dependency roots',async t=>{
 const x=await ownerFixture(t);
 const made=await req(x.f,'/api/v1/tasks',{method:'POST',...x.auth,body:{title:'Workflow',description:'Parent plan',projectId:x.project,connectionId:x.source}});
 const plan=(await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{}})).json.data.jobs[0];
 await req(x.f,'/api/v1/worker/events',{method:'POST',token:x.token,body:{attemptId:plan.attemptId,leaseToken:plan.leaseToken,type:'plan_ready',data:{summary:'Split work',steps:[{title:'A',acceptance:'A'},{title:'B',acceptance:'B'}]}}});
 const cyclic=await req(x.f,`/api/v1/tasks/${made.json.data.id}/decompose`,{method:'POST',...x.auth,body:{children:[{key:'a',title:'A',description:'Do A',connectionId:x.source,dependsOn:['b']},{key:'b',title:'B',description:'Do B',connectionId:x.target,dependsOn:['a']}]}});
 assert.equal(cyclic.status,400);
 const decomposition=await req(x.f,`/api/v1/tasks/${made.json.data.id}/decompose`,{method:'POST',...x.auth,body:{children:[{key:'a',title:'A',description:'Do A',connectionId:x.source,dependsOn:[]},{key:'b',title:'B',description:'Do B',connectionId:x.target,dependsOn:['a']}]}});
 assert.equal(decomposition.status,201);assert.equal(decomposition.json.data.children.length,2);
 const detail=await req(x.f,`/api/v1/tasks/${made.json.data.id}`,{cookie:x.auth.cookie});assert.equal(detail.json.data.children.find(c=>c.key==='b').dependsOn[0],'a');
 const approved=await req(x.f,`/api/v1/tasks/${made.json.data.id}/approve`,{method:'POST',...x.auth,body:{allowPush:false,allowPR:false}});assert.equal(approved.json.data.status,'orchestrating');
 const jobs=(await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{capacity:2}})).json.data.jobs;
 assert.equal(jobs.length,1);assert.equal(jobs[0].title,'A');
 await req(x.f,'/api/v1/worker/events',{method:'POST',token:x.token,body:{attemptId:jobs[0].attemptId,leaseToken:jobs[0].leaseToken,type:'completed',data:{branch:'feature/a',summary:'A complete'}}});
 const dependent=(await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{capacity:2}})).json.data.jobs[0];
 assert.equal(dependent.title,'B');assert.equal(dependent.dependencyResults[0].key,'a');assert.equal(dependent.dependencyResults[0].branch,'feature/a');assert.equal(dependent.dependencyResults[0].result.branch,'feature/a');
 const pause=await req(x.f,`/api/v1/tasks/${made.json.data.id}/pause`,{method:'POST',...x.auth});assert.equal(pause.status,202);
 const stop=(await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{}})).json.data.cancellations.find(c=>c.taskId===dependent.taskId);assert.equal(stop.reason,'pause');
 await req(x.f,'/api/v1/worker/events',{method:'POST',token:x.token,body:{attemptId:dependent.attemptId,leaseToken:dependent.leaseToken,type:'stopped',data:{}}});
 assert.equal((await req(x.f,`/api/v1/tasks/${made.json.data.id}`,{cookie:x.auth.cookie})).json.data.status,'paused');
 await req(x.f,`/api/v1/tasks/${made.json.data.id}/resume`,{method:'POST',...x.auth});
 assert.equal((await req(x.f,`/api/v1/tasks/${made.json.data.id}`,{cookie:x.auth.cookie})).json.data.status,'orchestrating');
});

test('cross-node handoff stores ciphertext and releases target only after stop acknowledgment',async t=>{
 const x=await approvedRunning(t),keys=generateCheckpointKeys();
 const targetNode=await req(x.f,'/api/v1/nodes',{method:'POST',...x.auth,body:{name:'Target node',visibility:'private',projectIds:[x.project]}});
 const targetToken=targetNode.json.data.token,targetId=targetNode.json.data.id;
 const caps=(await req(x.f,'/api/v1/worker/heartbeat',{method:'POST',token:x.token,body:{capabilities:{tools:[{tool:'codex',models:[{id:'codex-default',name:'Codex',modes:['low','high']}]},{tool:'cursor',models:[{id:'cursor-default',name:'Cursor',modes:['fast','deep']}]}]}}}));assert.equal(caps.status,200);
 await req(x.f,'/api/v1/worker/heartbeat',{method:'POST',token:targetToken,body:{checkpointPublicKey:keys.publicKey,capabilities:{tools:[{tool:'codex',models:[{id:'codex-default',name:'Codex',modes:['low','high']}]},{tool:'cursor',models:[{id:'cursor-default',name:'Cursor',modes:['fast','deep']}]}]}}});
 const connection=await req(x.f,'/api/v1/connections',{method:'POST',...x.auth,body:{name:'Remote Codex',nodeId:targetId,tool:'codex',visibility:'private',projectIds:[x.project],model:'codex-default',mode:'high',allowedModels:['codex-default'],allowOverride:true,maxConcurrency:1}});assert.equal(connection.status,201);
 const transfer=await req(x.f,`/api/v1/tasks/${x.task}/transfer`,{method:'POST',...x.auth,body:{connectionId:connection.json.data.id}});assert.equal(transfer.status,202);
 const sourceStop=(await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{}})).json.data.cancellations[0];assert.equal(sourceStop.handoff.targetNodeId,targetId);
 const context={taskId:x.task,projectId:x.project,sourceAttemptId:x.attempt.attemptId,targetNodeId:targetId,transferId:sourceStop.handoff.transferId};
 const envelope=sealCheckpoint(Buffer.from('safe checkpoint bytes'),keys.publicKey,context);
 const uploaded=await req(x.f,'/api/v1/worker/checkpoints',{method:'POST',token:x.token,body:{attemptId:x.attempt.attemptId,leaseToken:x.attempt.leaseToken,transferId:context.transferId,envelope}});assert.equal(uploaded.status,201);
 const stopped=await req(x.f,'/api/v1/worker/events',{method:'POST',token:x.token,body:{attemptId:x.attempt.attemptId,leaseToken:x.attempt.leaseToken,type:'stopped',data:{checkpoint:{checkpointId:uploaded.json.data.checkpointId,digest:uploaded.json.data.digest,transferId:context.transferId,branch:'feature/task',dirty:true}}}});assert.equal(stopped.status,200);
 const job=(await req(x.f,'/api/v1/worker/poll',{method:'POST',token:targetToken,body:{}})).json.data.jobs[0];assert.equal(job.checkpoint.checkpointId,uploaded.json.data.checkpointId);assert.equal(job.checkpoint.targetNodeId,targetId);
 const read=await req(x.f,`/api/v1/worker/checkpoints/${uploaded.json.data.checkpointId}/read`,{method:'POST',token:targetToken,body:{attemptId:job.attemptId,leaseToken:job.leaseToken}});assert.equal(read.status,200);assert.equal(openCheckpoint(read.json.data.envelope,keys.privateKey,context).toString(),'safe checkpoint bytes');
 const detail=await req(x.f,`/api/v1/tasks/${x.task}`,{cookie:x.auth.cookie});assert.equal(JSON.stringify(detail.json).includes('ciphertext'),false);
 await x.f.db.query('UPDATE connections SET revoked_at=now() WHERE id=$1',[connection.json.data.id]);
 const revokedRead=await req(x.f,`/api/v1/worker/checkpoints/${uploaded.json.data.checkpointId}/read`,{method:'POST',token:targetToken,body:{attemptId:job.attemptId,leaseToken:job.leaseToken}});assert.equal(revokedRead.status,409);
});

test('handoff cannot start target before source stop ack; preserves one current writer',async t=>{
 const x=await approvedRunning(t);
 const transfer=await req(x.f,`/api/v1/tasks/${x.task}/transfer`,{method:'POST',...x.auth,body:{connectionId:x.target}});
 assert.equal(transfer.status,202);
 const view=await req(x.f,`/api/v1/tasks/${x.task}`,{cookie:x.auth.cookie});
 assert.equal(view.json.data.status,'stopping');
 let poll=await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{}});
 assert.equal(poll.json.data.jobs.length,0);assert.equal(poll.json.data.cancellations.length,1);
 const cancel=poll.json.data.cancellations[0];
 assert.equal((await req(x.f,'/api/v1/worker/events',{method:'POST',token:x.token,body:{attemptId:cancel.attemptId,leaseToken:x.attempt.leaseToken,type:'stopped',message:'stopped cleanly',data:{checkpoint:{branch:'codex/work',worktree:'/repo/.worktrees/work',dirty:true}}}})).status,200);
 poll=await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{}});
 assert.equal(poll.json.data.jobs[0].tool,'cursor');assert.equal(poll.json.data.jobs[0].model,'cursor-default');
 assert.notEqual(poll.json.data.jobs[0].leaseToken,x.attempt.leaseToken);
 assert.equal((await req(x.f,'/api/v1/worker/events',{method:'POST',token:x.token,body:{attemptId:x.attempt.attemptId,leaseToken:x.attempt.leaseToken,type:'log',message:'stale writer'}})).status,409);
});

test('project task visibility does not grant approval or transfer rights to a private connection',async t=>{
 const x=await ownerFixture(t);
 const made=await req(x.f,'/api/v1/tasks',{method:'POST',...x.auth,body:{title:'Private execution',description:'Owner only',projectId:x.project,connectionId:x.source}});
 await x.f.db.query("UPDATE projects SET visibility='organization' WHERE id=$1",[x.project]);
 const member=await req(x.f,'/api/v1/members',{method:'POST',...x.auth,body:{name:'Reader',email:'reader@example.test',password:fixturePassword('reader-test-password')}});
 const login=await req(x.f,'/api/v1/auth/login',{method:'POST',body:{email:'reader@example.test',password:fixturePassword('reader-test-password')}});
 const auth={cookie:login.headers.get('set-cookie').split(';')[0],csrf:login.json.data.csrfToken};
 assert.equal((await req(x.f,`/api/v1/tasks/${made.json.data.id}`,auth)).status,200);
 assert.equal((await req(x.f,`/api/v1/tasks/${made.json.data.id}/approve`,{method:'POST',...auth,body:{allowPush:false,allowPR:false}})).status,403);
 assert.equal((await req(x.f,`/api/v1/tasks/${made.json.data.id}/transfer`,{method:'POST',...auth,body:{connectionId:x.target}})).status,403);
});

test('audit records are scoped to the actor or visible resources, with org-wide access reserved for admins',async t=>{
 const x=await ownerFixture(t);
 const task=await req(x.f,'/api/v1/tasks',{method:'POST',...x.auth,body:{title:'Shared project task',description:'Visible task metadata',projectId:x.project,connectionId:x.source}});
 await x.f.db.query("UPDATE projects SET visibility='organization' WHERE id=$1",[x.project]);
 await req(x.f,'/api/v1/members',{method:'POST',...x.auth,body:{name:'Reader',email:'audit-reader@example.test',password:fixturePassword('reader-test-password')}});
 const login=await req(x.f,'/api/v1/auth/login',{method:'POST',body:{email:'audit-reader@example.test',password:fixturePassword('reader-test-password')}});
 const auth={cookie:login.headers.get('set-cookie').split(';')[0],csrf:login.json.data.csrfToken};
 const audit=await req(x.f,'/api/v1/audit',auth);
 assert.equal(audit.status,200);
 assert.equal(audit.json.data.some(row=>row.objectId===x.source),false);
 assert.equal(audit.json.data.some(row=>row.objectId===task.json.data.id),true);
 const adminAudit=await req(x.f,'/api/v1/audit',{cookie:x.auth.cookie});
 assert.equal(adminAudit.json.data.some(row=>row.objectId===x.source),true);
});

test('worker poll validates capacity, capacity zero only returns cancellations, and returns bounded jobs',async t=>{
 const x=await ownerFixture(t);
 for(let i=0;i<3;i++)assert.equal((await req(x.f,'/api/v1/tasks',{method:'POST',...x.auth,body:{title:`Task ${i}`,description:'Run task',projectId:x.project,connectionId:x.source}})).status,201);
 assert.equal((await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{capacity:-1}})).status,400);
 assert.equal((await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{capacity:1.5}})).status,400);
 assert.equal((await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{capacity:33}})).status,400);
 assert.equal((await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{capacity:0}})).json.data.jobs.length,0);
 assert.equal((await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{capacity:2}})).json.data.jobs.length,2);
});

test('PR-enabled execution requires a branch and a GitHub PR URL matching the project repository',async t=>{
 const x=await approvedRunning(t);
 const base={attemptId:x.attempt.attemptId,leaseToken:x.attempt.leaseToken,type:'completed'};
 assert.equal((await req(x.f,'/api/v1/worker/events',{method:'POST',token:x.token,body:{...base,data:{branch:'work'}}})).status,400);
 assert.equal((await req(x.f,'/api/v1/worker/events',{method:'POST',token:x.token,body:{...base,data:{branch:'work',prUrl:'https://github.com/other/repo/pull/4'}}})).status,400);
 assert.equal((await req(x.f,'/api/v1/worker/events',{method:'POST',token:x.token,body:{...base,data:{branch:'work',prUrl:'https://github.com/team/repo/pull/4',summary:'Done'}}})).status,200);
 const detail=await req(x.f,`/api/v1/tasks/${x.task}`,{cookie:x.auth.cookie});
 assert.equal(detail.json.data.status,'awaiting_review');
 assert.equal(detail.json.data.result.prUrl,'https://github.com/team/repo/pull/4');
});

test('automatic quota failover requires both task and target connection opt-in',async t=>{
 const x=await approvedRunning(t);
 const invalidPolicy=await req(x.f,'/api/v1/connections/'+x.target,{method:'PATCH',...x.auth,body:{allowAutoFailover:'yes'}});
 assert.equal(invalidPolicy.status,400);
 await x.f.db.query('UPDATE connections SET allow_auto_failover=true WHERE id=$1',[x.target]);
 await x.f.db.query('UPDATE tasks SET auto_failover=true WHERE id=$1',[x.task]);
 const failed=await req(x.f,'/api/v1/worker/events',{method:'POST',token:x.token,body:{attemptId:x.attempt.attemptId,leaseToken:x.attempt.leaseToken,type:'quota_exhausted',message:'quota exhausted',data:{checkpoint:{branch:'codex/work',dirty:true}}}});
 assert.equal(failed.status,200);
 assert.equal(failed.json.data.status,'queued');
 const next=await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{capacity:1}});
 assert.equal(next.json.data.jobs[0].tool,'cursor');
 assert.notEqual(next.json.data.jobs[0].connectionId,x.source);
});

test('automatic quota failover does not start a target without a stopped source checkpoint',async t=>{
 const x=await approvedRunning(t);
 await x.f.db.query('UPDATE connections SET allow_auto_failover=true WHERE id=$1',[x.target]);
 await x.f.db.query('UPDATE tasks SET auto_failover=true WHERE id=$1',[x.task]);
 await req(x.f,'/api/v1/worker/events',{method:'POST',token:x.token,body:{attemptId:x.attempt.attemptId,leaseToken:x.attempt.leaseToken,type:'quota_exhausted',message:'quota exhausted'}});
 assert.equal((await req(x.f,`/api/v1/tasks/${x.task}`,{cookie:x.auth.cookie})).json.data.status,'quota_blocked');
 assert.equal((await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{capacity:1}})).json.data.jobs.length,0);
});

test('automatic quota failover never cycles back to a connection that already exhausted quota',async t=>{
 const x=await approvedRunning(t);
 await x.f.db.query('UPDATE connections SET allow_auto_failover=true WHERE id IN ($1,$2)',[x.source,x.target]);
 await x.f.db.query('UPDATE tasks SET auto_failover=true WHERE id=$1',[x.task]);
 await req(x.f,'/api/v1/worker/events',{method:'POST',token:x.token,body:{attemptId:x.attempt.attemptId,leaseToken:x.attempt.leaseToken,type:'quota_exhausted',data:{checkpoint:{branch:'codex/work',dirty:true}}}});
 const cursor=await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{capacity:1}});
 assert.equal(cursor.json.data.jobs[0].tool,'cursor');
 await req(x.f,'/api/v1/worker/events',{method:'POST',token:x.token,body:{attemptId:cursor.json.data.jobs[0].attemptId,leaseToken:cursor.json.data.jobs[0].leaseToken,type:'quota_exhausted',data:{checkpoint:{branch:'codex/work',dirty:true}}}});
 assert.equal((await req(x.f,`/api/v1/tasks/${x.task}`,{cookie:x.auth.cookie})).json.data.status,'quota_blocked');
 assert.equal((await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{capacity:1}})).json.data.jobs.length,0);
});

test('worker claims and events recheck connection revocation and model permissions',async t=>{
 const x=await ownerFixture(t);
 const task=await req(x.f,'/api/v1/tasks',{method:'POST',...x.auth,body:{title:'Permission change',description:'Do not use revoked connection',projectId:x.project,connectionId:x.source}});
 await x.f.db.query("UPDATE connections SET revoked_at=now() WHERE id=$1",[x.source]);
 assert.equal((await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{capacity:1}})).json.data.jobs.length,0);
 const x2=await approvedRunning(t);
 await x2.f.db.query("UPDATE connections SET allowed_models='[]'::jsonb WHERE id=$1",[x2.source]);
 assert.equal((await req(x2.f,'/api/v1/worker/events',{method:'POST',token:x2.token,body:{attemptId:x2.attempt.attemptId,leaseToken:x2.attempt.leaseToken,type:'log',message:'late event'}})).status,409);
 assert.equal((await req(x.f,`/api/v1/tasks/${task.json.data.id}`,{cookie:x.auth.cookie})).status,200);
});

test('node registration status is waiting until heartbeat and owner can revoke without requeueing work',async t=>{
 const x=await ownerFixture(t);
 const node=(await req(x.f,'/api/v1/nodes',{cookie:x.auth.cookie})).json.data[0];
 assert.equal(node.status,'online');
 await x.f.db.query('UPDATE nodes SET online_at=NULL WHERE id=$1',[node.id]);
 assert.equal((await req(x.f,'/api/v1/nodes',{cookie:x.auth.cookie})).json.data[0].status,'waiting');
 const made=await req(x.f,'/api/v1/tasks',{method:'POST',...x.auth,body:{title:'Revoke node',description:'Must not restart',projectId:x.project,connectionId:x.source}});
 assert.equal((await req(x.f,'/api/v1/nodes/'+node.id+'/revoke',{method:'POST',...x.auth,body:{}})).status,200);
 assert.equal((await req(x.f,'/api/v1/nodes',{cookie:x.auth.cookie})).json.data[0].status,'offline');
 assert.equal((await req(x.f,'/api/v1/worker/poll',{method:'POST',token:x.token,body:{capacity:1}})).status,401);
 assert.equal((await req(x.f,`/api/v1/tasks/${made.json.data.id}`,{cookie:x.auth.cookie})).json.data.status,'failed');
});

test('static web modules use a JavaScript MIME type with nosniff enabled',async t=>{
 const f=await fixture();t.after(f.close);
 const response=await fetch(f.base+'/onboarding.mjs');
 assert.equal(response.status,200);
 assert.match(response.headers.get('content-type'),/javascript/);
 assert.equal(response.headers.get('x-content-type-options'),'nosniff');
});
