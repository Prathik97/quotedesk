-- Read models for the grid and the analyst SQL tool. First cut; refined in phase 3.
-- Every RFx line x vendor pair appears; a pair with no quote line is 'missing', never zero.

create view comparison_view as
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
  q.conditions
from rfx r
join rfx_lines l on l.rfx_id = r.id
join vendors v on v.rfx_id = r.id
left join lateral (
  select * from quote_lines q
  where q.vendor_id = v.id and q.rfx_line_id = l.id and q.status <> 'rejected'
  order by q.created_at desc
  limit 1
) q on true;

create view vendor_summary_view as
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
  t.stated_total_inr
from vendors v
join comparison_view c on c.vendor_id = v.id
left join vendor_terms t on t.vendor_id = v.id
group by v.id, v.rfx_id, v.name, t.freight_terms, t.payment_terms_days, t.stated_total_inr;

create view award_input_view as
select
  c.rfx_id,
  c.rfx_line_id,
  c.line_code,
  c.section,
  c.annual_qty,
  c.last_year_rate_inr,
  c.vendor_id,
  c.vendor_name,
  c.normalized_price_inr,
  c.annual_value_inr,
  c.status,
  c.conditions,
  t.freight_terms
from comparison_view c
left join vendor_terms t on t.vendor_id = c.vendor_id
where c.status in ('confirmed', 'assumed', 'needs_review', 'conflict');
