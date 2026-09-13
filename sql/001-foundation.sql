-- =========================================================
-- Tattoo Booking Platform - Foundation Schema v1
-- Supabase / PostgreSQL
-- =========================================================

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  email text,
  phone text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  owner_user_id uuid references auth.users(id) on delete restrict,
  business_name text,
  business_phone text,
  timezone text not null default 'America/Denver',
  currency text not null default 'USD',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'artist' check (role in ('owner','admin','artist','assistant')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  first_name text not null,
  last_name text,
  email text,
  phone text,
  preferred_contact text default 'text',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tattoo_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  assigned_artist_id uuid references auth.users(id) on delete set null,
  status text not null default 'new' check (status in ('new','reviewing','quoted','waiting_on_client','approved','declined','converted')),
  tattoo_description text not null,
  placement text,
  approximate_size text,
  style text,
  color_preference text,
  is_coverup boolean not null default false,
  client_notes text,
  artist_notes text,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  request_id uuid references public.tattoo_requests(id) on delete set null,
  client_id uuid not null references public.clients(id) on delete cascade,
  artist_id uuid references auth.users(id) on delete set null,
  title text,
  status text not null default 'quoted' check (status in ('quoted','waiting_on_client','ready_to_book','booked','in_progress','completed','cancelled')),
  estimated_hours_min numeric(6,2),
  estimated_hours_max numeric(6,2),
  quoted_price_cents integer,
  deposit_required_cents integer not null default 0,
  private_notes text,
  client_visible_notes text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reference_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  request_id uuid references public.tattoo_requests(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  uploaded_by text not null default 'client' check (uploaded_by in ('client','artist','staff')),
  file_type text not null default 'reference' check (file_type in ('reference','design','consent','other')),
  original_filename text,
  storage_bucket text not null,
  storage_path text not null,
  mime_type text,
  file_size_bytes bigint,
  created_at timestamptz not null default now(),
  check (request_id is not null or project_id is not null)
);

create table if not exists public.approved_slots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  artist_id uuid references auth.users(id) on delete set null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'available' check (status in ('available','held','booked','expired','cancelled')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  check (end_at > start_at)
);

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  artist_id uuid references auth.users(id) on delete set null,
  approved_slot_id uuid references public.approved_slots(id) on delete set null,
  session_number integer not null default 1,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'pending_deposit' check (status in ('pending_deposit','confirmed','completed','cancelled','expired','no_show')),
  reservation_expires_at timestamptz,
  actual_hours numeric(6,2),
  artist_notes text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at)
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,
  payment_type text not null default 'session' check (payment_type in ('deposit','session','gift_certificate','refund','other')),
  method text check (method in ('stripe','cash','cashapp','venmo','card','other')),
  amount_cents integer not null,
  status text not null default 'paid' check (status in ('pending','paid','refunded','failed','cancelled')),
  external_payment_id text,
  notes text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.consent_forms (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  legal_name text not null,
  date_of_birth date not null,
  emergency_contact_name text,
  emergency_contact_phone text,
  legal_eligibility_ack boolean not null default false,
  health_disclosure_ack boolean not null default false,
  design_approval_ack boolean not null default false,
  aftercare_ack boolean not null default false,
  cancellation_policy_ack boolean not null default false,
  photo_permission boolean not null default false,
  electronic_signature text not null,
  policy_version text not null,
  signed_at timestamptz not null default now(),
  ip_hash text,
  user_agent text,
  created_at timestamptz not null default now()
);

create table if not exists public.change_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete set null,
  client_id uuid not null references public.clients(id) on delete cascade,
  request_type text not null check (request_type in ('reschedule','cancel')),
  reason text,
  requested_start_at timestamptz,
  status text not null default 'open' check (status in ('open','approved','denied','resolved','cancelled')),
  artist_response text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  channel text not null check (channel in ('sms','email')),
  recipient text not null,
  template_key text,
  message_body text not null,
  status text not null default 'queued' check (status in ('queued','sending','sent','failed','cancelled')),
  scheduled_for timestamptz not null default now(),
  sent_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);

create table if not exists public.gift_certificates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  purchaser_client_id uuid references public.clients(id) on delete set null,
  assigned_client_id uuid references public.clients(id) on delete set null,
  code text unique,
  original_value_cents integer,
  remaining_value_cents integer,
  purchased_hours numeric(6,2),
  remaining_hours numeric(6,2),
  status text not null default 'active' check (status in ('active','redeemed','expired','cancelled')),
  purchased_at timestamptz not null default now(),
  expires_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.project_notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  author_user_id uuid references auth.users(id) on delete set null,
  note text not null,
  visible_to_client boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_clients_workspace on public.clients(workspace_id);
create index if not exists idx_requests_workspace_status on public.tattoo_requests(workspace_id, status);
create index if not exists idx_projects_workspace_status on public.projects(workspace_id, status);
create index if not exists idx_projects_client on public.projects(client_id);
create index if not exists idx_slots_project_start on public.approved_slots(project_id, start_at);
create index if not exists idx_appointments_workspace_start on public.appointments(workspace_id, start_at);
create index if not exists idx_appointments_project on public.appointments(project_id);
create index if not exists idx_payments_project on public.payments(project_id);
create index if not exists idx_notifications_status_schedule on public.notification_outbox(status, scheduled_for);
create index if not exists idx_change_requests_workspace_status on public.change_requests(workspace_id, status);

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();

drop trigger if exists workspaces_updated_at on public.workspaces;
create trigger workspaces_updated_at before update on public.workspaces for each row execute function public.set_updated_at();

drop trigger if exists clients_updated_at on public.clients;
create trigger clients_updated_at before update on public.clients for each row execute function public.set_updated_at();

drop trigger if exists requests_updated_at on public.tattoo_requests;
create trigger requests_updated_at before update on public.tattoo_requests for each row execute function public.set_updated_at();

drop trigger if exists projects_updated_at on public.projects;
create trigger projects_updated_at before update on public.projects for each row execute function public.set_updated_at();

drop trigger if exists appointments_updated_at on public.appointments;
create trigger appointments_updated_at before update on public.appointments for each row execute function public.set_updated_at();

drop trigger if exists gift_certificates_updated_at on public.gift_certificates;
create trigger gift_certificates_updated_at before update on public.gift_certificates for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email, ''), '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.clients enable row level security;
alter table public.tattoo_requests enable row level security;
alter table public.projects enable row level security;
alter table public.reference_files enable row level security;
alter table public.approved_slots enable row level security;
alter table public.appointments enable row level security;
alter table public.payments enable row level security;
alter table public.consent_forms enable row level security;
alter table public.change_requests enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.gift_certificates enable row level security;
alter table public.project_notes enable row level security;
