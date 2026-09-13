-- Run AFTER 001-foundation.sql. Additive private-beta migration; no public policies.
begin;
alter table public.tattoo_requests add column if not exists public_token text;
create unique index if not exists ink_request_token on public.tattoo_requests(public_token);
create unique index if not exists ink_project_request on public.projects(workspace_id,request_id);
alter table public.projects add column if not exists estimated_hours_text text;
alter table public.appointments add column if not exists session_type text not null default 'Tattoo session';
alter table public.appointments add column if not exists client_visible_notes text;
alter table public.appointments add column if not exists deposit_due_cents integer not null default 0;
alter table public.appointments add column if not exists stripe_session_id text;
alter table public.payments add column if not exists kind text;
alter table public.payments add column if not exists requires_review boolean not null default false;
alter table public.change_requests add column if not exists preferred_times text;
alter table public.consent_forms add column if not exists photo_choice_ack boolean not null default false;
alter table public.notification_outbox add column if not exists provider_message_id text;
create unique index if not exists ink_payment_external on public.payments(workspace_id,external_payment_id) where external_payment_id is not null;
create unique index if not exists ink_consent_project on public.consent_forms(workspace_id,project_id);
create unique index if not exists ink_notification_unique on public.notification_outbox(workspace_id,appointment_id,template_key) where appointment_id is not null;

-- Compatibility projections preserve v5 presentation without duplicating its database.
create or replace view public.ink_requests with (security_invoker=true) as
select r.workspace_id,r.id,r.public_token,r.created_at,r.updated_at,r.client_id,p.id project_id,
 concat_ws(' ',c.first_name,c.last_name) client_name,c.phone,c.email,
 r.tattoo_description idea,r.placement,r.approximate_size size,r.style,r.is_coverup coverup,
 r.client_notes notes,coalesce(p.private_notes,r.artist_notes) artist_notes,
 p.estimated_hours_text estimated_hours,p.quoted_price_cents quote_cents,p.deposit_required_cents deposit_cents,
 case when p.status='completed' then 'completed'
 when exists(select 1 from public.appointments a where a.workspace_id=r.workspace_id and a.project_id=p.id and a.status='pending_deposit') then 'pending_deposit'
 when exists(select 1 from public.appointments a where a.workspace_id=r.workspace_id and a.project_id=p.id and a.status='confirmed') then 'booked'
 when p.id is not null then 'quoted' else 'new' end status
from public.tattoo_requests r join public.clients c on c.id=r.client_id and c.workspace_id=r.workspace_id
left join public.projects p on p.request_id=r.id and p.workspace_id=r.workspace_id;

create or replace view public.ink_slots with (security_invoker=true) as
select s.*,p.request_id,extract(epoch from(s.end_at-s.start_at))/60 duration_minutes,
 (s.status in ('held','booked')) selected,s.start_at::text slot_text
from public.approved_slots s join public.projects p on p.id=s.project_id and p.workspace_id=s.workspace_id;
create or replace view public.ink_appointments with (security_invoker=true) as
select a.id,a.workspace_id,a.project_id,p.request_id,a.client_id,a.start_at,a.end_at,a.created_at,
 a.session_number,a.session_type,a.client_visible_notes notes,a.reservation_expires_at,
 a.approved_slot_id source_slot_id,a.deposit_due_cents,a.stripe_session_id,
 extract(epoch from(a.end_at-a.start_at))/60 duration_minutes,
 case a.status when 'confirmed' then 'scheduled' when 'pending_deposit' then 'pending_payment' else a.status end status,
 concat_ws(' ',c.first_name,c.last_name) client_name,r.placement
from public.appointments a join public.projects p on p.id=a.project_id and p.workspace_id=a.workspace_id
join public.clients c on c.id=a.client_id and c.workspace_id=a.workspace_id
join public.tattoo_requests r on r.id=p.request_id and r.workspace_id=a.workspace_id;
create or replace view public.ink_payments with (security_invoker=true) as
select x.*,p.request_id,x.notes note from public.payments x
join public.projects p on p.id=x.project_id and p.workspace_id=x.workspace_id;
create or replace view public.ink_consents with (security_invoker=true) as
select c.*,p.request_id,c.electronic_signature signature_name,
 case when c.photo_permission then 'yes' else 'no' end photo_release_choice
