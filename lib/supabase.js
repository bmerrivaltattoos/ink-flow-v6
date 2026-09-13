'use strict';
class AppError extends Error {
  constructor(message, status=503) { super(message); this.status=status; }
}
class Supabase {
  constructor(env=process.env, transport=fetch) {
    this.url=(env.SUPABASE_URL||'').replace(/\/$/,'');
    this.key=env.SUPABASE_SECRET_KEY||'';
    this.workspace=env.WORKSPACE_ID||'';
    this.bucket=env.SUPABASE_STORAGE_BUCKET||'tattoo-reference-files';
    this.transport=transport;
  }
  get configured() { return Boolean(this.url && this.key && /^[0-9a-f-]{36}$/i.test(this.workspace)); }
  async call(route, {method='GET',body,headers={}}={}) {
    if(!this.configured) throw new AppError('Database is not configured. Contact the artist.');
    const auth={apikey:this.key};
    // Legacy service_role JWTs require Bearer; new sb_secret keys use apikey only.
    if(this.key.startsWith('eyJ')) auth.Authorization=`Bearer ${this.key}`;
    let response;
    try {
      response=await this.transport(this.url+route,{method,headers:{...auth,...headers},body,
        signal:AbortSignal.timeout(20000)});
    } catch { throw new AppError('The booking service is temporarily unavailable. Please try again.'); }
    if(!response.ok) {
      if(response.status===404) throw new AppError('The requested item is unavailable.',404);
      let code='';
      try { code=(await response.json()).code; } catch {}
      if(['P0001','23505','23P01','23514','22P02','22007','22008'].includes(code))
        throw new AppError('This action could not be completed. Check the details and refresh the project; the appointment or payment may have changed.',409);
      throw new AppError('The booking service could not complete this action. Please try again.');
    }
    if(response.status===204) return null;
    return response.json();
  }
  async rows(table, filters={}, order='created_at.desc') {
    const query=new URLSearchParams({select:'*',...filters,workspace_id:`eq.${this.workspace}`,order});
    // Page explicitly: PostgREST otherwise silently caps results at the project row limit.
    const result=[];
    for(let offset=0;;offset+=500) {
      query.set('limit','500'); query.set('offset',String(offset));
      const page=await this.call(`/rest/v1/${table}?${query}`);
      result.push(...page); if(page.length<500) return result;
    }
  }
  command(action,data={}) {
    return this.call('/rest/v1/rpc/ink_flow_command',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({p_workspace:this.workspace,p_action:action,p_data:data})});
  }
}
module.exports={Supabase,AppError};
