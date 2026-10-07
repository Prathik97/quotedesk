-- Phase 5: reference views for the analyst SQL tool, and storage for analyst results.
-- The read only role gets SELECT on views only. Every view here exposes derived or
-- reference data; none exposes raw vendor documents.

create view rfx_lines_view as
select l.code as line_code, l.section, l.description, l.uom, l.annual_qty, l.last_year_rate_inr,
       l.annual_qty * l.last_year_rate_inr as last_year_value_inr, l.is_one_time, l.sort
from rfx_lines l;

create view vendor_terms_view as
select v.vendor_key, v.name as vendor_name, t.freight_terms, t.freight_note, t.freight_amount_inr,
       t.payment_terms_days, t.validity_text, t.stated_total_inr, t.gst_basis, t.conditional_discounts, t.letterhead_name,
       case
         when 'questionnaire_failed' = any(t.flags) then 'Failed'
         when 'questionnaire_pending' = any(t.flags) then 'Pending'
         when 'questionnaire_cleared' = any(t.flags) then 'Cleared'
       end as questionnaire_result
from vendors v
left join vendor_terms t on t.vendor_id = v.id;

-- Open review items only. Suspicious content is the flag, never the raw document.
create view open_issues_view as
select v.vendor_key, v.name as vendor_name, i.kind, i.severity, i.message, i.value_at_stake_inr, l.code as line_code
from review_items i
join vendors v on v.id = i.vendor_id
left join quote_lines q on q.id = i.quote_line_id
left join rfx_lines l on l.id = q.rfx_line_id
where i.state = 'open';

create view assumptions_view as
select a.key, a.label, a.value, a.set_by, a.note
from assumptions a
where a.scope = 'global';

grant select on rfx_lines_view, vendor_terms_view, open_issues_view, assumptions_view to quotedesk_ro;

-- Results of tool calls, so a later turn can export or open "the table from before".
create table analyst_results (
  id text primary key,
  session_id uuid not null references chat_sessions(id) on delete cascade,
  kind text not null,
  title text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index analyst_results_session on analyst_results (session_id, created_at);
alter table analyst_results enable row level security;
revoke all on analyst_results from anon, authenticated;
alter table chat_messages add column if not exists meta jsonb;
