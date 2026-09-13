const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs');
const path=require('node:path');
async function harness(){
  const db=new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);`);
  // PGlite provides core gen_random_uuid; pgcrypto itself is not used by this schema.
  await db.exec(fs.readFileSync(path.join(__dirname,'../sql/001-foundation.sql'),'utf8').replace('create extension if not exists pgcrypto;',''));
  const migration=fs.readFileSync(path.join(__dirname,'../sql/002-ink-flow-v6.sql'),'utf8');
  await db.exec(migration);
  await db.exec(migration); // Verify rerun safety.
  await db.exec('grant usage on schema public to service_role; grant all on all tables in schema public to service_role;');
  const workspace='11111111-1111-4111-8111-111111111111';
  const other='22222222-2222-4222-8222-222222222222';
  await db.query("insert into workspaces(id,name) values($1,'Test artist'),($2,'Other artist')",[workspace,other]);
  const objects=new Map(),calls=[];
  async function transport(url,options={}){
    const u=new URL(url);calls.push({url:u,options});
    try {
      if(u.pathname.startsWith('/storage/v1/object/sign/')){
        const object=u.pathname.slice('/storage/v1/object/sign/'.length);
        if(!objects.has(object))return Response.json({}, {status:404});
        return Response.json({signedURL:'/object/sign/'+object+'?token=test-only'});
      }
      if(u.pathname.startsWith('/storage/v1/object/')){
        const object=u.pathname.slice('/storage/v1/object/'.length);
        if(options.method==='DELETE'){for(const p of JSON.parse(options.body).prefixes)objects.delete(object+'/'+p);return Response.json([]);}
        objects.set(object,options.body);return Response.json({Key:object});
      }
      if(u.pathname==='/rest/v1/rpc/ink_flow_command'){
        const p=JSON.parse(options.body);
        const {rows}=await db.query('select public.ink_flow_command($1,$2,$3) result',[p.p_workspace,p.p_action,p.p_data]);
        return Response.json(rows[0].result);
      }
      const table=u.pathname.split('/').pop();
      if(!/^(ink_[a-z_]+|reference_files)$/.test(table))throw Error('Unexpected table');
      const values=[],where=[];
      for(const [k,v]of u.searchParams){
        if(['select','order','limit','offset'].includes(k))continue;
        if(!/^[a-z_]+$/.test(k))throw Error('Invalid column');
        if(v.startsWith('eq.')){values.push(v.slice(3));where.push(`${k}=$${values.length}`);}
        else if(v.startsWith('in.(')){values.push(v.slice(4,-1).split(','));where.push(`${k}=any($${values.length})`);}
        else throw Error('Unsupported test filter');
      }
      const order=(u.searchParams.get('order')||'created_at.desc').split(',').map(x=>{const [col,dir]=x.split('.');if(!/^[a-z_]+$/.test(col)||!['asc','desc'].includes(dir))throw Error('Invalid sort');return `${col} ${dir}`;}).join(',');
      const {rows}=await db.query(`select * from ${table} where ${where.join(' and ')} order by ${order} limit ${Number(u.searchParams.get('limit')||500)} offset ${Number(u.searchParams.get('offset')||0)}`,values);
      return Response.json(rows);
    }catch(e){return Response.json({code:e.code||'TEST_FAILURE',message:e.message},{status:400});}
  }
  return {db,workspace,other,objects,calls,transport};
}
module.exports={harness};
