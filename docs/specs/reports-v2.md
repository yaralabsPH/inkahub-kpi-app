# F8 Reports v2 specification

Use the existing Reports page for day, Monday-based week, month and custom periods, per person and managed business department. Show normal Items and distinct Orders, rework separately, a daily trend, person and department summaries, and a summary CSV matching selected filters. Use the site's timezone and 04:00 production-day boundary. Preserve F7 raw CSV attribution, order lookup and F4 packaging cards.

F1 already stores full event images in reporting_private.source_versions, including F5 department snapshots. Reuse checked_generation and sel_eval, joining source_versions at the SAME generation sequence. Do not create another snapshot pipeline or counting reducer. F1 effective/reversed/qualification/counting rules remain authoritative. Whole-period Orders are distinct (order_key, case_id) identities; never add daily or group subtotals. Historical department uses the event's recorded ID and name, never the person's current assignment. Group stable department IDs and expose recorded names on rename. Missing snapshots are Unknown. Manual dispatch attribution creates no framing item credit.

Return aggregates from additive0057 service-only SQL RPCs through api/reports/overview.ts. No months of raw events downloaded to the browser. Bound requests to731 production dates; fail explicitly on exceptional person/department cardinality rather than silently truncating1000 rows. Use a small pure module for the result contract and CSV formatting. CSV must neutralize spreadsheet formula prefixes.

Authorization uses verified JWT and current profile/memberships. Owner can choose AU/UK/US; manager is limited to assigned sites; staff is forced to their own identity and a forged person selection is refused; CS needs explicit Reports navigation permission and an assigned site; kiosk is denied. No payroll fields. Staff may receive Reports in default navigation while explicit administrator overrides remain authoritative. Restricted staff/CS views must not mount old full-team/payroll hooks: split the wrapper before those hooks run.

Clear data immediately on request identity changes; abort or ignore late responses. Show loading, useful empty/not-ready states and error with Retry. Display publication cutoff and generation. Missing publication must not fall back to a raw-history download. Preview scheduling is inactive, so freshness must be honest.

Meaningful checks: F1 set/UN parity; period order dedup; historical department move/rename/Unknown; cancellation/rework/manual attribution; filter/CSV parity and formula escaping; 04:00, Monday and DST; site/person forgery and kiosk/CS direct API restrictions; stale response; more than1000 source events. Use the existing PGlite harness with only necessary new prerequisites. Root also runs real staging SQL rollback assertions and hosted role/UI checks.

## Acceptance and operational scope

This is the roadmap's F8, stacked after item-counting-integration. The spec is approved by CJ's explicit delegation to decide and implement the next three features with Claude. Routine implementation choices are delegated. Do not invoke /loop or wait for sleeping CJ.

Supabase is the supported multi-user report backend; Dexie keeps its existing Reports behavior and does not pretend to have server-published generations. No repository interface changes are necessary. New SQL is append-only after installed 0056 (0048-0051 remain reserved for F3). Use the repository's numbered migration convention; existing migration bytes must not change.

Data and privacy: no staff access to another person's activity or payroll through either API or legacy hooks; current database profile/membership is authoritative. No user_metadata authorization. CS access requires explicit allowed_nav. Owner/manager period reports remain bounded and may fail visibly on exceptional cardinality. Audit invalid inputs and failures without raw event payloads/tokens.

Accessibility: labelled controls, keyboard-operable filters/CSV/retry, readable empty/error/loading states. No chart dependency: a small table or CSS daily bars suffices. Preserve existing screen layout.

Release: root applies reviewed additive SQL only to ybrzhrgfrnvtcwymjdrq and tests roles, pinned-generation results and a historical department fixture in a rollback transaction. Root deploys only the existing isolated Preview with staging env after app checks. Previous Preview remains rollback. No production changes. No new refresh crons on Hobby; staleness stays visible. Initial AU publication is a separate operator task; don't claim unavailable generations are ready.

Hardening covers input bounds, server authorization, immutable history, source/stock untouched, stale-response isolation, CSV escaping, useful retry states, no secrets, no raw-history fanout, exact period order dedup and no new dependency.
