'use strict';
const {Supabase,AppError}=require('./supabase');
const {randomUUID}=require('node:crypto');
class Repository {
  constructor(client=new Supabase()) { this.client=client; }
  get configured(){return this.client.configured;}
  get workspace(){return this.client.workspace;}
  async list(table, filters={},order) { return this.client.rows(table,filters,order); }
  async one(table,filters) { return (await this.list(table,filters))[0]; }
  request(id) {return this.one('ink_requests',{id:`eq.${id}`});}
  requestByToken(token) {return this.one('ink_requests',{public_token:`eq.${token}`});}
  requests(){return this.list('ink_requests');}
  slots(id){return this.list('ink_slots',{request_id:`eq.${id}`,status:'in.(available,held,booked)'},'start_at.asc,id.asc');}
  async slot(id,request){return (await this.slots(request)).find(s=>s.id===id);}
  appointments(id){return this.list('ink_appointments',id?{request_id:`eq.${id}`}:{},'start_at.asc,id.asc');}
  async activeAppointments(){return this.list('ink_appointments',{status:'in.(scheduled,pending_payment)'},'start_at.asc,id.asc');}
  appointment(id,request){return this.one('ink_appointments',{id:`eq.${id}`,...(request?{request_id:`eq.${request}`}:{})});}
  async pending(id){return (await this.appointments(id)).find(a=>a.status==='pending_payment');}
  async scheduled(id){return (await this.appointments(id)).find(a=>a.status==='scheduled');}
  payments(id){return this.list('ink_payments',{request_id:`eq.${id}`});}
  consent(id){return this.one('ink_consents',{request_id:`eq.${id}`});}
  changes(id){return this.list('ink_changes',id?{request_id:`eq.${id}`}:{status:'eq.open'});}
  photos(id){return this.list('reference_files',{request_id:`eq.${id}`});}
  async totals(id){const r=await this.request(id);if(!r)throw new AppError('Project not found.',404);
    const paid=(await this.payments(id)).filter(p=>p.status==='paid'&&!p.requires_review).reduce((s,p)=>s+p.amount_cents,0);
    return {quote:r.quote_cents||0,deposit:r.deposit_cents||0,paid,remaining:Math.max((r.quote_cents||0)-paid,0)};}
  notifications(){return this.list('ink_notifications',{},'scheduled_for.desc,id.asc');}
  notification(id){return this.one('ink_notifications',{id:`eq.${id}`});}
  command(action,request_id,data={}){return this.client.command(action,{...data,request_id});}
  expire(){return this.client.command('expire');}
  quote(id,estimate,quote,deposit,notes,slots){return this.command('quote',id,{estimate,quote,deposit,notes,slots});}
  book(id,slot_id,hold_minutes){return this.command('book',id,{slot_id,hold_minutes});}
  addSession(id,start,duration,session_type,notes){return this.command('add_session',id,{start,duration,session_type,notes});}
  saveConsent(id,fields){return this.command('consent',id,fields);}
  deposit(id,appointment_id,external_id,amount,kind){return this.command('deposit',id,{appointment_id,external_id,amount,kind});}
  manualPayment(id,amount,note){return this.command('manual_payment',id,{amount,note});}
  cancel(id,appointment_id){return this.command('cancel',id,{appointment_id});}
  change(id,kind,reason,preferred_times){return this.command('change',id,{kind,reason,preferred_times});}
  status(id,status){return this.command('status',id,{status});}
  queue({requestId,appointmentId,kind,recipient,message,sendAfter}) {return this.command('queue',requestId,{appointment_id:appointmentId,kind,recipient,message,send_after:sendAfter});}
  checkout(id,appointment_id,session_id){return this.command('checkout',id,{appointment_id,session_id});}
  claimNotifications(){return this.client.command('notification_claim');}
  notificationResult(id,ok,provider_id){return this.client.command('notification_result',{id,ok,provider_id});}
  notificationNow(id){return this.client.command('notification_now',{id});}
}
const MIME_EXT={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/heic':'heic','image/heif':'heif'};
function validateImage(file) {
  if(!MIME_EXT[file.mime] || !file.data.length || file.data.length>15*1024*1024) throw new AppError('Use JPEG, PNG, WebP, HEIC or HEIF photos up to 15 MB each.',400);
  const b=file.data;
  const valid=file.mime==='image/jpeg'?b[0]===255&&b[1]===216&&b[2]===255:
    file.mime==='image/png'?b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
    file.mime==='image/webp'?b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP':
    b.toString('ascii',4,8)==='ftyp'&&/heic|heix|hevc|hevx|mif1|msf1/.test(b.toString('ascii',8,32));
  if(!valid)throw new AppError('A photo does not match its declared image format.',400);
}
class Storage {
  constructor(client){this.client=client;}
  objectPath(path){if(!path.startsWith(this.client.workspace+'/'))throw new AppError('Photo not found.',404);return path.split('/').map(encodeURIComponent).join('/');}
  async upload(file){validateImage(file);const c=this.client;
    const storage_path=`${c.workspace}/${randomUUID()}.${MIME_EXT[file.mime]}`;
    await c.call(`/storage/v1/object/${encodeURIComponent(c.bucket)}/${this.objectPath(storage_path)}`,{method:'POST',headers:{'Content-Type':file.mime,'x-upsert':'false'},body:file.data});
    return {storage_path,storage_bucket:c.bucket,original_filename:file.filename,mime_type:file.mime,file_size_bytes:file.data.length};}
  async remove(files){if(files.length)await this.client.call(`/storage/v1/object/${encodeURIComponent(this.client.bucket)}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefixes:files.map(f=>{this.objectPath(f.storage_path);return f.storage_path;})})});}
  async signed(id){const c=this.client;const row=(await c.rows('reference_files',{id:`eq.${id}`}))[0];
    if(!row||row.storage_bucket!==c.bucket)throw new AppError('Photo not found.',404);
    const result=await c.call(`/storage/v1/object/sign/${encodeURIComponent(c.bucket)}/${this.objectPath(row.storage_path)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expiresIn:60})});
    const signed=result.signedURL||result.signedUrl;
    if(typeof signed!=='string')throw new AppError('Photo is temporarily unavailable. Refresh to try again.');
    const url=new URL(signed.startsWith('/object/')?'/storage/v1'+signed:signed,c.url);
    if(url.origin!==new URL(c.url).origin)throw new AppError('Photo is temporarily unavailable.');
    return url.href;
  }
}
module.exports={Repository,Storage,validateImage};
