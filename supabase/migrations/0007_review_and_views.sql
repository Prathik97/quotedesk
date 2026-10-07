-- Phases 3 and 4: buyer overrides, corrections that can also record vendor level actions,
-- stable fingerprints so a dismissed review item stays dismissed across recomputes,
-- and read model refinements. Views are replaced in place (new columns appended) so
-- the grants given to quotedesk_ro in 0004 are kept.

-- The buyer's current effective changes to one quote line. The extracted fields
-- (quoted_price, quoted_uom_text, evidence) are never overwritten; recompute reads
-- both. The corrections table is the audit log of how overrides came to be.
alter table quote_lines add column overrides jsonb not null default '{}'::jsonb;

alter table corrections alter column quote_line_id drop not null;
alter table corrections add column vendor_id uuid references vendors(id) on delete cascade;
alter table corrections add column review_item_id uuid references review_items(id) on delete set null;
alter table corrections add column action text;
create index corrections_line on corrections (quote_line_id);

alter table review_items add column fingerprint text;

create or replace view comparison_view as
select
  r.id as rfx_id,
  l.id as rfx_line_id,
  l.code as line_code,
  l.section,
  l.description,
  l.uom,
  l.annual_qty,
  l.last_year_rate_inr,
  l.sort,
  v.id as vendor_id,
  v.name as vendor_name,
  q.id as quote_line_id,
  q.quoted_price,
  q.quoted_uom_text,
  q.quoted_currency,
  q.normalized_price_inr,
  case when q.normalized_price_inr is not null then q.normalized_price_inr * l.annual_qty end as annual_value_inr,
  case when q.normalized_price_inr is not null and l.last_year_rate_inr > 0
       then (q.normalized_price_inr / l.last_year_rate_inr - 1) * 100 end as delta_vs_ly_pct,
  coalesce(q.status, 'missing') as status,
  q.confidence,
  coalesce(q.flags, '{}') as flags,
  coalesce(q.assumption_keys, '{}') as assumption_keys,
  q.conditions,
  q.source_type,
  coalesce((q.overrides->>'verified')::boolean, false) as buyer_verified,
  q.match_confidence
from rfx r
join rfx_lines l on l.rfx_id = r.id
join vendors v on v.rfx_id = r.id
left join lateral (
  select * from quote_lines q
  where q.vendor_id = v.id and q.rfx_line_id = l.id and q.status <> 'rejected'
  order by q.created_at desc
  limit 1
) q on true;

create or replace view vendor_summary_view as
select
  v.id as vendor_id,
  v.rfx_id,
  v.name as vendor_name,
  count(*) filter (where c.status <> 'missing') as lines_quoted,
  count(*) as lines_total,
  count(*) filter (where c.status = 'confirmed') as confirmed,
  count(*) filter (where c.status = 'assumed') as assumed,
  count(*) filter (where c.status = 'needs_review') as needs_review,
  count(*) filter (where c.status = 'conflict') as conflict,
  count(*) filter (where c.status = 'missing') as missing,
  (select count(*) from documents d where d.vendor_id = v.id) as attachment_count,
  (select count(*) from review_items ri where ri.vendor_id = v.id and ri.state = 'open') as open_review_items,
  t.freight_terms,
  t.payment_terms_days,
  t.stated_total_inr,
  case
    when 'questionnaire_failed' = any(t.flags) then 'Failed'
    when 'questionnaire_pending' = any(t.flags) then 'Pending'
    when 'questionnaire_cleared' = any(t.flags) then 'Cleared'
  end as questionnaire_result,
  t.freight_amount_inr,
  (select count(*) from review_items ri where ri.vendor_id = v.id and ri.state = 'open' and ri.severity = 'warn') as open_warnings
from vendors v
join comparison_view c on c.vendor_id = v.id
left join vendor_terms t on t.vendor_id = v.id
group by v.id, v.rfx_id, v.name, t.freight_terms, t.payment_terms_days, t.stated_total_inr, t.flags, t.freight_amount_inr;
