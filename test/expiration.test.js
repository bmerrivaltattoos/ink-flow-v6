const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {harness}=require('./harness');

test('released checkout cleanup preserves transactional payment safety',async t=>{
  const h=await harness();
  Object.assign(process.env,{SUPABASE_URL:'https://test.supabase.co',SUPABASE_SECRET_KEY:'test-only',WORKSPACE_ID:h.workspace,STRIPE_SECRET_KEY:'test-only',STRIPE_WEBHOOK_SECRET:'test-webhook'});
  const networkFetch=global.fetch, sessions=new Map(), calls=[];
  let failExpire=false,day=50;
  global.fetch=async(url,options={})=>{
    if(String(url).startsWith('https://api.stripe.com/')){
      calls.push({url,method:options.method||'GET'});
      const parts=new URL(url).pathname.split('/'), id=parts[4], session=sessions.get(id);
      if(!session)return Response.json({}, {status:404});
      if(parts[5]==='expire'){
        if(failExpire)return Response.json({}, {status:503});
        assert.equal(session.status,'open');session.status='expired';
      }
      return Response.json(session);
    }
    return networkFetch(url,options);
  };
  const app=require('../server');app.repo.client.transport=h.transport;
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{global.fetch=networkFetch;await new Promise(resolve=>app.server.close(resolve));await h.db.close();});
  async function held(){
    const token=crypto.randomBytes(24).toString('hex');
    const r=await app.repo.client.command('intake',{client_name:'Expiration test',phone:'5550100',idea:'Test',placement:'Arm',size:'Palm',style:'Black & Grey',token,files:[]});
    await app.repo.quote(r.id,'2',10000,100,'',[{start:new Date(Date.now()+86400000*day++).toISOString(),duration:120}]);
    await app.repo.saveConsent(r.id,{legal_name:'Test',date_of_birth:'1990-01-01',signature_name:'Test',accepted_age:'1',accepted_health:'1',accepted_design:'1',accepted_aftercare:'1',accepted_cancellation:'1',photo_release_choice:'no',policy_version:'test'});
    const slot=(await app.repo.slots(r.id))[0];
    const a=await app.repo.book(r.id,slot.id,30), session='cs_test_'+a.id;
    await app.repo.checkout(r.id,a.id,session);sessions.set(session,{id:session,status:'open'});
    return {request:r.id,appointment:a.id,session,slot:slot.id,token};
  }
  async function elapsed(b){await h.db.query("update appointments set reservation_expires_at=clock_timestamp()-interval '1 second' where id=$1",[b.appointment]);}
  async function paid(b,type='checkout.session.completed'){
    const raw=JSON.stringify({type,data:{object:{id:b.session,payment_status:'paid',currency:'usd',amount_total:100,metadata:{workspace_id:h.workspace,request_id:b.request,appointment_id:b.appointment}}}});
    const time=Math.floor(Date.now()/1000),sig=crypto.createHmac('sha256',process.env.STRIPE_WEBHOOK_SECRET).update(`${time}.${raw}`).digest('hex');
    return networkFetch(base+'/stripe/webhook',{method:'POST',body:raw,headers:{'stripe-signature':`t=${time},v1=${sig}`}});
  }
  await t.test('on-time payment confirms once and cleanup never touches the paid booking',async()=>{
    const b=await held();sessions.get(b.session).status='complete';
    assert.equal((await paid(b)).status,200);
    assert.equal((await paid(b)).status,200);
    assert.equal((await paid(b,'checkout.session.async_payment_succeeded')).status,200);
    await app.expireReleasedCheckouts();
    assert.equal((await app.repo.request(b.request)).status,'booked');
    const rows=await h.db.query('select status,reservation_expires_at from appointments where id=$1',[b.appointment]);
    assert.equal(rows.rows[0].status,'confirmed');assert.equal(rows.rows[0].reservation_expires_at,null);
    assert.equal((await app.repo.payments(b.request)).length,1);
    assert.equal((await app.repo.appointments(b.request)).length,1);
    assert.equal((await app.repo.totals(b.request)).paid,100);
    assert(!calls.some(c=>c.url.includes(b.session)));
  });
  await t.test('elapsed hold closes Stripe checkout; repeated cleanup is harmless',async()=>{
    const b=await held();await elapsed(b);
    const result=await app.expireReleasedCheckouts();assert.equal(result.expired,1);
    assert.equal(sessions.get(b.session).status,'expired');
    assert.equal((await app.repo.appointment(b.appointment)).status,'expired');
    assert.equal((await app.repo.slots(b.request))[0].status,'available');
    await app.expireReleasedCheckouts();
    assert.equal(calls.filter(c=>c.url.endsWith(b.session+'/expire')).length,1);
  });
  await t.test('Stripe failure retries; late/replayed paid events cannot confirm or duplicate',async()=>{
    const b=await held();await elapsed(b);failExpire=true;
    assert.equal((await app.expireReleasedCheckouts()).failed,1);
    assert.equal((await app.repo.appointment(b.appointment)).status,'expired');
    // Simulate provider completion racing cleanup. The signed event is still
    // recorded for reconciliation, but cannot restore the released appointment.
    sessions.get(b.session).status='complete';
    for(const type of ['checkout.session.completed','checkout.session.completed','checkout.session.async_payment_succeeded'])assert.equal((await paid(b,type)).status,200);
    const payments=await app.repo.payments(b.request);assert.equal(payments.length,1);
    assert.equal(payments[0].status,'paid');assert.equal(payments[0].amount_cents,100);assert.equal(payments[0].requires_review,true);
    assert.equal((await app.repo.appointment(b.appointment)).status,'expired');
    assert.equal((await app.repo.request(b.request)).status,'quoted');assert.equal((await app.repo.totals(b.request)).paid,0);
    assert.equal((await app.repo.appointments(b.request)).length,1);
    assert(!(await app.repo.notifications()).some(n=>n.request_id===b.request));
    failExpire=false;assert.equal((await app.expireReleasedCheckouts()).failed,0);
  });
  await t.test('failed expiration of an open session retries successfully',async()=>{
    const b=await held();await elapsed(b);failExpire=true;
    assert.equal((await app.expireReleasedCheckouts()).failed,1);
    failExpire=false;assert.equal((await app.expireReleasedCheckouts()).expired,1);
    assert.equal(sessions.get(b.session).status,'expired');
  });
  await t.test('old late payment cannot confirm a newly reserved appointment',async()=>{
    const b=await held();await elapsed(b);await app.repo.expire();
    const replacement=await app.repo.book(b.request,b.slot,30);
    assert.equal((await paid(b)).status,200);assert.equal((await paid(b)).status,200);
    assert.equal((await app.repo.appointment(b.appointment)).status,'expired');
    assert.equal((await app.repo.appointment(replacement.id)).status,'pending_payment');
    assert.equal((await app.repo.payments(b.request)).length,1);
    assert.equal((await app.repo.payments(b.request))[0].requires_review,true);
    assert.equal((await app.repo.totals(b.request)).paid,0);
  });
  await t.test('database rejects late confirmation even before expiration cleanup runs',async()=>{
    const b=await held();await elapsed(b);
    const result=await app.repo.deposit(b.request,b.appointment,b.session,100,'stripe_deposit');
    assert.equal(result.confirmed,false);
    assert.equal((await app.repo.payments(b.request))[0].requires_review,true);
    assert.equal((await app.repo.appointment(b.appointment)).status,'pending_payment');
    await app.repo.expire();assert.equal((await app.repo.appointment(b.appointment)).status,'expired');
  });
});
