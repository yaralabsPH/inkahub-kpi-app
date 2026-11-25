# Runbook: F7 dispatch flow (shared scanners in dispatch mode)

Builds on the F6 shared receiver (`docs/runbooks/scanner-stations.md`):
same receiver page, scanners, prefixes/suffixes, queue, health card and
Start gesture. Supabase only; owner, manager or kiosk account.

## Turn it on

/production → department picker → **Shared scanners** → choose
**Dispatch (badge once per shift, then order slips)** → Turn on. An F6
receiver can be switched any time with the header button **Dispatch mode /
Framing mode** (tap twice). Switching signs everyone out; scans already
queued keep the mode they were scanned in and are still saved.

## Daily use

1. The dispatcher scans their badge on a scanner once. The scanner shows
   their name and **Dispatching until HH:MM** — the next 04:00 site workday
   change or twelve hours, whichever is first. There is no 10-minute idle
   sign-out in dispatch mode. A new clock-in for the workday is recorded as
   dispatch work; an existing clock-in (e.g. from framing) is left alone.
2. Scan each order slip (6-digit code or `#10xxxxxx`). Green **DISPATCHED**
   shows the order, items and **Framed by: Name ✓** for every framed SKU.
3. **Framing scan missing** (amber, with a chooser): pick who framed it (one
   person for all missing lines, or per line) → **Save as manual and
   dispatch**. This records a manual attribution only: no framing scan, time
   or credit is created, and Reports labels it **Manual**. **Check framing
   scans again** re-reads the records (use it if the framer has just scanned).
   Other scans keep saving meanwhile; one waiting order is shown at a time.
4. **Switch worker** (header) signs every scanner out; the next badge scan
   also replaces the person on that scanner.

Anything the shared dispatch does not support goes to the classic dispatch
station with a reason on the screen: picture frames, canvas, legacy or blank
SKUs, gallery-wall singles, cancelled / edited / truncated orders, open
replacement (CS) cases, a stock code missing from the catalogue, the site
not in automatic box mode (when the order packs something at Dispatch), or
box rules that cannot pick. "Already dispatched" adds nothing.

## What a dispatch saves (one transaction, all or nothing)

One `dispatched` event (the dispatcher, Dispatch, total items, the original
scan time) exactly like the classic dispatch completion; the same stock the
classic dispatch deducts (anything already charged for the order — e.g. A0
stock, an accessory shipped from the A0 bench — is skipped, never charged
twice); the F4 Dispatch box (the A0 box is a separate pick, never touched);
one immutable attribution row per framed SKU; a receipt so a retry gets the
same answer. A framing save never blocks the later dispatch; duplicate
framing credit stays blocked. Once the shared scanners dispatched an order,
the classic dispatch station refuses to dispatch it again ("already
dispatched by the shared scanners"); replacement (CS case) dispatches still
work. Framed prints always need their Dispatch box in the save.

## Measured "Framed by"

Same site, same order, same SKU, the CURRENT framing attempt only: an
uncancelled framing verification AND the next completion by the same
person for that work type, for the whole order or that SKU, at or after the
verification, enough quantity, not replacement work. A scrap or cancel of
the order or that line at any time after the verification, or the order
being loaded again at framing after the verification (a reload or reopen),
ends that attempt; a new
attempt counts through its own verification and completion. Two different
framers = needs a choice. A verification alone, someone else's completion,
a completion for another SKU or another site's records never count.
Measured records that arrive before the save win over a manual choice; a
scrap that arrives first makes the save ask for a framer instead.


## Unknown outcome

As F6: amber "outcome not confirmed" means the save may have happened.
Do not record it on the classic station; tap Retry — the identical request
is resent and the receipt answers it. A choice cannot be changed for such
an order.

## Rollback

Switch the receiver to Framing mode or turn shared scanners off (classic
dispatch is unchanged), or return to the previous Preview. 0056 stays: the
previous app never calls it. Queued dispatch jobs are kept on the device
under their own scope and the F6 app never sends them as framing; finish
them on a dispatch-mode receiver or record them on the classic station.
Receipts and attribution rows are never deleted.

## Commissioning (not done overnight)

- Scanners and receiver hardware as in the F6 checklist.
- Dispatch site needs automatic box mode with real dispatch rules for
  framed orders; check one real order of each kind (framed A1-A4, set,
  unframed-only, accessory, A0 + small framed).
- Badge every dispatcher; check names in the chooser list.
- Run `supabase/staging/dispatch-flow` on staging first (README there).
