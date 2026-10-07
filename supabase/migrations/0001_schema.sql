-- QuoteDesk core schema. UUID keys, created_at everywhere, enums as text + CHECK.

create extension if not exists pgcrypto;

create table rfx (
  id uuid primary key default gen_random_uuid(),
  ref text,
  title text not null,
  category text not null,
  buyer_org text not null,
  status text not null default 'draft' check (status in ('draft', 'issued')),
  is_saved_demo boolean not null default false,
  delivery_location text,
  payment_terms_requested_days int,
  validity_days int,
  gst_basis_requested text check (gst_basis_requested in ('excl_gst', 'incl_gst')),
  currency text not null default 'INR',
  issued_at timestamptz,
  created_at timestamptz not null default now()
);

create table rfx_lines (
  id uuid primary key default gen_random_uuid(),
  rfx_id uuid not null references rfx(id) on delete cascade,
  code text not null,
  section text not null,
  description text not null,
  spec text,
  uom text not null check (uom in ('piece', 'kg', 'sq m', 'roll', 'set', 'plate', 'pallet')),
  annual_qty numeric not null check (annual_qty > 0),
  last_year_rate_inr numeric,
  is_one_time boolean not null default false,
  sort int not null,
  created_at timestamptz not null default now(),
  unique (rfx_id, code)
);

create table questionnaire_questions (
  id uuid primary key default gen_random_uuid(),
  rfx_id uuid not null references rfx(id) on delete cascade,
  code text not null,
  text text not null,
  answer_type text not null check (answer_type in ('bool', 'number', 'date', 'text', 'choice')),
  is_knockout boolean not null default false,
  pass_rule jsonb,
  sort int not null,
  created_at timestamptz not null default now(),
  unique (rfx_id, code)
);

create table vendors (
  id uuid primary key default gen_random_uuid(),
  rfx_id uuid not null references rfx(id) on delete cascade,
  vendor_key text,
  name text not null,
  legal_name text,
  contact_email text,
  location text,
  created_at timestamptz not null default now()
);

create table vendor_messages (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  received_at timestamptz,
  subject text,
  body_text text,
  arrival_day int check (arrival_day between 1 and 9),
  created_at timestamptz not null default now()
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  message_id uuid references vendor_messages(id) on delete set null,
  filename text not null,
  mime text not null,
  size_bytes int,
  storage_path text not null,
  sha256 text not null,
  kind text check (kind in ('quote', 'questionnaire', 'certificate', 'profile', 'other')),
  kind_confidence numeric check (kind_confidence between 0 and 1),
  status text not null default 'received' check (status in ('received', 'classified', 'extracted', 'failed')),
  error text,
  created_at timestamptz not null default now()
);
create unique index documents_vendor_sha on documents (vendor_id, sha256);

create table extractions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  model text not null,
  prompt_version text not null,
  raw_json jsonb,
  tokens_in int,
  tokens_out int,
  est_cost_inr numeric,
  status text not null check (status in ('ok', 'repaired', 'invalid', 'failed')),
  is_stored_result boolean not null default false,
  created_at timestamptz not null default now()
);

create table quote_lines (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  rfx_line_id uuid references rfx_lines(id) on delete set null,
  source_document_id uuid references documents(id) on delete cascade,
  vendor_description text,
  quoted_price numeric,
  quoted_uom_text text,
  quoted_currency text,
  price_basis jsonb not null default '{}'::jsonb,
  normalized_price_inr numeric,
  conversion jsonb,
  conditions jsonb not null default '[]'::jsonb,
  status text not null check (status in ('confirmed', 'assumed', 'needs_review', 'conflict', 'missing', 'rejected')),
  confidence numeric check (confidence between 0 and 1),
  evidence jsonb,
  flags text[] not null default '{}',
  assumption_keys text[] not null default '{}',
  match_confidence numeric,
  match_reason text,
  created_at timestamptz not null default now()
);
create index quote_lines_vendor on quote_lines (vendor_id);
create index quote_lines_line on quote_lines (rfx_line_id);

create table vendor_terms (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null unique references vendors(id) on delete cascade,
  freight_terms text not null default 'unknown' check (freight_terms in ('included', 'extra', 'unknown')),
  freight_note text,
  freight_amount_inr numeric,
  payment_terms_days int,
  validity_until date,
  validity_text text,
  stated_total_inr numeric,
  stated_total_evidence jsonb,
  gst_basis text check (gst_basis in ('excl_gst', 'incl_gst', 'unknown')),
  conditional_discounts jsonb not null default '[]'::jsonb,
  unit_definitions jsonb not null default '[]'::jsonb,
  suspicious_content jsonb not null default '[]'::jsonb,
  global_notes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table questionnaire_answers (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  question_id uuid not null references questionnaire_questions(id) on delete cascade,
  answer_raw text,
  answer_value jsonb,
  status text not null check (status in ('answered', 'partial', 'unanswered', 'conflicting')),
  evidence jsonb,
  source_document_id uuid references documents(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (vendor_id, question_id)
);

create table review_items (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  quote_line_id uuid references quote_lines(id) on delete cascade,
  document_id uuid references documents(id) on delete cascade,
  kind text not null,
  severity text not null check (severity in ('info', 'warn', 'block')),
  message text not null,
  value_at_stake_inr numeric,
  state text not null default 'open' check (state in ('open', 'resolved', 'dismissed')),
  resolution jsonb,
  created_at timestamptz not null default now()
);

create table corrections (
  id uuid primary key default gen_random_uuid(),
  quote_line_id uuid not null references quote_lines(id) on delete cascade,
  field text not null,
  old_value jsonb,
  new_value jsonb,
  reason text not null,
  created_at timestamptz not null default now()
);

create table assumptions (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  label text not null,
  value jsonb not null,
  scope text not null check (scope in ('global', 'vendor', 'line')),
  vendor_id uuid references vendors(id) on delete cascade,
  rfx_line_id uuid references rfx_lines(id) on delete cascade,
  set_by text not null check (set_by in ('system', 'buyer')),
  note text,
  created_at timestamptz not null default now()
);
create unique index assumptions_key_scope on assumptions (key, scope, coalesce(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(rfx_line_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table chat_sessions (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'analyst' check (kind in ('analyst', 'rfx')),
  scenario jsonb,
  created_at timestamptz not null default now()
);

create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references chat_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool')),
  content jsonb not null,
  tool_calls jsonb,
  created_at timestamptz not null default now()
);

create table eval_runs (
  id uuid primary key default gen_random_uuid(),
  metrics jsonb not null,
  details jsonb,
  created_at timestamptz not null default now()
);

create table usage_log (
  id uuid primary key default gen_random_uuid(),
  route text not null,
  model text,
  tokens_in int,
  tokens_out int,
  est_cost_inr numeric,
  session_id uuid,
  ip_hash text,
  created_at timestamptz not null default now()
);
create index usage_log_created on usage_log (created_at);
create index usage_log_ip on usage_log (ip_hash, created_at);
