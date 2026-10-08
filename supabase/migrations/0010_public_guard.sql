-- Phase 8 slice: public safety.
-- request_log: one row per request to a guarded route, keyed by a hashed IP, for the
-- per IP hourly limit. It holds no raw IP addresses.
create table request_log (
  id uuid primary key default gen_random_uuid(),
  ip_hash text not null,
  route text not null,
  outcome text not null default 'admitted' check (outcome in ('admitted', 'denied')),
  created_at timestamptz not null default now()
);
create index request_log_ip on request_log (ip_hash, route, created_at);
create index request_log_created on request_log (created_at);
alter table request_log enable row level security;
revoke all on request_log from anon, authenticated;

-- Saved chats are the real analyst runs from development. Reset demo keeps them, and
-- they are what a visitor sees when the spend cap is reached.
alter table chat_sessions add column is_saved_demo boolean not null default false;
update chat_sessions set is_saved_demo = true where kind = 'analyst';
