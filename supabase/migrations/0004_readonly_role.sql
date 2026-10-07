-- Read only role for the analyst SQL tool. The password placeholder is replaced
-- at migrate time with a random value that is written only to .env.local.
-- Views run with their owner's rights, so granting the views is enough; the
-- base tables stay closed to this role.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'quotedesk_ro') then
    create role quotedesk_ro login password '__RO_PASSWORD__';
  else
    alter role quotedesk_ro login password '__RO_PASSWORD__';
  end if;
end $$;

alter role quotedesk_ro set default_transaction_read_only = on;
alter role quotedesk_ro set statement_timeout = '5s';
alter role quotedesk_ro set idle_in_transaction_session_timeout = '10s';

grant usage on schema public to quotedesk_ro;
grant select on comparison_view, vendor_summary_view, award_input_view to quotedesk_ro;
