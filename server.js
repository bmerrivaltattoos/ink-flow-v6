const http = require('http');
const path = require('path');
const crypto = require('crypto');
const {Repository,Storage,validateImage}=require('./lib/repository');
const {AppError}=require('./lib/supabase');
const repo=new Repository();
const storage=new Storage(repo.client);

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
const APP_URL = (process.env.APP_URL || `http://${HOST}:${PORT}`).replace(/\/$/, '');
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const NODE_ENV = process.env.NODE_ENV || 'development';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const RESERVATION_HOLD_MINUTES = Math.max(5, Number(process.env.RESERVATION_HOLD_MINUTES || 30));
const SMS_PROVIDER = (process.env.SMS_PROVIDER || '').toLowerCase();
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';
const REMINDER_1_HOURS = Math.max(1, Number(process.env.REMINDER_1_HOURS || 48));
const REMINDER_2_HOURS = Math.max(1, Number(process.env.REMINDER_2_HOURS || 24));
const ALLOW_SIMULATED_PAYMENTS=NODE_ENV!=='production' && process.env.ALLOW_SIMULATED_PAYMENTS==='true';
if(NODE_ENV==='production' && (ADMIN_PASSWORD==='change-me'||ADMIN_PASSWORD.length<16)) throw new Error('Set ADMIN_PASSWORD to at least 16 characters before production startup.');
if(NODE_ENV==='production' && !APP_URL.startsWith('https://')) throw new Error('Set APP_URL to the public HTTPS origin.');

const sessions = new Map();
const adminSalt = Buffer.from('beau-tattoo-admin-v1');
const adminKey = crypto.pbkdf2Sync(ADMIN_PASSWORD, adminSalt, 120000, 32, 'sha256');

function passwordMatches(candidate='') {
  const key = crypto.pbkdf2Sync(String(candidate), adminSalt, 120000, 32, 'sha256');
  return crypto.timingSafeEqual(adminKey, key);
}

