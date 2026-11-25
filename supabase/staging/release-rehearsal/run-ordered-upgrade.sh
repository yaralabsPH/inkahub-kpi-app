#!/usr/bin/env bash
# Release rehearsal G3: apply the release migrations one file at a time, unchanged, in number order,
# with a bounded lock/statement timeout, stop on the first error, and log server-side start/end times
# in rehearsal.log (a scratch schema outside public).
#
# STAGING ONLY. Usage: run-ordered-upgrade.sh <staging-project-ref> <workdir-for-run-files>
# Needs the Supabase CLI (logged in). Refuses the live project ref.
set -u
REF=${1:?staging project ref}; OUT=${2:?work dir}
[ "$REF" = "lkboboagiikvozvbcpvg" ] && { echo "refusing: that is the LIVE project"; exit 2; }
ROOT=$(git rev-parse --show-toplevel)
mkdir -p "$OUT"
q() { timeout 600 supabase db query --remote="$REF" --yes "$@" 2>&1 | grep -v "new version\|recommend updating"; }

q "create schema if not exists rehearsal; create table if not exists rehearsal.log(file text, phase text, ts timestamptz default clock_timestamp(), note text);
   revoke all on schema rehearsal from public, anon, authenticated;" > /dev/null

for f in $(ls "$ROOT/supabase/migrations" | grep -E '^00(3[4-9]|4[0-7]|5[2-9]|6[0-2])_' | sort); do
  name=${f%.sql}
  {
    echo "set lock_timeout = '10s';"
    echo "set statement_timeout = '600s';"
    echo "insert into rehearsal.log(file, phase) values ('$name','start');"
    cat "$ROOT/supabase/migrations/$f"
    echo ""
    echo ";"
    echo "insert into rehearsal.log(file, phase) values ('$name','end');"
  } > "$OUT/$name.run.sql"
  res=$(q -f "$OUT/$name.run.sql")
  if echo "$res" | grep -q '"_tag":"Error"'; then
    echo "$name FAILED"; echo "$res" | tail -2 | cut -c1-1500; exit 1
  fi
  echo "$name ok sha256=$(git -C "$ROOT" show HEAD:supabase/migrations/$f | sha256sum | cut -c1-64)"
done
q --read-only "select s.file, round(extract(epoch from e.ts - s.ts)*1000)::int ms from rehearsal.log s join rehearsal.log e on e.file=s.file and e.phase='end' where s.phase='start' order by s.file"
echo ALL_DONE
