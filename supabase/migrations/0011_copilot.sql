-- Phase 6: RFx co-pilot drafts, the outbox, and the inbox replay.
--
-- SHARED DEMO RULE: visitors share one database. Drafts live in their own rows (rfx_drafts) and
-- never touch the seeded rfx, rfx_lines, vendors or any extraction table. Anonymous sessions are
-- keyed by a random browser id. Reset demo deletes every draft and every non saved email.

-- One draft per row. state holds the structured RFx (terms, lines, questions), messages the chat.
create table rfx_drafts (
  id uuid primary key default gen_random_uuid(),
  browser_id text not null,
  state jsonb not null,
  messages jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'issued')),
  issued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index rfx_drafts_browser on rfx_drafts (browser_id, updated_at desc);

-- Simulated emails. Nothing is ever sent. is_saved rows belong to the seeded FY27 RFx and are
-- written below without a model call; Reset demo keeps them.
create table outbox_emails (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid references rfx_drafts(id) on delete cascade,
  rfx_id uuid references rfx(id) on delete cascade,
  browser_id text,
  is_saved boolean not null default false,
  vendor_id uuid not null references vendors(id) on delete cascade,
  vendor_key text,
  vendor_name text not null,
  to_email text,
  subject text not null,
  body text not null,
  attachment_filename text not null,
  source text not null check (source in ('saved', 'model', 'template')),
  status text not null default 'sent (simulated)',
  created_at timestamptz not null default now(),
  check ((is_saved and rfx_id is not null and draft_id is null) or (not is_saved and draft_id is not null))
);
create index outbox_draft on outbox_emails (draft_id);
create index outbox_saved on outbox_emails (is_saved);

-- Who has pressed "Simulate vendor replies" in this browser. The replies themselves are the stored
-- real extraction results; this only records that they have been revealed.
create table inbox_reveals (
  browser_id text primary key,
  revealed_at timestamptz not null default now()
);

alter table rfx_drafts enable row level security;
alter table outbox_emails enable row level security;
alter table inbox_reveals enable row level security;
revoke all on rfx_drafts, outbox_emails, inbox_reveals from anon, authenticated;

-- The five saved emails for the seeded FY27 RFx, one per vendor. Fixed text, no model call.
insert into outbox_emails (rfx_id, is_saved, vendor_id, vendor_key, vendor_name, to_email, subject, body, attachment_filename, source)
select
  r.id, true, v.id, v.vendor_key, v.name, v.contact_email,
  'Request for quotation: ' || r.title,
  format(
    E'Dear %s team,\n\n%s invites you to quote for the %s.\n\nPlease price all %s line items in the attached RFx pack, in %s, %s. We ask for %s days payment terms and for your quote to stay valid for %s days. Delivery is to %s.\n\nThe pack also holds a short questionnaire. Please answer it in the same reply, with any certificates attached.\n\nYou may reply in any format that suits you: a spreadsheet, a PDF, a document, a photo of a rate card or plain email text.\n\nThank you,\nProcurement, %s',
    v.name, r.buyer_org, r.title,
    (select count(*) from rfx_lines l where l.rfx_id = r.id)::text,
    r.currency,
    case r.gst_basis_requested when 'excl_gst' then 'excluding GST' when 'incl_gst' then 'including GST' else 'stating clearly whether GST is included' end,
    coalesce(r.payment_terms_requested_days::text, 'your standard'), coalesce(r.validity_days::text, '90'),
    coalesce(r.delivery_location, 'our plant'),
    r.buyer_org
  ),
  'RFx_pack_' || regexp_replace(lower(coalesce(r.ref, 'fy27')), '[^a-z0-9]+', '_', 'g') || '.pdf',
  'saved'
from vendors v
join rfx r on r.id = v.rfx_id
where r.is_saved_demo
order by v.vendor_key;