function esc(v='') { return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function money(cents) { return cents == null ? '—' : '$' + (Number(cents)/100).toFixed(2); }
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(x => { const i=x.indexOf('='); if(i>0) out[x.slice(0,i).trim()] = decodeURIComponent(x.slice(i+1).trim()); });
  return out;
}
function isAdmin(req) {
  const sid = parseCookies(req).sid;
  if(!sid || !sessions.has(sid)) return false;
  const created = sessions.get(sid);
  if(Date.now() - created > SESSION_TTL_MS){ sessions.delete(sid); return false; }
  return true;
}
function redirect(res, loc) { res.writeHead(302, { Location: loc }); res.end(); }
function send(res, status, body, type='text/html; charset=utf-8') { res.writeHead(status, {'Content-Type':type, 'Cache-Control':'no-store'}); res.end(body); }
function fmtDateTime(s){
  if(!s) return '—';
  const d = new Date(s);
  if(Number.isNaN(d.getTime())) return s;
  return new Intl.DateTimeFormat('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}).format(d);
}
function fmtShort(s){
  if(!s) return '—';
  const d = new Date(s);
  if(Number.isNaN(d.getTime())) return s;
  return new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(d);
}
function isoLocal(v){
  if(!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function durationText(min){
  min=Number(min||0);
  const h=Math.floor(min/60), m=min%60;
  return h && m ? `${h} hr ${m} min` : h ? `${h} hr` : `${m} min`;
}
function overlap(startA,durA,startB,durB){
  const a=new Date(startA).getTime(), b=new Date(startB).getTime();
  return a < b + durB*60000 && b < a + durA*60000;
}
async function conflictFor(startAt,durationMinutes,excludeAppointmentId=null){
  return (await repo.activeAppointments()).find(x=>(!excludeAppointmentId||x.id!==excludeAppointmentId)&&overlap(startAt,durationMinutes,x.start_at,x.duration_minutes));
}
async function requestByToken(token){return repo.requestByToken(token);}
async function totalsFor(id){return repo.totals(id);}

function statusLabel(s){ return ({new:'New request',quoted:'Quoted',pending_deposit:'Deposit pending',booked:'Booked',completed:'Completed'}[s]||s); }

function toIsoMs(ms){ return new Date(ms).toISOString(); }

const POLICY_VERSION = '2026-09-v1';

async function consentFor(id){return repo.consent(id);}
function clientIpHash(req){
  const raw=(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
  if(!raw) return null;
  return crypto.createHash('sha256').update(raw + '|beau-tattoo-consent').digest('hex');
}
function consentRequiredFieldsOk(f){
  return Boolean(
    f.legal_name?.trim() &&
    f.date_of_birth?.trim() &&
    f.signature_name?.trim() &&
    f.accepted_age==='1' &&
    f.accepted_health==='1' &&
    f.accepted_design==='1' &&
    f.accepted_aftercare==='1' &&
    f.accepted_cancellation==='1'
  );
}


async function expireReservations(){return repo.expire();}
async function queueNotification(data){return repo.queue(data);}

function appointmentReminderText(r,a,label){
  return `Reminder from Beau Merrival Tattoo: ${label} — your ${a.session_type || 'tattoo session'} is ${fmtDateTime(a.start_at)}. Project: ${r.placement}, ${r.size}. Reply to Beau if anything changed.`;
}

async function queueBookingMessages(requestId, appointmentId){
  const r=await repo.request(requestId);
  const a=await repo.appointment(appointmentId,requestId);
  if(!r || !a || !r.phone) return;
  const when=fmtDateTime(a.start_at);
  await queueNotification({
    requestId, appointmentId, kind:'booking_confirmation', recipient:r.phone,
    message:`You're booked with Beau Merrival Tattoo for ${when}. Estimated time: ${r.estimated_hours || 'see project'}. Deposit recorded: ${money(r.deposit_cents)}. Keep this link for your project: ${APP_URL}/r/${r.public_token}`,
    sendAfter:new Date().toISOString()
  });
  const startMs=new Date(a.start_at).getTime();
  const now=Date.now();
  const t1=startMs-REMINDER_1_HOURS*3600000;
  const t2=startMs-REMINDER_2_HOURS*3600000;
  if(t1>now) await queueNotification({
    requestId, appointmentId, kind:`reminder_${REMINDER_1_HOURS}h`, recipient:r.phone,
    message:appointmentReminderText(r,a,`${REMINDER_1_HOURS}-hour reminder`),
    sendAfter:new Date(t1).toISOString()
  });
  if(t2>now && t2!==t1) await queueNotification({
    requestId, appointmentId, kind:`reminder_${REMINDER_2_HOURS}h`, recipient:r.phone,
    message:appointmentReminderText(r,a,`${REMINDER_2_HOURS}-hour reminder`),
    sendAfter:new Date(t2).toISOString()
  });
}

async function sendSmsTwilio(to,message){
  if(!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) throw new Error('Twilio credentials are incomplete');
  const body=new URLSearchParams({To:to,From:TWILIO_FROM_NUMBER,Body:message});
  const auth=Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const resp=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`,{
    method:'POST',signal:AbortSignal.timeout(20000),
    headers:{'Authorization':`Basic ${auth}`,'Content-Type':'application/x-www-form-urlencoded'},
    body
  });
  const json=await resp.json();
  if(!resp.ok) throw new AppError('SMS delivery failed.');
  return json.sid || '';
}

let outboxRunning=false;
async function processNotificationOutbox(){
  if(outboxRunning||!repo.configured)return;
  outboxRunning=true;
  try {
    await expireReservations();
    // Recover missing confirmation/reminder enqueue after a process interruption.
    for(const a of await repo.activeAppointments())if(a.status==='scheduled')await queueBookingMessages(a.request_id,a.id);
    if(SMS_PROVIDER!=='twilio'||!TWILIO_ACCOUNT_SID||!TWILIO_AUTH_TOKEN||!TWILIO_FROM_NUMBER)return;
    for(const n of await repo.claimNotifications()){
      try {const sid=await sendSmsTwilio(n.recipient,n.message_body);await repo.notificationResult(n.id,true,sid);}
      catch {await repo.notificationResult(n.id,false,null);}
    }
  } finally {outboxRunning=false;}
}

async function createStripeCheckout({requestRow, appointmentRow}) {
  if(!STRIPE_SECRET_KEY) return null;
  const amount = Number(appointmentRow.deposit_due_cents || 0);
  if(amount <= 0) return null;
  const body = new URLSearchParams();
  body.set('mode','payment');
  body.set('success_url', `${APP_URL}/r/${requestRow.public_token}?paid=1`);
  body.set('cancel_url', `${APP_URL}/r/${requestRow.public_token}?canceled=1`);
  body.set('client_reference_id', String(requestRow.id));
  body.set('metadata[request_id]', String(requestRow.id));
  body.set('metadata[appointment_id]', String(appointmentRow.id));
  body.set('metadata[workspace_id]',repo.workspace);
  body.set('payment_method_types[0]','card');
  body.set('line_items[0][quantity]','1');
  body.set('line_items[0][price_data][currency]','usd');
  body.set('line_items[0][price_data][unit_amount]', String(amount));
  body.set('line_items[0][price_data][product_data][name]', `Tattoo booking deposit — ${requestRow.client_name}`);
  if(requestRow.email) body.set('customer_email', requestRow.email);

  const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method:'POST',signal:AbortSignal.timeout(20000),
    headers:{
      'Authorization':`Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type':'application/x-www-form-urlencoded',
      'Idempotency-Key':`inkflow-${repo.workspace}-${appointmentRow.id}`
    },
    body
  });
  const json = await resp.json();
  if(!resp.ok) throw new AppError('Unable to start payment. Please try again.');
  return json;
}
function parseStripeSignature(header=''){
  const out={};
  for(const part of String(header).split(',')){
    const [k,v]=part.split('=');
    if(k && v) (out[k] ||= []).push(v);
  }
  return out;
}
function verifyStripeWebhook(rawBody, header){
  if(!STRIPE_WEBHOOK_SECRET) return false;
  const sig=parseStripeSignature(header);
  const t=sig.t?.[0], v1=sig.v1||[];
  if(!t || !v1.length || !Number.isFinite(Number(t))) return false;
  if(Math.abs(Date.now()/1000 - Number(t)) > 300) return false;
  const payload=Buffer.concat([Buffer.from(String(t)+'.'), rawBody]);
  const expected=crypto.createHmac('sha256',STRIPE_WEBHOOK_SECRET).update(payload).digest('hex');
  return v1.some(x => {
    const a=Buffer.from(x), b=Buffer.from(expected);
    return a.length===b.length && crypto.timingSafeEqual(a,b);
  });
}
async function finalizeDeposit(requestId,appointmentId,externalId,amount,kind='stripe_deposit'){
  const result=await repo.deposit(requestId,appointmentId,externalId,amount,kind);
  if(result.confirmed)await queueBookingMessages(requestId,appointmentId);
  return result;
}

function layout(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#0b0b0d;--card:#17171a;--panel:#202024;--line:#303038;--text:#f7f7f8;--muted:#aaaab3;--danger:#512020}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:inherit}.wrap{max-width:1120px;margin:auto;padding:18px}.brand{font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);font-weight:800}.top{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:18px}.top h1{font-size:24px;margin:3px 0}.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px;margin-bottom:14px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.field{margin-bottom:12px}.field label{display:block;font-weight:700;margin-bottom:5px}.hint,.muted{color:var(--muted);font-size:13px}input,textarea,select{width:100%;background:#0f0f12;color:#fff;border:1px solid var(--line);border-radius:12px;padding:12px;font:inherit}textarea{min-height:100px;resize:vertical}button,.btn{display:inline-block;border:1px solid var(--line);background:#24242a;color:#fff;border-radius:12px;padding:11px 14px;font:inherit;font-weight:800;text-decoration:none;cursor:pointer}.primary{background:#fff;color:#0a0a0c;border-color:#fff}.danger{background:var(--danger)}.pill{display:inline-block;padding:5px 9px;border:1px solid var(--line);border-radius:999px;background:var(--panel);font-size:12px;font-weight:800}.row{display:flex;gap:10px;align-items:center;justify-content:space-between}.request{display:block;text-decoration:none}.request:hover{border-color:#666}.money{font-size:22px;font-weight:900}.photos{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.photo{aspect-ratio:1;border-radius:12px;border:1px solid var(--line);overflow:hidden;background:#111}.photo img{width:100%;height:100%;object-fit:cover}.notice{padding:12px;border-radius:12px;background:#1f2921;border:1px solid #344c38;margin-bottom:12px}.warn{background:#2d2618;border-color:#54452a}.bad{background:#351a1a;border-color:#663232}.split{display:grid;grid-template-columns:1.2fr .8fr;gap:14px}.slot{display:flex;gap:10px;align-items:center;padding:10px;border:1px solid var(--line);border-radius:12px;margin:8px 0}.slot input{width:auto}.nav{display:flex;gap:8px;flex-wrap:wrap}.small{font-size:12px}.stat{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px}.stat .k{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}.stat .v{font-weight:850;margin-top:3px}.appt{border-left:4px solid #666}.appt.today{border-left-color:#fff}.calendar-day{margin-bottom:20px}.calendar-day h2{position:sticky;top:0;background:var(--bg);padding:8px 0;margin:0 0 8px}.status-new{border-color:#5b5b65}.status-quoted{border-color:#7d714d}.status-booked{border-color:#3e6748}.status-completed{border-color:#35516a}@media(max-width:760px){.split,.grid,.grid3,.grid4{grid-template-columns:1fr}.photos{grid-template-columns:repeat(2,1fr)}.top{align-items:flex-start;flex-direction:column}}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}
function readBody(req, limit=80*1024*1024) {
  return new Promise((resolve,reject)=>{ let chunks=[], size=0,tooLarge=false;
    req.on('data',c=>{size+=c.length;if(size>limit){tooLarge=true;chunks=[];}else if(!tooLarge)chunks.push(c);});
    req.on('end',()=>tooLarge?reject(new AppError('The upload is too large. Choose up to five photos, 15 MB each.',413)):resolve(Buffer.concat(chunks)));
    req.on('error',reject);
  });
}
function parseUrlEncoded(buf){ return Object.fromEntries(new URLSearchParams(buf.toString('utf8'))); }
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType||'');
  if(!m) throw new Error('Missing multipart boundary');
  const boundary = Buffer.from('--' + (m[1]||m[2]));
  const fields = {}; const files=[];
  let start = buf.indexOf(boundary);
  while(start !== -1){
    let next = buf.indexOf(boundary, start + boundary.length); if(next===-1) break;
    let part = buf.subarray(start + boundary.length, next);
    if(part.subarray(0,2).toString()==='\r\n') part=part.subarray(2);
    if(part.subarray(part.length-2).toString()==='\r\n') part=part.subarray(0,part.length-2);
    if(part.length===0 || part.subarray(0,2).toString()==='--') { start=next; continue; }
    const sep = part.indexOf(Buffer.from('\r\n\r\n')); if(sep<0){start=next;continue;}
    const headers = part.subarray(0,sep).toString('utf8'); const data=part.subarray(sep+4);
    const disp=/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headers);
    if(!disp){start=next;continue;}
    const name=disp[1], filename=disp[2];
    if(filename!==undefined && filename!==''){
      const mt=/content-type:\s*([^\r\n]+)/i.exec(headers);
      files.push({field:name, filename:path.basename(filename), mime:mt?mt[1].trim():'application/octet-stream', data});
    } else fields[name]=data.toString('utf8');
    start=next;
  }
  return {fields, files};
}

