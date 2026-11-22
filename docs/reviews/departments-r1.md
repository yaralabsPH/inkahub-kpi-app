# F5 review R1 — changes requested

Fresh reviewer `/root/review_f5_implementation` inspected fixed delta `bc8f2b8..b1b7e4a` read-only. No tests or database execution claimed. Codex accepts these two findings for one focused Claude fix pass before staging acceptance.

## P1: Bind owner state to the actual auth session

`src/components/departments/DepartmentsCard.tsx:32-33`; `src/lib/hooks/useDepartments.ts:139-147,165-174`.

AuthProvider retains A's profile while fetching B's after a direct account change; AuthGate accepts that mismatched profile. B can temporarily see A's cached department/history/audit data. If both are owners, unkeyed OwnerPanel retains A's form, pending request and mutation state when B's profile arrives. Retrying then executes under B's different receipt namespace. Late A responses remain accepted because panel never unmounted. Server owner checks protect mutations, not cached UI.

Fix narrowly: require a live session with user ID matching loaded owner profile; key OwnerPanel by that ID; make pending response/cache cleanup follow session changes. Avoid broad AuthProvider refactor. Regression: direct A->non-owner and A->owner with delayed profile and outstanding/unknown mutation hides A's data immediately, discards its answer and never carries Retry into B.

## P2: Freeze control-switch confirmation intent

`src/components/departments/DepartmentEditor.tsx:269-270,292-310`.

An open confirmation derives target `!enabled` from live query state and does not close after success. ON followed by refetch becomes ready-to-submit OFF with the same reason. More seriously, a lost ON response followed by successful ON read makes retry submit OFF under a new request. Another owner's change can also reverse the open intent.

Fix narrowly: capture intended target and expected version when opening; close/reset on confirmed success. External updates invalidate/reconfirm without reversing intent. Unknown retries preserve original payload/ID. Regressions: success, lost reply followed by successful read, concurrent owner toggle; none produces unintended opposite mutation.

## Nonblocking observations and limits

- Task5 explicitly permits changed-input/new-ID behavior; no generalized persistent mutation framework is requested. Consider explicit abandonment warning for unresolved requests while fixing the control switch, without new scope.
- People/Members currently fetch all RPC pages before showing the list. RPC pages are bounded, no truncation; history/audit incremental. Prefer small Load more fix using existing paged hook if straightforward, otherwise record deviation for synthetic Preview. No production-scale benchmark required now.
- No consequential SQL defect found statically. Archive current-archived_at simplification is consistent with mutation invariants; builtin sha256 choice is reasonable. Actual Supabase ownership, roles, concurrency and rollback still require execution evidence.

After Claude commits fixes, ask same reviewer for focused delta review and run appropriate new regressions plus final feature gate. Root records actual staging evidence separately.

## P1: Supabase migration execution fails before resolver trigger creation

Actual staging rollback-only execution under Supabase postgres (NOSUPERUSER, CREATEROLE) at ~20:43:
- 0052 sha256 fb86f6628f27191dce303a88d212a4f2b7a721e386a2346c5a2655d586c16b02 executes.
- 0053 sha256 cc7301877a146f7a62dad8cd93b066f88799a239275f73d254f91a5f754e89c3 executes.
- 0054 fails SQLSTATE42501: permission denied for function departments_private.resolve_event.
- Root rolled back all DDL; NONE of F5 is applied persistently.

Root cause: 0054 transfers resolve_event ownership, revokes temporary departments_resolver membership from CURRENT_USER, then tries to CREATE TRIGGER using that function. Migration postgres is not superuser and no longer has EXECUTE at trigger creation.

Diagnostic proof without editing source: ran all three source migrations in one staging BEGIN/ROLLBACK, stripping only their outer BEGIN/COMMIT; moved the single `REVOKE departments_resolver FROM CURRENT_USER;` to AFTER trigger creation in the in-memory 0054 SQL. All migrations executed, operator function EXECUTE was false after revocation, and an actual authenticated synthetic kiosk inserting a clock event for synthetic staff succeeded with business_department_status=disabled and snapshot_version=1. Rolled back all DDL and the test row. Source files remained unchanged.

Required fix: move that temporary membership revocation after all CREATE TRIGGER statements and before COMMIT. This newly introduced 0054 migration has never been applied or released; correcting this candidate file is authorized. Do not modify older/applied migrations. Add a targeted structural ordering regression and record actual non-superuser staging proof. Rerun unchanged committed final SQL in rollback-only mode before persistent apply. Do not grant client EXECUTE or permanently widen privileges as workaround.
