const API_TIMEOUT_MS=10000;

export class WorkerApiError extends Error{
  constructor(message,{status,code}={}){super(message);this.name='WorkerApiError';this.status=status;this.code=typeof code==='string'?code:undefined;this.authorizationLost=status===401||status===403}
}

export class WorkerClient{
  constructor({serverUrl,token,fetchImpl=fetch,timeoutMs=API_TIMEOUT_MS}){this.serverUrl=serverUrl.replace(/\/$/,'');this.token=token;this.fetchImpl=fetchImpl;this.timeoutMs=timeoutMs}
  async request(route,body){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    try{
      const response=await this.fetchImpl(this.serverUrl+'/api/v1/worker/'+route,{method:'POST',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
      let payload;try{payload=await response.json()}catch{throw new WorkerApiError(`Worker API returned invalid JSON (${response.status})`,{status:response.status})}
      if(!response.ok||payload?.error){const message=response.status===401||response.status===403?`Worker authorization failed (${response.status})`:payload?.error?.message||`Worker API request failed (${response.status})`;throw new WorkerApiError(message,{status:response.status,code:payload?.error?.code})}
      if(!payload||typeof payload!=='object'||!('data'in payload))throw new Error('Worker API returned an invalid response envelope');
      return payload.data;
    }catch(error){if(error.name==='AbortError')throw new Error('Worker API request timed out');throw error}finally{clearTimeout(timer)}
  }
  heartbeat(capabilities){return this.request('heartbeat',{capabilities})}
  poll({capacity=1}={}){return this.request('poll',{capacity})}
  event(body){return this.request('events',body)}
}