async function router(req,res){
  const u = new URL(req.url, `http://${req.headers.host||'localhost'}`);
  const p = u.pathname;
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  if(req.method==='GET'&&p==='/health')return send(res,200,JSON.stringify({ok:true,version:'6.0.0-beta.1',database:repo.configured?'configured':'unconfigured',storage:repo.configured?'configured':'unconfigured',stripe:STRIPE_SECRET_KEY&&STRIPE_WEBHOOK_SECRET?'configured':'unconfigured',sms:SMS_PROVIDER==='twilio'&&TWILIO_ACCOUNT_SID&&TWILIO_AUTH_TOKEN&&TWILIO_FROM_NUMBER?'configured':'unconfigured'}),'application/json');
  if(req.method==='POST' && p!=='/stripe/webhook' && (req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&req.headers.origin!==new URL(APP_URL).origin)))return send(res,403,'Request origin is not allowed.','text/plain');
  if(p!=='/' && p!=='/admin' && p!=='/admin/login' && repo.configured)await expireReservations();

  if(req.method==='GET' && p==='/'){
    const body=`<div class="top"><div><div class="brand">Beau Merrival Tattoo</div><h1>Tattoo request</h1><div class="muted">Tell me what you want first. This is a request — not a confirmed appointment.</div></div><a class="btn" href="/admin">Artist login</a></div>
<form class="card" action="/request" method="post" enctype="multipart/form-data">
<div class="grid"><div class="field"><label>Name *</label><input name="client_name" required></div><div class="field"><label>Phone *</label><input name="phone" required inputmode="tel"></div></div>
<div class="field"><label>Email</label><input name="email" type="email"></div>
<div class="field"><label>What do you want tattooed? *</label><textarea name="idea" required placeholder="Describe the design, subject, lettering, people, dates, etc."></textarea></div>
<div class="grid"><div class="field"><label>Placement *</label><input name="placement" required placeholder="Upper arm, forearm, chest..."></div><div class="field"><label>Approximate size *</label><input name="size" required placeholder="Palm size, 7 inches..."></div></div>
<div class="grid"><div class="field"><label>Style *</label><select name="style" required><option>Black & Grey</option><option>Color</option><option>Not sure</option></select></div><div class="field"><label>Cover-up?</label><select name="coverup"><option value="0">No</option><option value="1">Yes</option></select></div></div>
<div class="field"><label>Reference photos</label><input name="photos" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple><div class="hint">Up to 5 images, 15 MB each. JPEG, PNG, WebP, HEIC or HEIF.</div></div>
<div class="field"><label>Anything else?</label><textarea name="notes" placeholder="Scheduling notes, preferences, concerns..."></textarea></div>
<button class="primary">Submit tattoo request</button></form>`;
    return send(res,200,layout('Tattoo Request',body));
  }

  if(req.method==='POST' && p==='/request'){
    const buf=await readBody(req); const {fields,files}=parseMultipart(buf, req.headers['content-type']);
    for(const k of ['client_name','phone','idea','placement','size','style']) if(!fields[k]?.trim()) return send(res,400,layout('Missing info',`<div class="card"><h1>Missing information</h1><p>Please fill in ${esc(k)}.</p></div>`));
    const selected=files.filter(f=>f.field==='photos');
    if(selected.length>5)throw new AppError('Choose up to five photos.',400);
    selected.forEach(validateImage);
    const token=crypto.randomBytes(24).toString('hex');
    const uploaded=[];
    // Upload first, then atomically create the client, request and metadata.
    try {
      for(const file of selected)uploaded.push(await storage.upload(file));
      await repo.client.command('intake',{...fields,token,coverup:fields.coverup==='1',files:uploaded});
    } catch(error) {
      // A lost DB response is ambiguous: do not delete photos for a committed request.
      let committed;
      try {committed=await repo.requestByToken(token);}catch {throw error;}
      if(!committed){try{await storage.remove(uploaded);}catch{console.error('Photo cleanup needs reconciliation.');}throw error;}
    }
    return redirect(res,`/r/${token}`);
  }

  if(req.method==='GET' && p.startsWith('/uploads/')){
    if(!isAdmin(req))return send(res,403,'Artist login required.','text/plain');
    return redirect(res,await storage.signed(p.slice('/uploads/'.length)));
  }

  if(req.method==='GET' && /^\/r\/[a-f0-9]+$/.test(p)){
    const token=p.split('/')[2], r=await requestByToken(token); if(!r) return send(res,404,layout('Not found','<div class="card">Request not found.</div>'));
    const slots=await repo.slots(r.id), chosen=slots.find(s=>s.selected);
    const appts=(await repo.appointments(r.id)).filter(a=>a.status!=='cancelled');
    let action='';
    if(r.status==='new') action=`<div class="notice warn">Beau has your request. It has not been quoted or scheduled yet.</div>`;
    if(r.status==='quoted'){
      const consent=await consentFor(r.id);
      const quoteTop=`<div class="notice">Your quote is ready. You only see times Beau approved for this tattoo.</div><div class="card"><div class="grid3"><div class="stat"><div class="k">Estimate</div><div class="v">${esc(r.estimated_hours||'—')}</div></div><div class="stat"><div class="k">Quote</div><div class="v">${money(r.quote_cents)}</div></div><div class="stat"><div class="k">Deposit</div><div class="v">${money(r.deposit_cents)}</div></div></div></div>`;
      if(!consent){
        action=quoteTop+`<div class="card"><h2>Before you pick an appointment</h2><p>Please complete the tattoo consent and cancellation-policy form first.</p><a class="btn primary" href="/r/${token}/consent">Complete consent form</a></div>`;
      } else {
        action=quoteTop+`<div class="notice"><strong>Consent form signed.</strong> You can now choose one of Beau's approved appointment times.</div><form class="card" method="post" action="/r/${token}/book"><h3>Choose an approved appointment</h3>${slots.filter(s=>!s.selected).length?slots.filter(s=>!s.selected).map(s=>`<label class="slot"><input type="radio" name="slot_id" value="${s.id}" required><span><strong>${esc(fmtDateTime(s.start_at)||s.slot_text)}</strong><br><span class="muted">${durationText(s.duration_minutes||180)}</span></span></label>`).join(''):'<p class="muted">No appointment options are available right now.</p>'}${slots.length?'<button class="primary">Choose this appointment</button>':''}</form>`;
      }
    }
    if(r.status==='pending_deposit'){
      const pending=appts.find(a=>a.status==='pending_payment');
      const stripeButton = STRIPE_SECRET_KEY && pending
        ? `<form method="post" action="/r/${token}/pay"><button class="primary">Pay ${money(pending.deposit_due_cents)} deposit securely</button></form>`
        : pending && ALLOW_SIMULATED_PAYMENTS
          ? `<form method="post" action="/r/${token}/simulate-pay"><button class="primary">Simulate deposit payment (local test)</button></form><p class="muted">Stripe is not configured in this local build yet.</p>`
          : '<p>Please contact Beau to arrange the deposit.</p>';
      action=`<div class="notice warn"><strong>Your appointment is being held pending the deposit.</strong></div>${pending?`<div class="card"><h2>Reserved appointment</h2><div class="slot"><span><strong>${esc(fmtDateTime(pending.start_at))}</strong><br><span class="muted">${durationText(pending.duration_minutes)}</span></span></div><h3>Deposit due: ${money(pending.deposit_due_cents)}</h3><p class="muted">This hold expires in <strong id="holdCountdown">calculating…</strong>.</p>${stripeButton}</div><script>(function(){const end=new Date('${esc(pending.reservation_expires_at||'')}').getTime();const el=document.getElementById('holdCountdown');function tick(){const ms=end-Date.now();if(ms<=0){el.textContent='expired';setTimeout(()=>location.reload(),1000);return;}const m=Math.floor(ms/60000),s=Math.floor((ms%60000)/1000);el.textContent=m+'m '+s+'s';setTimeout(tick,1000)}tick()})()</script>`:''}`;
    }
    if(r.status==='booked') action=`<div class="notice"><strong>Booked.</strong> Deposit status: ${(await totalsFor(r.id)).paid >= (r.deposit_cents||0) ? 'paid/recorded' : 'still due'}.</div>${appts.length?`<div class="card"><h2>Your sessions</h2>${appts.filter(a=>a.status!=='cancelled' && a.status!=='expired').map(a=>`<div class="slot"><span><strong>Session ${a.session_number}: ${esc(a.session_type)}</strong><br>${esc(fmtDateTime(a.start_at))} • ${durationText(a.duration_minutes)}${a.notes?`<br><span class="muted">${esc(a.notes)}</span>`:''}</span></div>`).join('')}</div>`:''}<div class="card"><h2>Need to change something?</h2><p class="muted">Send Beau a reschedule or cancellation request. This does not automatically cancel your appointment.</p><form method="post" action="/r/${token}/change-request"><div class="field"><label>Request</label><select name="kind"><option value="reschedule">Reschedule</option><option value="cancel">Cancel appointment</option></select></div><div class="field"><label>Reason / details</label><textarea name="reason" required></textarea></div><div class="field"><label>Preferred new days/times</label><input name="preferred_times" placeholder="Optional"></div><button>Send request</button></form></div>`;
    if(r.status==='completed') action=`<div class="notice">This tattoo project is marked complete.</div>`;
    return send(res,200,layout('Tattoo Request Status',`<div class="top"><div><div class="brand">Beau Merrival Tattoo</div><h1>${esc(r.client_name)}'s tattoo project</h1><div class="muted">Status: ${esc(statusLabel(r.status))}</div></div><span class="pill">${esc(statusLabel(r.status))}</span></div><div class="card"><div class="grid3"><div class="stat"><div class="k">Placement</div><div class="v">${esc(r.placement)}</div></div><div class="stat"><div class="k">Size</div><div class="v">${esc(r.size)}</div></div><div class="stat"><div class="k">Style</div><div class="v">${esc(r.style)}</div></div></div><h3>Tattoo idea</h3><p>${esc(r.idea)}</p></div>${action}`));
  }

  if(req.method==='GET' && /^\/r\/[a-f0-9]+\/consent$/.test(p)){
    const token=p.split('/')[2], r=await requestByToken(token);
    if(!r) return send(res,404,layout('Not found','<div class="card">Project not found.</div>'));
    const existing=await consentFor(r.id);
    if(existing) return send(res,200,layout('Consent already signed',`<div class="top"><div><div class="brand">Beau Merrival Tattoo</div><h1>Consent form complete</h1></div></div><div class="card"><p><strong>${esc(existing.signature_name)}</strong> signed the current consent form on ${esc(existing.signed_at)}.</p><a class="btn primary" href="/r/${token}">Back to booking</a></div>`));
    const body=`<div class="top"><div><div class="brand">Beau Merrival Tattoo</div><h1>Tattoo consent & policy</h1><div class="muted">Complete this before selecting your appointment.</div></div><a class="btn" href="/r/${token}">Back</a></div>
<form class="card" method="post" action="/r/${token}/consent">
<div class="grid"><div class="field"><label>Legal name *</label><input name="legal_name" required></div><div class="field"><label>Date of birth *</label><input name="date_of_birth" type="date" required></div></div>
<div class="grid"><div class="field"><label>Emergency contact</label><input name="emergency_contact_name"></div><div class="field"><label>Emergency contact phone</label><input name="emergency_contact_phone" inputmode="tel"></div></div>
<h2>Consent</h2>
<label class="slot"><input type="checkbox" name="accepted_age" value="1" required><span>I confirm I am legally able to receive this tattoo or will provide any required guardian consent before the appointment.</span></label>
<label class="slot"><input type="checkbox" name="accepted_health" value="1" required><span>I will tell Beau about anything relevant to tattoo safety, healing, medications, allergies, pregnancy, or skin conditions before tattooing begins.</span></label>
<label class="slot"><input type="checkbox" name="accepted_design" value="1" required><span>I understand I will review and approve the final design, spelling, placement, orientation, and size before tattooing starts.</span></label>
<label class="slot"><input type="checkbox" name="accepted_aftercare" value="1" required><span>I understand aftercare affects healing and I agree to follow the aftercare instructions I receive.</span></label>
<label class="slot"><input type="checkbox" name="accepted_cancellation" value="1" required><span>I agree to the cancellation/rescheduling policy: deposits may be non-refundable when the required notice is not provided, subject to Beau's stated policy and applicable law.</span></label>
<h2>Photo permission</h2>
<div class="field"><label>May Beau use finished/healed tattoo photos for portfolio and marketing?</label><select name="photo_release_choice"><option value="no">No</option><option value="yes">Yes</option></select></div>
<label class="slot"><input type="checkbox" name="accepted_photo_release" value="1"><span>I understand the photo-permission choice above is optional and does not affect whether I can book.</span></label>
<h2>Electronic signature</h2>
<div class="field"><label>Type your full legal name to sign *</label><input name="signature_name" required></div>
<p class="muted">By submitting, you confirm the information above is accurate and you intend this typed name to act as your electronic signature. Policy version: ${POLICY_VERSION}.</p>
<button class="primary">Sign consent & continue</button>
</form>`;
    return send(res,200,layout('Tattoo Consent',body));
  }

  if(req.method==='POST' && /^\/r\/[a-f0-9]+\/consent$/.test(p)){
    const token=p.split('/')[2], r=await requestByToken(token);
    if(!r) return send(res,404,layout('Not found','<div class="card">Project not found.</div>'));
    if(await consentFor(r.id)) return redirect(res,`/r/${token}`);
    const f=parseUrlEncoded(await readBody(req));
    if(!consentRequiredFieldsOk(f)) return send(res,400,layout('Consent incomplete',`<div class="card bad"><h1>Please complete all required consent boxes.</h1><a class="btn" href="/r/${token}/consent">Go back</a></div>`));
    await repo.saveConsent(r.id,{...f,policy_version:POLICY_VERSION,ip_hash:clientIpHash(req),user_agent:String(req.headers['user-agent']||'').slice(0,300)});
    return redirect(res,`/r/${token}`);
  }

  if(req.method==='POST' && /^\/r\/[a-f0-9]+\/book$/.test(p)){
    const token=p.split('/')[2], r=await requestByToken(token); if(!r || r.status!=='quoted') return send(res,400,layout('Cannot book','<div class="card">This request is not ready to book.</div>'));
    if(!await consentFor(r.id)) return send(res,403,layout('Consent required',`<div class="card"><h1>Consent form required</h1><p>Please sign the tattoo consent form before selecting an appointment.</p><a class="btn primary" href="/r/${token}/consent">Complete consent form</a></div>`));
    const f=parseUrlEncoded(await readBody(req)); const slot=await repo.slot(f.slot_id,r.id);
    if(!slot || !slot.start_at) return send(res,400,layout('Invalid slot','<div class="card">Choose a valid appointment.</div>'));
    const conflict=await conflictFor(slot.start_at,slot.duration_minutes||180);
    if(conflict) return send(res,409,layout('Time just became unavailable',`<div class="card"><h1>That time was just taken.</h1><p>Please go back and choose another approved time.</p></div>`));
    const booked=await repo.book(r.id,slot.id,RESERVATION_HOLD_MINUTES);
    if(booked.confirmed)await queueBookingMessages(r.id,booked.id);
    return redirect(res,`/r/${token}`);
  }

  if(req.method==='POST' && /^\/r\/[a-f0-9]+\/pay$/.test(p)){
    const token=p.split('/')[2], r=await requestByToken(token);
    if(!r || r.status!=='pending_deposit') return send(res,400,layout('Cannot pay','<div class="card">This project is not waiting for a deposit.</div>'));
    const a=await repo.pending(r.id);
    if(!a) return send(res,400,layout('No reservation','<div class="card">No pending appointment reservation was found.</div>'));
    if(!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) return send(res,400,layout('Payment unavailable','<div class="card"><h1>Online payment is unavailable.</h1><p>Please contact Beau to arrange your deposit.</p></div>'));
    const session=await createStripeCheckout({requestRow:r,appointmentRow:a});
    await repo.checkout(r.id,a.id,session.id);
    return redirect(res,session.url);
  }

  if(req.method==='POST' && /^\/r\/[a-f0-9]+\/simulate-pay$/.test(p)){
    const token=p.split('/')[2], r=await requestByToken(token);
    if(!r || r.status!=='pending_deposit' || STRIPE_SECRET_KEY || !ALLOW_SIMULATED_PAYMENTS) return send(res,400,layout('Unavailable','<div class="card">Local payment simulation is only available when Stripe is not configured.</div>'));
    const a=await repo.pending(r.id);
    if(!a) return send(res,400,layout('No reservation','<div class="card">No pending appointment reservation was found.</div>'));
    await finalizeDeposit(r.id,a.id,`simulation-${a.id}`,a.deposit_due_cents,'simulated_deposit');
    return redirect(res,`/r/${token}`);
  }

  if(req.method==='POST' && p==='/stripe/webhook'){
    const raw=await readBody(req,2*1024*1024);
    if(!verifyStripeWebhook(raw,req.headers['stripe-signature'])) return send(res,400,'Invalid signature','text/plain');
    let event;
    try{ event=JSON.parse(raw.toString('utf8')); }catch{ return send(res,400,'Invalid JSON','text/plain'); }
    if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)){
      const obj=event.data?.object||{};
      if(obj.metadata?.workspace_id!==repo.workspace)return send(res,200,'ignored','text/plain');
      if(obj.payment_status!=='paid')return send(res,200,'ignored','text/plain');
      if(obj.currency!=='usd'||!obj.metadata?.request_id||!obj.metadata?.appointment_id||!obj.id)return send(res,400,'Invalid payment metadata','text/plain');
      await finalizeDeposit(obj.metadata.request_id,obj.metadata.appointment_id,obj.id,obj.amount_total);
    }
    return send(res,200,'ok','text/plain');
  }

  if(req.method==='POST' && /^\/r\/[a-f0-9]+\/change-request$/.test(p)){
    const token=p.split('/')[2], r=await requestByToken(token);
    if(!r || r.status!=='booked') return send(res,400,layout('Unavailable','<div class="card">This project is not currently booked.</div>'));
    const f=parseUrlEncoded(await readBody(req));
    const kind=['reschedule','cancel'].includes(f.kind)?f.kind:'reschedule';
    const appt=await repo.scheduled(r.id);
    await repo.change(r.id,kind,(f.reason||'').trim(),(f.preferred_times||'').trim());
    if(r.phone){
      await queueNotification({
        requestId:r.id,appointmentId:appt?.id||null,kind:`client_${kind}_request`,
        recipient:r.phone,
        message:`Your ${kind} request was received. Beau will review it before anything changes to your appointment.`,
        sendAfter:new Date().toISOString()
      });
    }
    return send(res,200,layout('Request received',`<div class="top"><div><div class="brand">Beau Merrival Tattoo</div><h1>Request received</h1></div></div><div class="card"><p>Your ${esc(kind)} request was sent to Beau. Your current appointment stays in place until Beau confirms a change.</p><a class="btn primary" href="/r/${token}">Back to project</a></div>`));
  }

  if(req.method==='GET' && p==='/admin'){
    if(isAdmin(req)) return redirect(res,'/admin/dashboard');
    return send(res,200,layout('Artist Login',`<div class="top"><div><div class="brand">Beau Merrival Tattoo</div><h1>Artist login</h1></div></div><form class="card" method="post" action="/admin/login"><div class="field"><label>Password</label><input name="password" type="password" required></div><button class="primary">Log in</button><p class="muted">Private beta login. Change ADMIN_PASSWORD before real use.</p></form>`));
  }
  if(req.method==='POST' && p==='/admin/login'){
    const f=parseUrlEncoded(await readBody(req)); if(!passwordMatches(f.password)) return send(res,401,layout('Wrong password','<div class="card"><h1>Wrong password</h1><a class="btn" href="/admin">Try again</a></div>'));
    const sid=crypto.randomBytes(24).toString('hex'); sessions.set(sid,Date.now());
    const secure = NODE_ENV==='production' ? '; Secure' : '';
    res.writeHead(302,{Location:'/admin/dashboard','Set-Cookie':`sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}`}); return res.end();
  }
  if(req.method==='POST' && p==='/admin/logout'){
    const sid=parseCookies(req).sid; if(sid)sessions.delete(sid); res.writeHead(302,{Location:'/admin','Set-Cookie':'sid=; Max-Age=0; Path=/'}); return res.end();
  }
  if(p.startsWith('/admin/') && !isAdmin(req)) return redirect(res,'/admin');

  if(req.method==='GET' && p==='/admin/dashboard'){
    const rows=await repo.requests();
    const counts={new:0,quoted:0,pending_deposit:0,booked:0,completed:0}; rows.forEach(r=>{if(counts[r.status]!=null)counts[r.status]++});
    const openChanges=(await repo.changes()).length;
    const upcoming=(await repo.activeAppointments()).filter(a=>new Date(a.start_at)>=new Date()).slice(0,6);
    const cards=rows.length?rows.map(r=>`<a class="card request status-${esc(r.status)}" href="/admin/request/${r.id}"><div class="row"><div><strong>${esc(r.client_name)}</strong><div class="muted">${esc(r.placement)} • ${esc(r.size)} • ${esc(r.style)}</div></div><span class="pill">${esc(statusLabel(r.status))}</span></div><p>${esc(r.idea.slice(0,160))}${r.idea.length>160?'…':''}</p></a>`).join(''):'<div class="card"><p>No tattoo requests yet.</p></div>';
    const upcomingHtml=upcoming.length?upcoming.map(a=>`<a class="card request appt" href="/admin/request/${a.request_id}"><div class="row"><strong>${esc(a.client_name)}</strong><span class="pill">Session ${a.session_number}</span></div><div>${esc(fmtDateTime(a.start_at))}</div><div class="muted">${durationText(a.duration_minutes)} • ${esc(a.placement)}</div></a>`).join(''):'<div class="card"><p class="muted">No upcoming sessions.</p></div>';
    return send(res,200,layout('Artist Dashboard',`<div class="top"><div><div class="brand">Beau Merrival Tattoo</div><h1>Artist dashboard</h1><div class="muted">Requests → quotes → approved times → booked projects.</div></div><div class="nav"><a class="btn" href="/admin/calendar">Calendar</a><a class="btn" href="/admin/messages">Messages</a><a class="btn" href="/" target="_blank">Client form</a><form method="post" action="/admin/logout"><button>Log out</button></form></div></div><div class="grid4"><div class="stat"><div class="k">New</div><div class="money">${counts.new}</div></div><div class="stat"><div class="k">Quoted</div><div class="money">${counts.quoted}</div></div><div class="stat"><div class="k">Deposit pending</div><div class="money">${counts.pending_deposit}</div></div><div class="stat"><div class="k">Booked</div><div class="money">${counts.booked}</div></div></div>${openChanges?`<div class="notice warn"><strong>${openChanges} client change request${openChanges===1?'':'s'} waiting for review.</strong> Open the related project to see details.</div>`:''}<h2>Upcoming sessions</h2>${upcomingHtml}<h2>Projects & requests</h2>${cards}`));
  }

  if(req.method==='GET' && p==='/admin/messages'){
    const rows=await repo.notifications();
    const providerReady=SMS_PROVIDER==='twilio' && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER;
    const cards=rows.length?rows.map(n=>`<div class="card"><div class="row"><div><strong>${esc(n.client_name)}</strong><div class="muted">${esc(n.kind)} • ${esc(n.recipient)}</div></div><span class="pill">${esc(n.status)}</span></div><p>${esc(n.message)}</p><div class="muted">Send after: ${esc(fmtDateTime(n.send_after))}${n.sent_at?` • Sent: ${esc(n.sent_at)}`:''}${n.last_error?`<br>${esc(n.last_error)}`:''}</div>${n.status==='queued'?`<form method="post" action="/admin/message/${n.id}/send-now"><button style="margin-top:10px">Send / process now</button></form>`:''}</div>`).join(''):'<div class="card"><p>No confirmation or reminder messages queued yet.</p></div>';
    return send(res,200,layout('Messages',`<div class="top"><div><div class="brand">Beau Merrival Tattoo</div><h1>Confirmations & reminders</h1><div class="muted">${providerReady?'Automatic SMS is connected.':'SMS provider is not connected yet. Messages will queue here so nothing is lost.'}</div></div><div class="nav"><a class="btn" href="/admin/dashboard">← Dashboard</a></div></div><div class="card"><div class="grid3"><div class="stat"><div class="k">Provider</div><div class="v">${providerReady?'Twilio connected':'Not connected'}</div></div><div class="stat"><div class="k">Hold length</div><div class="v">${RESERVATION_HOLD_MINUTES} min</div></div><div class="stat"><div class="k">Reminders</div><div class="v">${REMINDER_1_HOURS}h + ${REMINDER_2_HOURS}h</div></div></div></div>${cards}`));
  }

  if(req.method==='POST' && /^\/admin\/message\/[0-9a-f-]{36}\/send-now$/.test(p)){
    const id=p.split('/')[3];
    const n=await repo.notification(id);
    if(!n) return send(res,404,layout('Not found','<div class="card">Message not found.</div>'));
    await repo.notificationNow(id);
    await processNotificationOutbox();
    return redirect(res,'/admin/messages');
  }

  if(req.method==='GET' && p==='/admin/calendar'){
    const appts=await repo.activeAppointments();
    const groups={};
    for(const a of appts){ const key=(a.start_at||'').slice(0,10); (groups[key] ||= []).push(a); }
    let body='<div class="card"><p>No scheduled appointments yet.</p></div>';
    if(Object.keys(groups).length){
      body='';
      for(const [day,items] of Object.entries(groups)){
        const dayTitle=esc(new Intl.DateTimeFormat('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'}).format(new Date(day+'T12:00:00')));
        let itemHtml='';
        for(const a of items){
          const notesHtml=a.notes ? '<div class="muted">'+esc(a.notes)+'</div>' : '';
          itemHtml += '<a class="card request appt" href="/admin/request/'+a.request_id+'"><div class="row"><div><strong>'+esc(a.client_name)+'</strong><div class="muted">'+esc(a.session_type)+' • Session '+a.session_number+'</div></div><span class="pill">'+durationText(a.duration_minutes)+'</span></div><p>'+esc(fmtDateTime(a.start_at))+' • '+esc(a.placement)+'</p>'+notesHtml+'</a>';
        }
        body += '<div class="calendar-day"><h2>'+dayTitle+'</h2>'+itemHtml+'</div>';
      }
    }
    return send(res,200,layout('Calendar',`<div class="top"><div><div class="brand">Beau Merrival Tattoo</div><h1>Calendar</h1><div class="muted">Every booked session in one place. Conflicts are blocked automatically.</div></div><div class="nav"><a class="btn" href="/admin/dashboard">← Dashboard</a><a class="btn" href="/admin/messages">Messages</a></div></div>${body}`));
  }

  if(req.method==='GET' && /^\/admin\/request\/[0-9a-f-]{36}$/.test(p)){
    const id=p.split('/').pop(), r=await repo.request(id); if(!r)return send(res,404,layout('Not found','<div class="card">Project not found.</div>'));
    const photos=await repo.photos(id);
    const slots=await repo.slots(id);
    const appts=await repo.appointments(id);
    const payments=await repo.payments(id);
    const consent=await consentFor(id);
    const changes=await repo.changes(id);
    const totals=await totalsFor(id);
    const nextSession=(appts.filter(a=>a.status==='scheduled' && new Date(a.start_at)>=new Date())[0])||null;
    const photoHtml=photos.length?`<div class="photos">${photos.map(ph=>`<a class="photo" href="/uploads/${encodeURIComponent(ph.id)}" target="_blank"><img src="/uploads/${encodeURIComponent(ph.id)}" alt="Reference"></a>`).join('')}</div>`:'<p class="muted">No reference photos.</p>';
    const slotCards=slots.length?slots.map(s=>`<div class="slot"><span>${s.selected?'✓ ':''}<strong>${esc(fmtDateTime(s.start_at)||s.slot_text)}</strong><br><span class="muted">${durationText(s.duration_minutes||180)}</span></span></div>`).join(''):'<p class="muted">No appointment options yet.</p>';
    const apptCards=appts.length?appts.map(a=>`<div class="card appt"><div class="row"><div><strong>Session ${a.session_number}: ${esc(a.session_type)}</strong><div class="muted">${esc(fmtDateTime(a.start_at))} • ${durationText(a.duration_minutes)}</div></div><span class="pill">${esc(a.status)}</span></div>${a.notes?`<p>${esc(a.notes)}</p>`:''}${a.status==='scheduled'?`<form method="post" action="/admin/appointment/${a.id}/cancel"><button class="danger">Cancel session</button></form>`:''}</div>`).join(''):'<p class="muted">No sessions yet.</p>';
    const paymentHtml=payments.length?payments.map(x=>`<div class="slot"><span><strong>${money(x.amount_cents)}</strong> • ${esc(x.note||x.kind)}<br><span class="muted">${esc(x.created_at)}</span></span></div>`).join(''):'<p class="muted">No payments recorded.</p>';
    const currentSlots=slots.filter(s=>!s.selected).slice(0,3);
    const slotInputs=[0,1,2].map(i=>`<div class="grid"><div class="field"><label>Option ${i+1} date & time</label><input name="slot_start_${i+1}" type="datetime-local" value=""></div><div class="field"><label>Length</label><select name="slot_duration_${i+1}"><option value="120">2 hours</option><option value="180">3 hours</option><option value="240">4 hours</option><option value="300">5 hours</option><option value="360" selected>6 hours</option><option value="480">8 hours</option><option value="720">12 hours</option></select></div></div>`).join('');
    return send(res,200,layout(`Project ${id}`,`<div class="top"><div><div class="brand">Project #${id}</div><h1>${esc(r.client_name)}</h1><div class="muted">${esc(r.phone)}${r.email?' • '+esc(r.email):''}</div></div><div class="nav"><a class="btn" href="/admin/dashboard">← Dashboard</a><a class="btn" href="/admin/calendar">Calendar</a><a class="btn" href="/admin/messages">Messages</a><a class="btn" target="_blank" href="/r/${r.public_token}">Client view</a></div></div>
<div class="split"><main>
<div class="card"><div class="row"><h2 style="margin:0">Tattoo project</h2><span class="pill">${esc(statusLabel(r.status))}</span></div><div class="grid3"><div class="stat"><div class="k">Placement</div><div class="v">${esc(r.placement)}</div></div><div class="stat"><div class="k">Size</div><div class="v">${esc(r.size)}</div></div><div class="stat"><div class="k">Style</div><div class="v">${esc(r.style)}${r.coverup?' • Cover-up':''}</div></div></div><h3>What they want</h3><p>${esc(r.idea)}</p>${r.notes?`<h3>Client notes</h3><p>${esc(r.notes)}</p>`:''}<h3>Reference photos</h3>${photoHtml}</div>
<form class="card" method="post" action="/admin/request/${id}/quote"><h2>Quote & offer times</h2><div class="grid3"><div class="field"><label>Estimated hours</label><input name="estimated_hours" value="${esc(r.estimated_hours||'')}" placeholder="4–6" required></div><div class="field"><label>Quote ($)</label><input name="quote" type="number" min="0" value="${r.quote_cents!=null?r.quote_cents/100:''}" required></div><div class="field"><label>Deposit ($)</label><input name="deposit" type="number" min="0" value="${r.deposit_cents!=null?r.deposit_cents/100:''}" required></div></div><p class="muted">Pick up to three times for this client. The app checks your real booked sessions before offering them.</p>${slotInputs}<div class="field"><label>Private artist notes</label><textarea name="artist_notes">${esc(r.artist_notes||'')}</textarea></div><button class="primary">Save quote & approved times</button></form>
<div class="card"><h2>Approved booking options</h2>${slotCards}</div>
<div class="card"><div class="row"><h2>Sessions</h2><span class="pill">${appts.length}</span></div>${apptCards}<h3>Add another session</h3><form method="post" action="/admin/request/${id}/appointment"><div class="grid"><div class="field"><label>Date & time</label><input name="start_at" type="datetime-local" required></div><div class="field"><label>Length</label><select name="duration"><option value="120">2 hours</option><option value="180">3 hours</option><option value="240">4 hours</option><option value="300">5 hours</option><option value="360">6 hours</option><option value="480">8 hours</option><option value="720">12 hours</option></select></div></div><div class="field"><label>Session type</label><input name="session_type" value="Tattoo session"></div><div class="field"><label>Session notes</label><input name="notes" placeholder="Finish portrait, background, touch-up..."></div><button>Add session</button></form></div>
</main><aside>
<div class="card"><h2>At a glance</h2><div class="stat"><div class="k">Next session</div><div class="v">${nextSession?esc(fmtDateTime(nextSession.start_at)):'None scheduled'}</div></div></div>
<div class="card"><h2>Money tracker</h2><div class="grid"><div class="stat"><div class="k">Quoted</div><div class="money">${money(r.quote_cents)}</div></div><div class="stat"><div class="k">Deposit</div><div class="money">${money(r.deposit_cents)}</div></div><div class="stat"><div class="k">Paid</div><div class="money">${money(totals.paid)}</div></div><div class="stat"><div class="k">Remaining</div><div class="money">${money(totals.remaining)}</div></div></div><form style="margin-top:12px" method="post" action="/admin/request/${id}/payment"><div class="field"><label>Record payment ($)</label><input name="amount" type="number" min="1" required></div><div class="field"><label>Note</label><input name="note" placeholder="Cash App deposit, cash, Venmo..."></div><button>Record payment</button></form><h3>Payment history</h3>${paymentHtml}</div>
<div class="card"><h2>Consent & policies</h2>${consent?`<div class="notice"><strong>Signed</strong><br><span class="muted">${esc(consent.signature_name)} • ${esc(consent.signed_at)} • Policy ${esc(consent.policy_version)}</span></div><div class="stat"><div class="k">Photo permission</div><div class="v">${esc(consent.photo_release_choice)}</div></div>`:`<div class="notice warn">Consent form not signed yet.</div>`}</div>
<div class="card"><h2>Client change requests</h2>${changes.length?changes.map(c=>`<div class="slot"><span><strong>${esc(c.kind)}</strong> • ${esc(c.status)}<br>${esc(c.reason||'')}${c.preferred_times?`<br><span class="muted">Preferred: ${esc(c.preferred_times)}</span>`:''}</span></div>`).join(''):'<p class="muted">No change requests.</p>'}</div>
<div class="card"><h2>Project controls</h2><form method="post" action="/admin/request/${id}/status"><p class="muted">Booking and deposit status update automatically. Cancel active sessions before reopening a quote.</p><select name="status"><option value="quoted">Reopen quote</option><option value="completed" ${r.status==='completed'?'selected':''}>Completed</option></select><button style="margin-top:10px">Update status</button></form></div>
<div class="card"><h2>Private notes</h2><p class="muted">${esc(r.artist_notes||'No private notes yet.')}</p></div>
</aside></div>`));
  }

  if(req.method==='POST' && /^\/admin\/request\/[0-9a-f-]{36}\/quote$/.test(p)){
    const id=p.split('/')[3], f=parseUrlEncoded(await readBody(req));
    const quote=Math.round(Number(f.quote||0)*100), deposit=Math.round(Number(f.deposit||0)*100);
    if(!Number.isSafeInteger(quote)||!Number.isSafeInteger(deposit)||quote<0||deposit<0||deposit>quote||quote>2147483647)throw new AppError('Enter a valid quote and a deposit no greater than the quote.',400);
    const offered=[];
    for(let i=1;i<=3;i++){
      const start=isoLocal(f[`slot_start_${i}`]); if(!start) continue;
      const duration=Math.max(60,Number(f[`slot_duration_${i}`]||180));
      const conflict=await conflictFor(start,duration);
      if(conflict) return send(res,409,layout('Calendar conflict',`<div class="card bad"><h1>That time conflicts with ${esc(conflict.client_name)}.</h1><p>${esc(fmtDateTime(conflict.start_at))} for ${durationText(conflict.duration_minutes)} is already booked.</p><a class="btn" href="/admin/request/${id}">Go back</a></div>`));
      offered.push({start,duration});
    }
    await repo.quote(id,(f.estimated_hours||'').trim(),quote,deposit,(f.artist_notes||'').trim(),offered);
    return redirect(res,`/admin/request/${id}`);
  }

  if(req.method==='POST' && /^\/admin\/request\/[0-9a-f-]{36}\/appointment$/.test(p)){
    const id=p.split('/')[3], f=parseUrlEncoded(await readBody(req)), start=isoLocal(f.start_at), duration=Math.max(60,Number(f.duration||180));
    if(!start) return send(res,400,layout('Bad time','<div class="card">Choose a valid date and time.</div>'));
    const conflict=await conflictFor(start,duration);
    if(conflict) return send(res,409,layout('Calendar conflict',`<div class="card bad"><h1>That overlaps another appointment.</h1><p>${esc(conflict.client_name)} is booked ${esc(fmtDateTime(conflict.start_at))} for ${durationText(conflict.duration_minutes)}.</p><a class="btn" href="/admin/request/${id}">Go back</a></div>`));
    const added=await repo.addSession(id,start,duration,(f.session_type||'Tattoo session').trim(),(f.notes||'').trim());
    if(added.confirmed)await queueBookingMessages(id,added.id);
    return redirect(res,`/admin/request/${id}`);
  }

  if(req.method==='POST' && /^\/admin\/appointment\/[0-9a-f-]{36}\/cancel$/.test(p)){
    const aid=p.split('/')[3], a=await repo.appointment(aid);
    if(!a) return send(res,404,layout('Not found','<div class="card">Appointment not found.</div>'));
    await repo.cancel(a.request_id,aid);
    return redirect(res,`/admin/request/${a.request_id}`);
  }

  if(req.method==='POST' && /^\/admin\/request\/[0-9a-f-]{36}\/payment$/.test(p)){
    const id=p.split('/')[3], f=parseUrlEncoded(await readBody(req)), cents=Math.round(Number(f.amount||0)*100);
    if(!Number.isSafeInteger(cents)||cents<=0||cents>2147483647)throw new AppError('Enter a valid positive payment amount.',400);
    const result=await repo.manualPayment(id,cents,(f.note||'').trim());
    if(result.confirmed)await queueBookingMessages(id,result.id);
    return redirect(res,`/admin/request/${id}`);
  }
  if(req.method==='POST' && /^\/admin\/request\/[0-9a-f-]{36}\/status$/.test(p)){
    const id=p.split('/')[3], f=parseUrlEncoded(await readBody(req));
    await repo.status(id,f.status);
    return redirect(res,`/admin/request/${id}`);
  }


  return send(res,404,layout('Not found','<div class="card"><h1>Not found</h1></div>'));
}

const server=http.createServer((req,res)=>{router(req,res).catch(e=>{
  console.error('Request failed:', e instanceof AppError ? e.status : 500);
  if(!res.headersSent)send(res,e instanceof AppError?e.status:500,layout('Unable to complete request',`<div class="card"><h1>Unable to complete request</h1><p>${esc(e instanceof AppError?e.message:'Please try again or contact the artist.')}</p></div>`));else res.end();
});});
if(require.main===module){
server.listen(PORT,HOST,()=>{
  console.log(`Ink Flow v6 running at http://${HOST}:${PORT}`);
  console.log(`Database: ${repo.configured?'configured':'unconfigured'}`);
  console.log(`Reservation hold: ${RESERVATION_HOLD_MINUTES} minutes`);
  console.log(`SMS provider: ${SMS_PROVIDER || 'not configured'}`);
});
setInterval(()=>{processNotificationOutbox().catch(()=>console.error('Background processing failed.'))},60000).unref();
processNotificationOutbox().catch(()=>console.error('Background processing failed.'));
}
module.exports={server,router,repo,storage,processNotificationOutbox,verifyStripeWebhook};
