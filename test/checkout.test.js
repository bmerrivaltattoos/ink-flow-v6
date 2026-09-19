const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {harness} = require('./harness');
const {test} = require('node:test');
test('checkout retries, provider failure, and duplicate signed callbacks',async () => {
  const h = await harness();
  Object.assign(process.env, {SUPABASE_URL:'https://test.supabase.co',SUPABASE_SECRET_KEY:'audit-placeholder',WORKSPACE_ID:h.workspace,STRIPE_SECRET_KEY:'audit-placeholder',STRIPE_WEBHOOK_SECRET:'audit-webhook-placeholder',APP_URL:'https://ink-flow-v6.onrender.com'});
  const networkFetch = global.fetch;
  let calls = [], fail = false;
  global.fetch = async (url, options) => {
    if (url === 'https://api.stripe.com/v1/checkout/sessions') {
      calls.push(options);
      return Response.json(fail ? {error:{message:'simulated rejection'}} : {id:'cs_audit',url:'https://checkout.stripe.com/audit'}, {status:fail?403:200});
    }
    return networkFetch(url, options);
  };
  const app = require('../server');
  app.repo.client.transport = h.transport;
  const token = crypto.randomBytes(24).toString('hex');
  const r = await app.repo.client.command('intake',{client_name:'Local audit only',phone:'5550100',idea:'Local audit',placement:'Arm',size:'Palm',style:'Black & Grey',token,files:[]});
  await app.repo.quote(r.id,'2',60000,10000,'',[{start:new Date(Date.now()+86400000*7).toISOString(),duration:120}]);
  await app.repo.saveConsent(r.id,{legal_name:'Local audit',date_of_birth:'1990-01-01',signature_name:'Local audit',accepted_age:'1',accepted_health:'1',accepted_design:'1',accepted_aftercare:'1',accepted_cancellation:'1',photo_release_choice:'no',policy_version:'test'});
  const a = await app.repo.book(r.id,(await app.repo.slots(r.id))[0].id,30);
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    for(let i=0;i<2;i++) {
      const response = await networkFetch(`${base}/r/${token}/pay`,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(4000)});
      assert.equal(response.status,302); assert.equal(response.headers.get('location'),'https://checkout.stripe.com/audit');
    }
    assert.equal(calls[0].headers['Idempotency-Key'],calls[1].headers['Idempotency-Key']);
    const body = calls[0].body;
    assert.equal(body.get('mode'),'payment');assert.equal(body.get('line_items[0][price_data][unit_amount]'),'10000');
    assert.equal(body.get('line_items[0][price_data][currency]'),'usd');assert.equal(body.get('payment_method_types[0]'),'card');
    assert.equal(body.get('metadata[workspace_id]'),h.workspace);assert.equal(body.get('metadata[request_id]'),r.id);assert.equal(body.get('metadata[appointment_id]'),a.id);
    assert.equal(body.get('success_url'),`https://ink-flow-v6.onrender.com/r/${token}?paid=1`);
    assert.equal(body.get('cancel_url'),`https://ink-flow-v6.onrender.com/r/${token}?canceled=1`);
    assert.equal((await app.repo.pending(r.id)).stripe_session_id,'cs_audit');
    fail=true;
    assert.equal((await networkFetch(`${base}/r/${token}/pay`,{method:'POST',signal:AbortSignal.timeout(4000)})).status,503);
    assert.equal((await networkFetch(base+'/health')).status,200);
    const raw=JSON.stringify({type:'checkout.session.completed',data:{object:{id:'cs_audit',payment_status:'paid',currency:'usd',amount_total:10000,metadata:{workspace_id:h.workspace,request_id:r.id,appointment_id:a.id}}}});
    const t=Math.floor(Date.now()/1000),sig=crypto.createHmac('sha256',process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex');
    for(let i=0;i<2;i++)assert.equal((await networkFetch(base+'/stripe/webhook',{method:'POST',body:raw,headers:{'stripe-signature':`t=${t},v1=${sig}`}})).status,200);
    assert.equal((await app.repo.request(r.id)).status,'booked');assert.equal((await app.repo.payments(r.id)).length,1);
    console.log('PASS: isolated $100 checkout, redirects, metadata, idempotency, Stripe rejection recovery, signed webhook, single booking/payment. No live payment or external Stripe call.');
  } finally {global.fetch=networkFetch;await new Promise(resolve=>app.server.close(resolve));await h.db.close();}
});

