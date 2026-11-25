-- item-counting · remove the synthetic volume history (STAGING ONLY).
-- Deletes only rows created by 02-volume.sql (id prefix 'vol-' and the
-- synthetic note). Keeps the au/uk/us sites, memberships, barcodes and
-- products from 01-sites.sql, which later staging checks still use.

begin;

do $$
begin
  if not exists (select 1 from public.locations where key = 'staging')
     or exists (select 1 from public.locations where key = 'default')
  then
    raise exception 'Refusing to run: this database does not look like the staging project';
  end if;
end $$;

delete from public.production_events
where id like 'vol-%' and note = 'item-counting synthetic volume';

select count(*) as synthetic_rows_left
from public.production_events where id like 'vol-%';

commit;
