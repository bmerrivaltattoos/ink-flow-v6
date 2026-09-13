const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Supabase}=require('../lib/supabase');
const {validateImage,Storage}=require('../lib/repository');
const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_FAKE_TEST_VALUE',WORKSPACE_ID:'11111111-1111-4111-8111-111111111111'};
test('missing configuration and upstream errors are redacted',async()=>{
  let called=false;
  await assert.rejects(new Supabase({},async()=>{called=true;}).command('expire'),/not configured/);assert.equal(called,false);
  const db=new Supabase(env,async()=>Response.json({message:'leak '+env.SUPABASE_SECRET_KEY},{status:500}));
  await assert.rejects(db.command('expire'),e=>!e.message.includes(env.SUPABASE_SECRET_KEY)&&e.status===503);
});
test('legacy service-role headers supported without sending new secret as Bearer',async()=>{
  const db=new Supabase({...env,SUPABASE_SECRET_KEY:'eyJfakeTestJWT'},async(_url,o)=>{assert.equal(o.headers.Authorization,'Bearer eyJfakeTestJWT');return Response.json([]);});
  await db.rows('ink_requests');
});
test('tenant filter cannot be overridden by caller and pagination is explicit',async()=>{
  const seen=[];const db=new Supabase(env,async(url)=>{seen.push(new URL(url));return Response.json(seen.length===1?Array.from({length:500},(_,i)=>({id:i})):[]);});
  assert.equal((await db.rows('ink_requests',{workspace_id:'eq.other'})).length,500);
  assert.equal(seen.length,2);assert.equal(seen[1].searchParams.get('offset'),'500');assert(seen.every(u=>u.searchParams.get('workspace_id')==='eq.'+env.WORKSPACE_ID));
});
test('unsupported, spoofed and oversized image uploads are rejected',()=>{
  for(const file of [{mime:'image/svg+xml',data:Buffer.from('<svg/>')},{mime:'image/png',data:Buffer.from('not a PNG')},{mime:'image/jpeg',data:Buffer.alloc(15*1024*1024+1)}])assert.throws(()=>validateImage(file));
});
test('storage upload failure is safe and cross-workspace storage paths are rejected',async()=>{
  const storage=new Storage(new Supabase(env,async()=>Response.json({message:env.SUPABASE_SECRET_KEY},{status:500})));
  assert.throws(()=>storage.objectPath('other/secret.jpg'));
  await assert.rejects(storage.upload({filename:'test.jpg',mime:'image/jpeg',data:Buffer.from([255,216,255,217])}),e=>!e.message.includes(env.SUPABASE_SECRET_KEY));
});
