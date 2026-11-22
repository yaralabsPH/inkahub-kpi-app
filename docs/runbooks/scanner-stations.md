# Runbook: F6 shared scanner stations

Spec `docs/specs/scanner-stations.md`, plan `docs/plans/scanner-stations.md`.
Staging only until the bulk release. The classic station is always the fallback.

## What it does

One wall device ("receiver") on `/production` accepts up to three cordless
scanners. A person scans their badge on a scanner, then scans orders. Each
order saves every framed line (A0 and A1–A4/GW sets) for that person with no
taps: one `line_verified` per SKU, one `completed` per work type, and for A0
the component deduction plus F4 automatic packaging — all in one database
transaction. Green on the wall means the server saved it.

## Scanner programming (each scanner, once)

| Setting | S1 | S2 | S3 |
|---|---|---|---|
| Prefix | `<S1>` | `<S2>` | `<S3>` |
| Suffix | `</S1>` then Enter (CR) | `</S2>` then Enter | `</S3>` then Enter |
| Mode | USB-HID keyboard, US layout | same | same |
| Inter-character delay | none / minimum | same | same |

Whole frame example: `<S1>10190203</S1>⏎`. The receiver rejects anything
else (no prefix, wrong/mismatched id, nested frames, over 48 characters, a gap
over 120 ms inside a frame, more than 1.5 s for a frame). After any rejected
burst it ignores keys until 400 ms of silence. A garbled stream whose source
is unknown signs **every** scanner out. Scanner ids are configurable on the
setup screen (1–4 capital letters/digits starting with a letter, max three).

## Test barcodes (staging)

| Scan | Meaning |
|---|---|
| An active 8-hex badge, e.g. `A1B2C3D4` | Sign in (online only); clocks in once per site workday (04:00 site-local) |
| `190203` (6 digits) | Order `10190203` (legacy packing slip: "10" is always added) |
| `#10190203` | Order `10190203`, explicitly not a badge |
| `10190203` (8 digits) | Badge first. Online: if no active badge matches, it is that order. **Offline: rejected and the scanner is signed out** (could be either) |
| anything else | Rejected |

Issue synthetic staging badges in Settings → Team members; use real staging orders.

## Daily use

1. Open `/production?persist=1` on the receiver with an owner, manager or
   kiosk account (the `persist` marker keeps the login across restarts).
2. First time: gear → **Shared scanners (wall receiver)** → name it → Turn on.
3. Tap **Start station** once (enables sound and keeps the screen awake where
   the browser supports the Wake Lock API; the header shows if it does not).
4. Badge, then orders. Identities end after **10 minutes without a framing
   scan**, on reload, and when the account, site or scanner list changes.
5. **Classic station** (tap twice) switches back; queued scans stay stored.

Results: green SAVED (person · order · pieces) · amber QUEUED (stored on the
device, not yet saved) · orange ALREADY RECORDED (no extra credit; check on
classic) · red NOT SAVED (reason shown; distinct error sound).

## Orders that go to the classic station

Blank/legacy/canvas SKU, odd quantity, single gallery-wall SKU, no framed
line, cancelled, "Edit Order"/"oe-staff-edit" tag, open CS case (new/query/
approved), Shopify did not return the complete exact order, existing or
partial framing/dispatch work, A0 without F4 auto mode or without a resolved
box prediction, missing stock code, stock already charged, packaging that
could not be posted, stock floor refusal. Nothing is written for any of them.

## Packaging prerequisites (A0)

The site must be in F4 **automatic** box mode with an active rule set whose
prediction for the order's A0 parcel is fully resolved. The receiver never
overrides the prediction. Regular framed work deducts nothing here (Dispatch
still does). Real rules are a commissioning task, not set by this feature.

## Offline and recovery

- Offline: orders for an already signed-in person queue (amber). Badges
  cannot sign in. Storage failure is red NOT SAVED, never accepted.
- Unknown outcome (sent, no answer): the job keeps its request id and exact
  payload and is re-sent; the server answers from its receipt. Never enter
  such an order on the classic station while it shows "awaiting answer".
- Blocked jobs list the reason. **Retry** re-sends the same request (or
  re-checks the order if nothing was sent yet). **Recorded on classic** (tap
  twice) removes it after you recorded it on the classic station.
- Jobs drain only under the same account, site and receiver that scanned
  them. Up to 200 unfinished jobs per device; then new scans are refused.
- Do not clear browser data on the receiver while anything is queued.

## Kiosk start-up (OS level; web code cannot do this)

- Windows: shortcut in `shell:startup` to
  `chrome.exe --kiosk --app=https://<preview-or-site>/production?persist=1`.
  Disable sleep in Power settings; Wake Lock only covers the screen while the
  page is visible.
- Android/ChromeOS: use the device's managed kiosk/app-pinning feature.
- Keep the receiver signed in with a dedicated kiosk account.

## Health

Owners/managers see **Shared scanner receivers** on Welcome: one row per
receiver page with heartbeat (every minute), last accepted scan, queue and
blocked counts. Red when the heartbeat is over 3 minutes old (page closed,
asleep or offline) or scans are blocked; amber when no scan for 30 minutes
during site-local weekday 08:00–18:00 (code default), or scans are waiting.
No email, cron or history; the receiver's own warnings do not notify anyone.

## Physical commissioning checklist (not done by this feature)

- [ ] Buy/pair three scanners; program prefix/suffix above; confirm US layout.
- [ ] Range test across the framing area; note dead spots.
- [ ] Interleaving test: all three scanners at once, 50 scans each; every
      result must be one green per scan or a loud red, never a wrong person.
- [ ] Battery/charging routine; spare scanner labelled and programmed.
- [ ] Real F4 A0 rules activated and checked on real A0 orders at the site.
- [ ] Receiver start-up after power loss: auto-starts, stays signed in.
- [ ] Staff briefing: badge first, 10-minute rule, amber vs green, classic fallback.

## Rollback

Tap **Classic station** on the receiver (or clear the device setting): the
classic flow is unchanged. Redeploying the previous Preview removes the mode;
0055 stays (expand-only; the old app ignores it, and the replaced
`deduct_inventory_for_event` answers the old app with the same keys).
Queues, receipts and history are kept.
