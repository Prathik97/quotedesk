-- Phase 2: extraction support.

-- Dev cache for model responses, keyed on everything that changes the output:
-- stage, model, prompt version, document sha256 and a hash of the context
-- (RFx lines). A hit returns a stored REAL response and is always labelled.
create table llm_cache (
  key text primary key,
  stage text not null,
  model text not null,
  prompt_version text not null,
  document_sha256 text not null,
  response_text text not null,
  usage jsonb not null,
  created_at timestamptz not null default now()
);
alter table llm_cache enable row level security;

alter table usage_log add column run_id uuid;
alter table usage_log add column document_id uuid;
alter table usage_log add column stage text;
alter table usage_log add column cache_hit boolean not null default false;
alter table usage_log add column cache_read_tokens int;
alter table usage_log add column cache_write_tokens int;
create index usage_log_session on usage_log (session_id);

-- Facts read from certificates and profiles (number, legal name, dates), plus
-- deterministic attachment flags (expired, name_mismatch).
alter table documents add column facts jsonb;
alter table documents add column flags text[] not null default '{}';
alter table documents add column source_note text;

alter table quote_lines add column source_type text;
alter table vendor_terms add column letterhead_name text;
alter table vendor_terms add column flags text[] not null default '{}';

alter table extractions add column cache_hit boolean not null default false;
alter table extractions add column stage text;
alter table extractions add column run_id uuid;

revoke all on llm_cache from anon, authenticated;
