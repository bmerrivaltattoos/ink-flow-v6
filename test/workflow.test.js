const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {harness}=require('./harness');
const {Supabase}=require('../lib/supabase');
const {Repository,Storage}=require('../lib/repository');
test('v6 PostgreSQL migrations and HTTP workflow',async t=>{
  const h=await harness();
  process.env.SUPABASE_URL='https://test.supabase.co';
  process.env.SUPABASE_SECRET_KEY='sb_secret_test_placeholder';
  process.env.WORKSPACE_ID=h.workspace;
  process.env.ADMIN_PASSWORD='test-password-at-least-16';
  process.env.ALLOW_SIMULATED_PAYMENTS='true';
  process.env.STRIPE_WEBHOOK_SECRET='webhook-test-placeholder';
  const app=require('../server');app.repo.client.transport=h.transport;
  const repo=app.repo;
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await new Promise(r=>app.server.close(r));await h.db.close();});
  let cookie='',id,token,slot,appointment;
  const post=(route,data,admin=false)=>fetch(base+route,{method:'POST',body:new URLSearchParams(data),headers:admin?{Cookie:cookie}:{},redirect:'manual'});
  const get=(route,admin=false)=>fetch(base+route,{headers:admin?{Cookie:cookie}:{},redirect:'manual'});
  const day=(n)=>new Date(Date.now()+n*86400000).toISOString();
  const consent={legal_name:'Test Client',date_of_birth:'1990-01-01',signature_name:'Test Client',accepted_age:'1',accepted_health:'1',accepted_design:'1',accepted_aftercare:'1',accepted_cancellation:'1',photo_release_choice:'yes'};
  async function newRequest(name='Second Client'){
    const token=crypto.randomBytes(24).toString('hex');
    return repo.client.command('intake',{client_name:name,phone:'5550100',idea:'Test',placement:'Arm',size:'Palm',style:'Black & Grey',token,files:[]});
  }
  await t.test('health contains configuration only and login works',async()=>{
    const health=await (await get('/health')).json();assert.equal(health.version,'6.0.0-beta.1');assert.equal(health.database,'configured');
    assert(!JSON.stringify(health).includes(process.env.SUPABASE_SECRET_KEY));
    assert.equal((await get('/admin/dashboard')).status,302);
    const login=await post('/admin/login',{password:process.env.ADMIN_PASSWORD});assert.equal(login.status,302);cookie=login.headers.get('set-cookie').split(';')[0];
  });
  await t.test('intake uploads private image and creates scoped metadata',async()=>{
    const form=new FormData();for(const [k,v]of Object.entries({client_name:'Test Client',phone:'5550100',idea:'A heron',placement:'Forearm',size:'Palm',style:'Black & Grey'}))form.set(k,v);
    form.set('photos',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2xkAAAAASUVORK5CYII=','base64')],{type:'image/png'}),'reference.png');
    const result=await fetch(base+'/request',{method:'POST',body:form,redirect:'manual'});assert.equal(result.status,302);
    token=result.headers.get('location').split('/').pop();id=(await repo.requestByToken(token)).id;
    const photos=await repo.photos(id);assert.equal(photos.length,1);assert(photos[0].storage_path.startsWith(h.workspace+'/'));assert.equal(h.objects.size,1);
    assert.equal((await get('/uploads/'+photos[0].id)).status,403);
    const photo=await get('/uploads/'+photos[0].id,true);assert.equal(photo.status,302);assert(photo.headers.get('location').includes('/storage/v1/object/sign/'));
    assert.equal((await get('/uploads/'+crypto.randomUUID(),true)).status,404);
  });
  await t.test('quote and consent are required before approved slot booking',async()=>{
    assert.equal((await post(`/r/${token}/book`,{slot_id:crypto.randomUUID()})).status,400);
    const quote=await post(`/admin/request/${id}/quote`,{estimated_hours:'4–6',quote:'600',deposit:'100',slot_start_1:day(7),slot_duration_1:'180',artist_notes:'PRIVATE'},true);assert.equal(quote.status,302);
    slot=(await repo.slots(id))[0];assert.equal((await post(`/r/${token}/book`,{slot_id:slot.id})).status,403);
    assert.equal((await post(`/r/${token}/consent`,consent)).status,302);
    assert.equal((await repo.consent(id)).photo_release_choice,'yes');
    assert.equal((await post(`/r/${token}/book`,{slot_id:slot.id})).status,302);
    appointment=await repo.pending(id);assert.equal(appointment.deposit_due_cents,10000);assert.equal((await repo.request(id)).status,'pending_deposit');
    assert(!(await (await get(`/r/${token}`)).text()).includes('PRIVATE'));
    assert.equal((await post(`/r/${token}/book`,{slot_id:slot.id})).status,400);
  });
  await t.test('payment return checks persisted status and cannot confirm a booking',async()=>{
    const response=await get(`/r/${token}?paid=1`);
    const page=await response.text();
    assert(page.includes('Checking your payment confirmation'));
    assert(page.includes(`/r/${token}/status`));
    const status=await get(`/r/${token}/status`);
    assert.equal(status.headers.get('cache-control'),'no-store');
    assert.deepEqual(await status.json(),{status:'pending_deposit'});
    assert.equal((await repo.payments(id)).length,0);
    assert.equal((await get(`/r/${'a'.repeat(48)}/status`)).status,404);
  });
  await t.test('deposit confirms once and queues confirmation/reminders',async()=>{
    assert.equal((await post(`/r/${token}/simulate-pay`,{})).status,302);
    assert.equal((await repo.request(id)).status,'booked');
    assert.deepEqual(await (await get(`/r/${token}/status`)).json(),{status:'booked'});
    assert.equal((await repo.totals(id)).paid,10000);
    await repo.deposit(id,appointment.id,`simulation-${appointment.id}`,10000,'simulated_deposit');
    assert.equal((await repo.payments(id)).length,1);
    await app.processNotificationOutbox();await app.processNotificationOutbox();
    assert.equal((await repo.notifications()).length,3);assert((await repo.notifications()).every(n=>n.status==='queued'));
  });
  await t.test('multi-session projects, manual payments and change requests',async()=>{
    assert.equal((await post(`/admin/request/${id}/appointment`,{start_at:day(14),duration:180,session_type:'Finish heron',notes:'Bring reference'},true)).status,302);
    assert.equal((await repo.appointments(id)).length,2);
    assert((await repo.appointments(id)).every(a=>a.project_id===appointment.project_id));
    assert.equal((await post(`/admin/request/${id}/payment`,{amount:'125.50',note:'Cash'},true)).status,302);
    assert.equal((await repo.totals(id)).paid,22550);
    assert.equal((await post(`/r/${token}/change-request`,{kind:'reschedule',reason:'Work',preferred_times:'Next Friday'})).status,200);
    assert.equal((await repo.changes(id))[0].preferred_times,'Next Friday');
    assert.equal((await repo.appointment(appointment.id)).status,'scheduled');
    for(const route of ['/admin/dashboard','/admin/calendar','/admin/messages',`/admin/request/${id}`,`/r/${token}`]){
      const response=await get(route,true);assert.equal(response.status,200,route);assert(!(await response.text()).includes('[object Promise]'));
    }
  });
  await t.test('workspace isolation, calendar conflicts, and transaction rollback',async()=>{
    const other=new Repository(new Supabase({...process.env,WORKSPACE_ID:h.other},h.transport));
    assert.equal(await other.request(id),undefined);
    await assert.rejects(other.manualPayment(id,1000,'wrong tenant'));
    await assert.rejects(new Storage(other.client).signed((await repo.photos(id))[0].id));
    const second=await newRequest();await assert.rejects(repo.quote(second.id,'3',20000,0,'',[{start:appointment.start_at,duration:180}]));
    assert.equal((await repo.request(second.id)).status,'new');
    assert.equal((await repo.payments(id)).length,2);
  });
  await t.test('expired hold releases slot; late Stripe payment cannot resurrect it',async()=>{
    const second=await newRequest();await repo.quote(second.id,'3',20000,5000,'',[{start:day(21),duration:180}]);
    await repo.saveConsent(second.id,{...consent,policy_version:'test'});
    const option=(await repo.slots(second.id))[0];const booked=await repo.book(second.id,option.id,5);
    await repo.checkout(second.id,booked.id,'cs_test_expired');
    await h.db.query("update appointments set reservation_expires_at=now()-interval '1 second' where id=$1",[booked.id]);
    assert.equal(await repo.expire(),1);assert.equal((await repo.appointment(booked.id)).status,'expired');
    assert.equal((await repo.slots(second.id))[0].status,'available');
    const late=await repo.deposit(second.id,booked.id,'cs_test_expired',5000,'stripe_deposit');assert.equal(late.confirmed,false);
    assert((await repo.payments(second.id))[0].requires_review);assert.equal((await repo.totals(second.id)).paid,0);
  });
  await t.test('manual deposit confirms a hold and zero-deposit booking confirms immediately',async()=>{
    for(const deposit of [0,5000]){
      const r=await newRequest();await repo.quote(r.id,'2',20000,deposit,'',[{start:day(deposit?35:28),duration:120}]);await repo.saveConsent(r.id,{...consent,policy_version:'test'});
      const b=await repo.book(r.id,(await repo.slots(r.id))[0].id,5);
      assert.equal(b.confirmed,deposit===0);
      if(deposit){assert.equal((await repo.manualPayment(r.id,2500,'partial')).confirmed,false);assert.equal((await repo.manualPayment(r.id,2500,'rest')).confirmed,true);}
      assert.equal((await repo.request(r.id)).status,'booked');
    }
  });
  await t.test('notification claiming is exclusive and records delivery failure',async()=>{
    const claims=await repo.claimNotifications();assert(claims.length>0);assert.equal((await repo.claimNotifications()).length,0);
    await repo.notificationResult(claims[0].id,true,'SM_test');assert.equal((await repo.notification(claims[0].id)).status,'sent');
    if(claims[1]){await repo.notificationResult(claims[1].id,false,null);assert.equal((await repo.notification(claims[1].id)).status,'failed');}
  });
  await t.test('webhook signatures and paid amounts are checked',async()=>{
    assert.equal((await post('/stripe/webhook',{})).status,400);
    const raw=Buffer.from('{}'),time=Math.floor(Date.now()/1000);
    const sig=crypto.createHmac('sha256',process.env.STRIPE_WEBHOOK_SECRET).update(`${time}.`).update(raw).digest('hex');
    assert(app.verifyStripeWebhook(raw,`t=${time},v1=${sig}`));assert(!app.verifyStripeWebhook(Buffer.from('{"changed":true}'),`t=${time},v1=${sig}`));
    await assert.rejects(repo.deposit(id,appointment.id,'wrong-amount',1,'stripe_deposit'));
  });
  await t.test('signed paid Stripe callback confirms once; unpaid callback does not confirm',async()=>{
    const r=await newRequest();await repo.quote(r.id,'2',20000,6000,'',[{start:day(42),duration:120}]);await repo.saveConsent(r.id,{...consent,policy_version:'test'});
    const b=await repo.book(r.id,(await repo.slots(r.id))[0].id,5);await repo.checkout(r.id,b.id,'cs_test_success');
    async function callback(payment_status,amount_total=6000){
      const raw=JSON.stringify({type:'checkout.session.completed',data:{object:{id:'cs_test_success',currency:'usd',payment_status,amount_total,metadata:{workspace_id:h.workspace,request_id:r.id,appointment_id:b.id}}}});
      const time=Math.floor(Date.now()/1000),sig=crypto.createHmac('sha256',process.env.STRIPE_WEBHOOK_SECRET).update(`${time}.${raw}`).digest('hex');
      return fetch(base+'/stripe/webhook',{method:'POST',body:raw,headers:{'stripe-signature':`t=${time},v1=${sig}`}});
    }
    assert.equal((await callback('unpaid')).status,200);assert.equal((await repo.request(r.id)).status,'pending_deposit');
    assert.equal((await callback('paid',1)).status,409);assert.equal((await repo.payments(r.id)).length,0);
    assert.equal((await callback('paid')).status,200);assert.equal((await callback('paid')).status,200);
    assert.equal((await repo.payments(r.id)).length,1);assert.equal((await repo.request(r.id)).status,'booked');
  });
  await t.test('cancel and complete operations preserve calendar and payment rules',async()=>{
    const sessions=await repo.appointments(id);await repo.cancel(id,sessions[1].id);
    assert.equal((await repo.appointment(sessions[1].id)).status,'cancelled');
    await assert.rejects(repo.status(id,'quoted'));await assert.rejects(repo.status(id,'booked'));
    await repo.status(id,'completed');assert.equal((await repo.request(id)).status,'completed');
    assert.equal((await repo.appointment(appointment.id)).status,'completed');
  });
  await t.test('cross-site posts are rejected and signed URLs are refreshed on each access',async()=>{
    const res=await fetch(base+'/admin/login',{method:'POST',headers:{Origin:'https://evil.example'},body:new URLSearchParams({password:process.env.ADMIN_PASSWORD})});assert.equal(res.status,403);
    const photo=(await repo.photos(id))[0];await get('/uploads/'+photo.id,true);await get('/uploads/'+photo.id,true);
    const signs=h.calls.filter(c=>c.url.pathname.includes('/storage/v1/object/sign/'));assert(signs.length>=3);assert(signs.every(c=>JSON.parse(c.options.body).expiresIn===60));
  });
  await t.test('RLS stays enabled and anonymous roles cannot execute commands',async()=>{
    const result=await h.db.query("select relname from pg_class where relnamespace='public'::regnamespace and relkind='r' and not relrowsecurity");assert.deepEqual(result.rows,[]);
    for(const role of ['anon','authenticated']){
      const result=await h.db.query("select has_function_privilege($1,'public.ink_flow_command(uuid,text,jsonb)','EXECUTE') allowed",[role]);assert.equal(result.rows[0].allowed,false);
    }
    assert(h.calls.filter(c=>c.url.pathname.startsWith('/rest/v1/')&&!c.url.pathname.includes('/rpc/')).every(c=>c.url.searchParams.get('workspace_id')?.startsWith('eq.')));
    assert(h.calls.every(c=>c.options.headers.apikey===process.env.SUPABASE_SECRET_KEY));
    assert(h.calls.every(c=>!c.options.headers.Authorization));
  });
});
