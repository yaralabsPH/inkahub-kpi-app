# Release notes: production item counting (F1, `item-counting`)

For: owners, managers, production leads and anyone who reads Reports, the
Welcome page, the Production bench counter or the daily KPI email.

Spec: [`docs/specs/item-counting.md`](../specs/item-counting.md) · Plan:
[`docs/plans/item-counting.md`](../plans/item-counting.md)

## What changes for you

1. **Every screen and the daily email now count the same way.** Reports,
   Welcome, the Production bench counter and the daily KPI email all use one
   shared set of rules on the same saved scans. For the same site, person,
   department and day they show the same Items and Orders.

2. **Unframed (UN) prints now count as Items.** Before, UN work counted only
   towards Orders. Now every produced piece counts:
   - a single print is 1 Item;
   - a set print counts every piece (two S2 sets = 4 Items);
   - framed prints and picture frames are counted as before.

   Hooks, gift cards, free prints, packaging and canvas (SC) lines are
   expected exclusions; they are not Items and are not reported as errors.

3. **History is recalculated, not migrated.** Older days are shown with the
   new rules, so past totals (especially for unframed work) will be higher
   than the figures you saw before. Nothing saved was changed.

4. **Orders are completed orders, counted once.**
   - An order counts when it is completed (framing stations) or dispatched
     (dispatch station).
   - Completing the same order twice the same day is still one Order.
   - Across departments, the site total counts each order once. Each
     department's Orders overlap, so departments do not add up to the total.
     The email's headline "Orders completed" is now this distinct total; it
     used to add up the departments.
   - An order that contains only excluded lines (for example, hooks only)
     is not counted.

5. **Undo is exact.** Unverifying a line removes exactly that saved line's
   Items, on the day it was originally verified, whoever undoes it. A
   correction never makes the next day negative.

6. **CS / rework is separate.** Replacement work scanned under a CS case is
   shown on its own (rework Items and Orders) and is not added to normal
   output. Two cases on the same order stay separate. Rework scanned without
   a case tag cannot be told apart from normal work; this is stated on the
   screens.

7. **Days run from 04:00 to 04:00 at the site.** AU uses Sydney time, UK
   London and US Chicago, including daylight-saving changes. Your browser's
   own timezone no longer matters. Screens show the production window and
   timezone.

8. **"All departments" Items are work processed.** A piece verified at
   framing and again at dispatch counts at both, so the combined figure is
   labelled "work processed across selected work types", not unique goods.

9. **Reports, counters and emails say "as of".** Each view shows when its
   numbers were read. A scheduled email sent before the day closes at 04:00
   says "as of … (day not yet closed)"; a re-run after closing says
   "final".

10. **Problems are shown, not hidden.**
    - A read that fails shows "couldn't load" with Retry, or the last good
      numbers marked stale. It never shows a zero.
    - Data problems (unrecognised SKUs, missing quantities, completions
      without line detail, corrections that cannot be matched, possible
      repeated scans) are counted and shown as "totals may be incomplete".
    - Staff accounts see only their own records, and this is labelled.

11. **Production bench counter.** After each saved verify, unverify,
    completion or dispatch, the bench re-reads the counter from saved scans
    instead of adding locally. It may show "Updating…" for a moment. If the
    read fails, the scan stays saved and the counter offers Retry.

12. **Welcome page.**
    - Department cards show today so far. The "vs" badge compares with the
      same weekday last week and names that date (it compared with the wrong
      day before).
    - Streaks count consecutive days, ending today, with the same top worker.
    - "Most improved" compares yesterday with that person's working days in
      the week before.

13. **Daily email and workbook.**
    - Same Summary / Departments / Staff / Notes sheets, with extra columns
      for rework, data warnings, production window, timezone, status and
      as-of/loaded/generated times.
    - A day with only rework, or only data warnings, is no longer skipped as
      "no activity".

## What does not change

- Framing time, average minutes per unit, cost and effort use the same
  timing rules as before. UN Items do not enter these denominators.
- Stock deduction, packaging selection, the ledger, benchmarks, rates and
  timesheets are not changed. Capture writes exactly the same saved events.
- Raw CSV exports keep the original saved quantities and timestamps.
- Order lookup, the owner's Remove action, notes and the other Reports cards
  (live completions, package usage and history, daily timesheet) work as
  before. Package usage keeps its existing date window.
- Digest security (bearer secret, GET only, recipient allowlist, no-store)
  and its schedules are unchanged.

## Limits you should know about

- **Unknown history cannot be rebuilt.** Old scans without line detail,
  quantities or case tags are counted as far as possible and flagged; they
  are never guessed.
- **Three Dashboard/Reports side cards still use their own counts:**
  - "Labour hours today" (orders per worker, cost per order) counts
    completion rows;
  - "Recent activity" adds up raw quantities;
  - "Package history" divides packages by its own order counts.

  These were outside F1's scope and are listed as an open question in the
  plan.
- **Speed (staging, worst-case busy site).** Loading three months for AU
  takes about 4–6 seconds (target 10 s) and a busy day about 1.3 seconds
  (target 2 s); other sites take under 1 second. The bench counter re-reads
  the whole site-day after each save, which takes about 1–1.5 seconds at the
  busiest site.
- **`default` and `staging` locations** have no production timezone, so
  counts show as unavailable there.

## Before release (CJ)

1. **Set `SUPABASE_SERVICE_ROLE_KEY` in Vercel Production (and Preview).**
   The digest no longer falls back to the anon key; without the server key
   every report returns 500 instead of a misleading empty report.
2. Apply migrations **0034, 0035 and 0036** to production in number order and
   verify them (definitions, grants, the two `production_events` SELECT
   policies and their hash), **before** deploying the app. See the plan's
   "CJ's release sequence".
3. On a Preview, download `dry=1` digests for AU, UK and US for a fixed date.
   This checks that the server-side shared imports load. Then complete the
   plan's staging checklist.
4. New digest responses to know about:

   | Status | Cause |
   |---|---|
   | 400 `Invalid date` | `date` is not a real `YYYY-MM-DD` date, is blank, or is repeated |
   | 500 `Full-site report needs SUPABASE_SERVICE_ROLE_KEY` | The server key is missing |
   | 500 | An evidence or side read failed (nothing is generated or sent) |

## Rollback

Restore the previous S1-protected deployment in Vercel. Leave migrations
0034, 0035 and 0036 in place: the old app works on the new schema, and
saved scans are unchanged. A policy problem from 0036 has its own reviewed
rollback migration in the plan ("Policy rollback"); restoring the old
policies brings back their slower reads.