from public.consent_forms c join public.projects p on p.id=c.project_id and p.workspace_id=c.workspace_id;
create or replace view public.ink_changes with (security_invoker=true) as
select c.*,p.request_id,c.request_type kind from public.change_requests c
join public.projects p on p.id=c.project_id and p.workspace_id=c.workspace_id;
create or replace view public.ink_notifications with (security_invoker=true) as
select n.*,p.request_id,n.template_key kind,n.message_body message,n.scheduled_for send_after,
 concat_ws(' ',c.first_name,c.last_name) client_name,a.start_at
from public.notification_outbox n join public.projects p on p.id=n.project_id and p.workspace_id=n.workspace_id
join public.clients c on c.id=n.client_id and c.workspace_id=n.workspace_id
left join public.appointments a on a.id=n.appointment_id and a.workspace_id=n.workspace_id;

-- A transaction per business operation. Locking the workspace serializes calendar and
-- payment changes across processes. Never accept workspace selection from a browser.
create or replace function public.ink_flow_command(p_workspace uuid,p_action text,p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
 r public.tattoo_requests; pr public.projects; a public.appointments; s public.approved_slots;
 v_client uuid; v_id uuid; v_start timestamptz; v_end timestamptz; v_item jsonb;
 v_paid bigint; v_amount integer; v_count integer; v_confirm boolean; v_old public.payments;
begin
 perform 1 from public.workspaces where id=p_workspace and active=true for update;
 if not found then raise exception 'Workspace unavailable'; end if;

 if p_action='intake' then
   if length(trim(p_data->>'client_name'))=0 or length(trim(p_data->>'idea'))=0 then raise exception 'Missing request'; end if;
   insert into public.clients(workspace_id,first_name,phone,email) values(p_workspace,p_data->>'client_name',p_data->>'phone',p_data->>'email') returning id into v_client;
   insert into public.tattoo_requests(workspace_id,client_id,public_token,tattoo_description,placement,approximate_size,style,color_preference,is_coverup,client_notes)
   values(p_workspace,v_client,p_data->>'token',p_data->>'idea',p_data->>'placement',p_data->>'size',p_data->>'style',p_data->>'color_preference',coalesce((p_data->>'coverup')::boolean,false),p_data->>'notes') returning id into v_id;
   for v_item in select value from jsonb_array_elements(coalesce(p_data->'files','[]')) loop
     if v_item->>'storage_path' not like p_workspace::text||'/%' then raise exception 'Invalid file scope'; end if;
     insert into public.reference_files(workspace_id,request_id,uploaded_by,file_type,original_filename,storage_bucket,storage_path,mime_type,file_size_bytes)
     values(p_workspace,v_id,'client','reference',v_item->>'original_filename',v_item->>'storage_bucket',v_item->>'storage_path',v_item->>'mime_type',(v_item->>'file_size_bytes')::bigint);
   end loop;
   return jsonb_build_object('id',v_id);
 end if;

 if p_action='expire' then
   v_count:=0;
   for a in select * from public.appointments where workspace_id=p_workspace and status='pending_deposit' and reservation_expires_at<=now() loop
     update public.appointments set status='expired' where workspace_id=p_workspace and id=a.id;
     update public.approved_slots set status='available' where workspace_id=p_workspace and id=a.approved_slot_id and status='held';
     update public.notification_outbox set status='cancelled',last_error='Reservation expired' where workspace_id=p_workspace and appointment_id=a.id and status='queued';
     update public.projects set status='ready_to_book' where workspace_id=p_workspace and id=a.project_id and not exists(select 1 from public.appointments x where x.workspace_id=p_workspace and x.project_id=a.project_id and x.status in('confirmed','pending_deposit'));
     v_count:=v_count+1;
   end loop;
   return to_jsonb(v_count);
 end if;

 if p_action in ('notification_claim','notification_result','notification_now') then
   if p_action='notification_claim' then
     -- Sending rows are never automatically retried: a crash after provider acceptance
     -- needs reconciliation to avoid sending a duplicate SMS.
     with claimed as (update public.notification_outbox set status='sending',attempts=attempts+1
       where workspace_id=p_workspace and id in (select id from public.notification_outbox where workspace_id=p_workspace and status='queued' and scheduled_for<=now() order by scheduled_for limit 20) returning *)
       select coalesce(jsonb_agg(to_jsonb(claimed)),'[]') into v_item from claimed;
     return v_item;
   elsif p_action='notification_now' then
     update public.notification_outbox set scheduled_for=now() where workspace_id=p_workspace and id=(p_data->>'id')::uuid and status='queued';
   else
     update public.notification_outbox set status=case when (p_data->>'ok')::boolean then 'sent' else 'failed' end,
       sent_at=case when (p_data->>'ok')::boolean then now() else null end,
       provider_message_id=p_data->>'provider_id',last_error=case when (p_data->>'ok')::boolean then null else 'SMS delivery failed; verify provider status before retrying.' end
     where workspace_id=p_workspace and id=(p_data->>'id')::uuid and status='sending';
   end if;
   return '{}'::jsonb;
 end if;

 select * into r from public.tattoo_requests where workspace_id=p_workspace and id=(p_data->>'request_id')::uuid;
 if r.id is null then raise exception 'Request unavailable'; end if;
 select * into pr from public.projects where workspace_id=p_workspace and request_id=r.id;

 if p_action='quote' then
   if exists(select 1 from public.appointments where workspace_id=p_workspace and project_id=pr.id and status in('confirmed','pending_deposit')) then raise exception 'Cannot requote active booking'; end if;
   v_amount:=(p_data->>'quote')::integer;
   if v_amount<0 or (p_data->>'deposit')::integer<0 or (p_data->>'deposit')::integer>v_amount then raise exception 'Invalid amount'; end if;
   insert into public.projects(workspace_id,request_id,client_id,artist_id,title,status,estimated_hours_text,quoted_price_cents,deposit_required_cents,private_notes)
   values(p_workspace,r.id,r.client_id,r.assigned_artist_id,r.placement,'ready_to_book',p_data->>'estimate',v_amount,(p_data->>'deposit')::integer,p_data->>'notes')
   on conflict(workspace_id,request_id) do update set estimated_hours_text=excluded.estimated_hours_text,quoted_price_cents=excluded.quoted_price_cents,deposit_required_cents=excluded.deposit_required_cents,private_notes=excluded.private_notes,status='ready_to_book' returning * into pr;
   update public.tattoo_requests set status='quoted' where workspace_id=p_workspace and id=r.id;
   update public.reference_files set project_id=pr.id where workspace_id=p_workspace and request_id=r.id;
   update public.approved_slots set status='cancelled' where workspace_id=p_workspace and project_id=pr.id and status='available';
   for v_item in select value from jsonb_array_elements(p_data->'slots') loop
     v_start:=(v_item->>'start')::timestamptz; v_end:=v_start+make_interval(mins=>(v_item->>'duration')::integer);
     if v_start<=now() or v_end<=v_start or v_end>v_start+interval '24 hours' then raise exception 'Invalid time'; end if;
     if exists(select 1 from public.appointments where workspace_id=p_workspace and status in('confirmed','pending_deposit') and start_at<v_end and end_at>v_start) then raise exception 'Calendar conflict'; end if;
     insert into public.approved_slots(workspace_id,project_id,artist_id,start_at,end_at) values(p_workspace,pr.id,pr.artist_id,v_start,v_end);
   end loop;
   return jsonb_build_object('id',pr.id);
 end if;
 if pr.id is null then raise exception 'Quote required'; end if;

 if p_action='consent' then
   if not ((p_data->>'accepted_age')='1' and (p_data->>'accepted_health')='1' and (p_data->>'accepted_design')='1' and (p_data->>'accepted_aftercare')='1' and (p_data->>'accepted_cancellation')='1') then raise exception 'Consent required'; end if;
   if nullif(trim(p_data->>'signature_name'),'') is null or nullif(trim(p_data->>'legal_name'),'') is null or (p_data->>'date_of_birth')::date>=current_date then raise exception 'Invalid consent'; end if;
   insert into public.consent_forms(workspace_id,project_id,client_id,legal_name,date_of_birth,emergency_contact_name,emergency_contact_phone,legal_eligibility_ack,health_disclosure_ack,design_approval_ack,aftercare_ack,cancellation_policy_ack,photo_permission,photo_choice_ack,electronic_signature,policy_version,ip_hash,user_agent)
   values(p_workspace,pr.id,r.client_id,p_data->>'legal_name',(p_data->>'date_of_birth')::date,p_data->>'emergency_contact_name',p_data->>'emergency_contact_phone',true,true,true,true,true,p_data->>'photo_release_choice'='yes',coalesce(p_data->>'accepted_photo_release'='1',false),p_data->>'signature_name',p_data->>'policy_version',p_data->>'ip_hash',p_data->>'user_agent') on conflict(workspace_id,project_id) do nothing;
 elsif p_action in ('book','add_session') then
   if not exists(select 1 from public.consent_forms where workspace_id=p_workspace and project_id=pr.id) then raise exception 'Consent required'; end if;
   if p_action='book' then
     if pr.status not in('quoted','ready_to_book') or exists(select 1 from public.appointments where workspace_id=p_workspace and project_id=pr.id and status in('confirmed','pending_deposit')) then raise exception 'Already booked'; end if;
     select * into s from public.approved_slots where workspace_id=p_workspace and project_id=pr.id and id=(p_data->>'slot_id')::uuid and status='available' and (expires_at is null or expires_at>now());
     if s.id is null then raise exception 'Slot unavailable'; end if;
     v_start:=s.start_at; v_end:=s.end_at;
   else
     v_start:=(p_data->>'start')::timestamptz; v_end:=v_start+make_interval(mins=>(p_data->>'duration')::integer);
   end if;
   if v_start<=now() or v_end<=v_start or v_end>v_start+interval '24 hours' then raise exception 'Invalid time'; end if;
   if exists(select 1 from public.appointments where workspace_id=p_workspace and status in('confirmed','pending_deposit') and start_at<v_end and end_at>v_start) then raise exception 'Calendar conflict'; end if;
   select coalesce(sum(amount_cents),0) into v_paid from public.payments where workspace_id=p_workspace and project_id=pr.id and status='paid' and not requires_review;
   v_amount:=greatest(pr.deposit_required_cents-v_paid,0); v_confirm:=v_amount=0;
   if p_action='add_session' and not v_confirm then raise exception 'Required deposit is unpaid'; end if;
   insert into public.appointments(workspace_id,project_id,client_id,artist_id,approved_slot_id,session_number,start_at,end_at,status,reservation_expires_at,deposit_due_cents,session_type,client_visible_notes)
   values(p_workspace,pr.id,r.client_id,pr.artist_id,s.id,(select coalesce(max(session_number),0)+1 from public.appointments where workspace_id=p_workspace and project_id=pr.id),v_start,v_end,case when v_confirm then 'confirmed' else 'pending_deposit' end,case when v_confirm then null else now()+make_interval(mins=>greatest(5,least(120,coalesce((p_data->>'hold_minutes')::integer,30)))) end,v_amount,coalesce(nullif(p_data->>'session_type',''),'Tattoo session'),p_data->>'notes') returning * into a;
   update public.approved_slots set status=case when v_confirm then 'booked' else 'held' end where workspace_id=p_workspace and id=s.id;
   update public.projects set status='booked' where workspace_id=p_workspace and id=pr.id;
   update public.tattoo_requests set status='converted' where workspace_id=p_workspace and id=r.id;
   return jsonb_build_object('id',a.id,'confirmed',v_confirm);
 elsif p_action='checkout' then
   update public.appointments set stripe_session_id=p_data->>'session_id' where workspace_id=p_workspace and project_id=pr.id and id=(p_data->>'appointment_id')::uuid and status='pending_deposit' and reservation_expires_at>now();
   if not found then raise exception 'Reservation expired'; end if;
 elsif p_action in ('deposit','manual_payment') then
   if p_action='deposit' then
     select * into a from public.appointments where workspace_id=p_workspace and project_id=pr.id and id=(p_data->>'appointment_id')::uuid;
     if a.id is null then raise exception 'Appointment unavailable'; end if;
     select * into v_old from public.payments where workspace_id=p_workspace and external_payment_id=p_data->>'external_id';
     if v_old.id is not null then
       if v_old.project_id<>pr.id or v_old.appointment_id<>a.id then raise exception 'Payment association mismatch'; end if;
       return jsonb_build_object('id',a.id,'confirmed',a.status='confirmed','review',v_old.requires_review);
     end if;
     v_amount:=(p_data->>'amount')::integer;
     if v_amount<>a.deposit_due_cents or v_amount<=0 or (p_data->>'kind'='stripe_deposit' and (a.stripe_session_id is distinct from p_data->>'external_id')) then raise exception 'Payment mismatch'; end if;
     v_confirm:=a.status='pending_deposit' and a.reservation_expires_at>now();
     -- Late successful charges are retained for reconciliation, never resurrect a slot.
     insert into public.payments(workspace_id,client_id,project_id,appointment_id,payment_type,method,amount_cents,status,external_payment_id,kind,notes,paid_at,requires_review)
     values(p_workspace,r.client_id,pr.id,a.id,'deposit',case when p_data->>'kind'='stripe_deposit' then 'stripe' else 'other' end,v_amount,'paid',p_data->>'external_id',p_data->>'kind',case when v_confirm then 'Deposit' else 'REVIEW: payment arrived after hold ended; refund or contact client.' end,now(),not v_confirm);
   else
     v_amount:=(p_data->>'amount')::integer; if v_amount<=0 then raise exception 'Invalid payment'; end if;
     insert into public.payments(workspace_id,client_id,project_id,payment_type,method,amount_cents,status,kind,notes,paid_at) values(p_workspace,r.client_id,pr.id,'session','other',v_amount,'paid','manual',p_data->>'note',now());
     select * into a from public.appointments where workspace_id=p_workspace and project_id=pr.id and status='pending_deposit' and reservation_expires_at>now() order by created_at desc limit 1;
     select coalesce(sum(amount_cents),0) into v_paid from public.payments where workspace_id=p_workspace and project_id=pr.id and status='paid' and not requires_review;
     v_confirm:=a.id is not null and v_paid>=pr.deposit_required_cents;
   end if;
   if v_confirm then
     update public.appointments set status='confirmed',reservation_expires_at=null where workspace_id=p_workspace and id=a.id;
     update public.approved_slots set status='booked' where workspace_id=p_workspace and id=a.approved_slot_id;
     update public.projects set status='booked' where workspace_id=p_workspace and id=pr.id;
   end if;
   return jsonb_build_object('id',a.id,'confirmed',coalesce(v_confirm,false));
 elsif p_action='cancel' then
   update public.appointments set status='cancelled' where workspace_id=p_workspace and project_id=pr.id and id=(p_data->>'appointment_id')::uuid returning * into a;
   update public.approved_slots set status='cancelled' where workspace_id=p_workspace and id=a.approved_slot_id;
   update public.notification_outbox set status='cancelled',last_error='Appointment cancelled' where workspace_id=p_workspace and appointment_id=a.id and status='queued';
   update public.projects set status='ready_to_book' where workspace_id=p_workspace and id=pr.id and not exists(select 1 from public.appointments where workspace_id=p_workspace and project_id=pr.id and status in('confirmed','pending_deposit'));
 elsif p_action='change' then
   select * into a from public.appointments where workspace_id=p_workspace and project_id=pr.id and status='confirmed' order by start_at limit 1;
   if a.id is null then raise exception 'No confirmed appointment'; end if;
   insert into public.change_requests(workspace_id,project_id,client_id,appointment_id,request_type,reason,preferred_times) values(p_workspace,pr.id,r.client_id,a.id,p_data->>'kind',p_data->>'reason',p_data->>'preferred_times');
 elsif p_action='status' then
   -- Status controls cannot bypass consent, payment, or actual calendar state.
   if p_data->>'status'='completed' then
     if exists(select 1 from public.appointments where workspace_id=p_workspace and project_id=pr.id and status='pending_deposit') then raise exception 'Pending deposit'; end if;
     update public.projects set status='completed',completed_at=now() where workspace_id=p_workspace and id=pr.id;
     update public.appointments set status='completed',completed_at=now() where workspace_id=p_workspace and project_id=pr.id and status='confirmed';
     update public.notification_outbox set status='cancelled' where workspace_id=p_workspace and project_id=pr.id and status='queued';
   elsif p_data->>'status'='quoted' then
     if exists(select 1 from public.appointments where workspace_id=p_workspace and project_id=pr.id and status in('confirmed','pending_deposit')) then raise exception 'Cancel active sessions first'; end if;
     update public.projects set status='ready_to_book',completed_at=null where workspace_id=p_workspace and id=pr.id;
   else raise exception 'Status is derived from booking and payment'; end if;
 elsif p_action='queue' then
   if p_data->>'appointment_id' is not null and not exists(select 1 from public.appointments where workspace_id=p_workspace and project_id=pr.id and id=(p_data->>'appointment_id')::uuid and status='confirmed') then return '{}'::jsonb; end if;
   insert into public.notification_outbox(workspace_id,project_id,client_id,appointment_id,channel,recipient,template_key,message_body,scheduled_for)
   values(p_workspace,pr.id,r.client_id,(p_data->>'appointment_id')::uuid,'sms',p_data->>'recipient',p_data->>'kind',p_data->>'message',(p_data->>'send_after')::timestamptz) on conflict do nothing;
 else raise exception 'Unsupported operation';
 end if;
 return '{}'::jsonb;
end $$;

revoke all on function public.ink_flow_command(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.ink_flow_command(uuid,text,jsonb) to service_role;
revoke all on public.ink_requests,public.ink_slots,public.ink_appointments,public.ink_payments,public.ink_consents,public.ink_changes,public.ink_notifications from anon,authenticated;
grant select on public.ink_requests,public.ink_slots,public.ink_appointments,public.ink_payments,public.ink_consents,public.ink_changes,public.ink_notifications to service_role;
-- Foundation tables retain RLS. No bucket or storage.objects changes.
commit;
