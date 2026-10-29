import { denied } from './errors.mjs';
const values=value=>Array.isArray(value)?value:typeof value==='string'?JSON.parse(value||'[]'):[];
export const asArray=values;
export function inScope(resource,user,teams) {
 if(resource.owner_id===user.id)return true;
 if(resource.visibility==='organization'&&resource.org_id===user.org_id)return true;
 if(resource.visibility==='team'&&resource.team_id&&teams.has(resource.team_id))return true;
 if(resource.visibility==='custom'&&values(resource.member_ids).includes(user.id))return true;
 return false;
}
export async function requireProject(db,user,projectId) {
 const {rows}=await db.query('SELECT * FROM projects WHERE id=$1 AND org_id=$2',[projectId,user.org_id]);
 const project=rows[0];if(!project)denied();
 const {rows:members}=await db.query('SELECT team_id FROM team_members WHERE user_id=$1',[user.id]);
 if(!inScope(project,user,new Set(members.map(x=>x.team_id))))denied();
 return project;
}
export function assertScopeInput({visibility,teamId,memberIds},validMembers,validTeamIds){
 if(!['private','team','custom','organization'].includes(visibility))throw Object.assign(new Error('Invalid sharing scope'),{status:400,code:'invalid_scope'});
 if(visibility==='team'&&(!teamId||!validTeamIds.has(teamId)))throw Object.assign(new Error('Select a team you belong to'),{status:400,code:'invalid_team'});
 const members=[...new Set(memberIds||[])];if(visibility==='custom'&&(members.length===0||members.some(id=>!validMembers.has(id))))throw Object.assign(new Error('Custom sharing requires members in your organization'),{status:400,code:'invalid_members'});
 return {visibility,teamId:visibility==='team'?teamId:null,memberIds:visibility==='custom'?members:[]};
}
