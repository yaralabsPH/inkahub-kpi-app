/**
 * Task 13 Part B1: batch identity/drift, candidate rebuild (begin/copy/freeze)
 * and lease renewal/takeover/abandon in the 0038 draft, plus the typed
 * wrappers and pure references in api/_lib/reporting-jobs.ts.
 *
 * Text and model tests only: they do not prove PostgreSQL execution. The
 * planner's staging rehearsal of the complete reviewed 0038 does that.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "../staging/sqlStatements";
import {
  abandonReportingBatch,
  batchDrift,
  beginReportingRebuild,
  copyCursorDecision,
  copyReportingSourcePage,
  freezeReportingRebuild,
  renewReportingLease,
  ReportingJobError,
  resumeReportingBatch,
  selectSourcePage,
  type DriftInput,
  type RpcClient,
} from "../../api/_lib/reporting-jobs";

const SQL = readFileSync("supabase/migrations/0038_reporting_jobs.sql", "utf8");
const code = (s: string) => s.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
const codes = splitSqlStatements(SQL).map((s) => code(s.text));
const fn = (name: string) => codes.find((c) => new RegExp(`^CREATE (OR REPLACE )?FUNCTION ${name.replace(".", "\\.")}\\(`).test(c)) ?? "";
const before = (body: string, a: string, b: string) => {
  const i = body.indexOf(a);
  const j = body.indexOf(b);
  return i >= 0 && j >= 0 && i < j;
};

describe("batch identity and drift (B1)", () => {
  it("batch_drift checks capture, epoch, rule, active batch, base pointer and the real base generation; a rebuild may replace an older rule", () => {
    const f = fn("reporting_private.batch_drift");
    for (const m of ["capture is disabled", "capture epoch changed", "rule version changed", "not the site''s active batch", "published base changed", "base is not a complete published generation of this site", "refresh base is not at the current rule and capture epoch", "refresh has no published base"]) {
      expect(f).toContain(`'${m}'`);
    }
    expect(f).toMatch(/IF b\.kind = 'refresh' AND \(g\.rule_version <> c\.rule_version OR g\.capture_epoch <> c\.capture_epoch\)/);
    expect(f).toMatch(/g\.site <> b\.site OR g\.state <> 'published' OR NOT g\.complete/);
  });

  it("lock_batch: control share lock, then the site row, then the batch row; exact fence on batch AND site; live lease when asked", () => {
    const f = fn("reporting_private.lock_batch");
    expect(before(f, "FROM reporting_private.control c WHERE c.singleton FOR SHARE", "FROM reporting_private.site_state s WHERE s.site = v_site FOR UPDATE")).toBe(true);
    expect(before(f, "FROM reporting_private.site_state s WHERE s.site = v_site FOR UPDATE", "FROM reporting_private.batches x WHERE x.batch_id = p_batch FOR UPDATE")).toBe(true);
    expect(f).toMatch(/v_drift := reporting_private\.batch_drift\(p_batch\); IF v_drift IS NOT NULL THEN RAISE EXCEPTION/);
    expect(f).toMatch(/IF p_fence IS NULL OR b\.lease_fence <> p_fence OR v_fence <> p_fence THEN RAISE EXCEPTION .*is obsolete/);
    expect(f).toMatch(/IF p_live AND \(b\.lease_expires_at IS NULL OR b\.lease_expires_at <= now\(\)\) THEN RAISE EXCEPTION .*lease expired/);
  });

  it("refresh begin validates the REAL base and never returns a drifted batch as usable; a live batch is busy", () => {
    const f = fn("public.begin_reporting_batch");
    expect(f).toMatch(/v_base\.site <> p_site OR v_base\.state <> 'published' OR NOT v_base\.complete OR v_base\.rule_version <> v_ctl\.rule_version OR v_base\.capture_epoch <> v_ctl\.capture_epoch OR v_site\.source_epoch IS DISTINCT FROM v_ctl\.capture_epoch/);
    expect(f).toMatch(/IF v_drift IS NULL AND v_active\.lease_expires_at > now\(\) THEN RAISE EXCEPTION 'reporting batch % for % is busy until %'/);
    expect(f).toMatch(/SET state = 'failed', failure_kind = pg_catalog\.left\('invalidated: ' \|\| v_drift, 200\)/);
    // The reused branch is only for a valid, expired batch.
    expect(f).toMatch(/ELSIF v_drift IS NULL THEN RETURN QUERY SELECT v_active\.batch_id/);
  });
});

describe("candidate rebuild (B1)", () => {
  it("begin_reporting_rebuild: capture on first; busy/expired batches are not replaced; drifted ones invalidated; base must be the unchanged published base", () => {
    const f = fn("public.begin_reporting_rebuild");
    expect(before(f, "FOR SHARE", "FROM reporting_private.site_state s WHERE s.site = p_site FOR UPDATE")).toBe(true);
    expect(f).toMatch(/IF NOT v_ctl\.capture_enabled THEN RAISE EXCEPTION 'reporting capture must be enabled before a rebuild starts'/);
    expect(f).toMatch(/is busy until/);
    expect(f).toMatch(/has an expired lease; resume or abandon it first/);
    expect(f).toMatch(/invalidated: ' \|\| v_drift/);
    expect(f).toMatch(/v_base\.site <> p_site OR v_base\.state <> 'published' OR NOT v_base\.complete/);
    // A rebuild may replace an older rule/epoch base: no rule/epoch condition on the base itself.
    expect(f).not.toMatch(/v_base\.rule_version|v_base\.capture_epoch/);
    expect(f).toMatch(/VALUES \(p_site, 'rebuild', v_site\.active_generation_id, v_ctl\.rule_version, v_ctl\.capture_epoch, NULL, 'active', v_fence, v_lease,/);
    expect(f).toMatch(/v_fence := v_site\.lease_fence \+ 1;/);
    expect(f).toMatch(/'after', NULL, 'pages', 0, 'rows', 0, 'bytes', 0, 'complete', false/);
  });

  it("copy_reporting_source_page owns the read and the write: no image parameter, keyset by exact id, no OFFSET, row and byte bounds", () => {
    const f = fn("public.copy_reporting_source_page");
    expect(f).toMatch(/^CREATE FUNCTION public\.copy_reporting_source_page\(p_batch uuid, p_fence bigint, p_after_event_id text\)/);
    expect(f).toMatch(/b := reporting_private\.lock_batch\(p_batch, p_fence, true\);/);
    expect(f).toMatch(/IF b\.kind <> 'rebuild' OR b\.state <> 'active' THEN/);
    expect(f).toMatch(/WHERE pe\.location = b\.site AND \(p_after_event_id IS NULL OR pe\.id > p_after_event_id\) ORDER BY pe\.id LIMIT 1000/);
    expect(f).not.toMatch(/\bOFFSET\b/i);
    expect(f).toMatch(/sum\(pg_catalog\.octet_length\(p\.img::text\)\) OVER \(ORDER BY p\.id ROWS UNBOUNDED PRECEDING\) AS run/);
    expect(f).toMatch(/WHERE s\.run <= 1048576/);
    expect(f).toMatch(/IF v_fetched > 0 AND v_rows = 0 THEN RAISE EXCEPTION 'source row after % at % is % bytes, over the 1 MiB page limit'/);
    expect(f).toMatch(/v_complete := v_fetched < 1000 AND v_rows = v_fetched;/);
    expect(f).toMatch(/INSERT INTO reporting_private\.source_candidate/);
    expect(f.match(/INSERT INTO (\w+\.\w+)/g)).toEqual(["INSERT INTO reporting_private.source_candidate"]);
    expect(f).toMatch(/pg_catalog\.sha256\(pg_catalog\.convert_to\(/);
  });

  it("copy cursor: next page only at the persisted cursor; identical replay returns the saved response; complete refuses more", () => {
    const f = fn("public.copy_reporting_source_page");
    expect(f).toMatch(/IF v_last IS NOT NULL AND \(v_last ->> 'after'\) IS NOT DISTINCT FROM p_after_event_id AND \(\(v_cur ->> 'after'\) IS DISTINCT FROM p_after_event_id OR \(v_cur ->> 'complete'\)::boolean\) THEN v_resp := v_last -> 'response';/);
    // Replay is decided BEFORE the already-complete refusal.
    expect(before(f, "v_resp := v_last -> 'response';", "copy is already complete")).toBe(true);
    expect(f).toMatch(/IF \(v_cur ->> 'complete'\)::boolean THEN RAISE EXCEPTION 'reporting rebuild % copy is already complete'/);
    expect(f).toMatch(/IF \(v_cur ->> 'after'\) IS DISTINCT FROM p_after_event_id THEN RAISE EXCEPTION 'reporting rebuild % cursor mismatch/);
    expect(f).toMatch(/'last', pg_catalog\.jsonb_build_object\('after', p_after_event_id, 'response', v_resp\)/);
  });

  it("freeze: needs a complete copy; ONE statement freezes membership and images and overlays the candidate (upsert + tombstone delete); then frozen", () => {
    const f = fn("public.freeze_reporting_rebuild");
    expect(f).toMatch(/IF NOT coalesce\(\(b\.rebuild_cursor ->> 'complete'\)::boolean, false\) THEN RAISE EXCEPTION 'reporting rebuild % copy is not complete'/);
    const stmt = f.slice(f.indexOf("WITH members AS"), f.indexOf("INTO v_changes, v_events, v_up, v_del;"));
    for (const part of ["INSERT INTO reporting_private.batch_changes", "INSERT INTO reporting_private.batch_events", "INSERT INTO reporting_private.source_candidate", "ON CONFLICT (batch_id, site, event_id) DO UPDATE", "DELETE FROM reporting_private.source_candidate sc USING imgs i WHERE i.img IS NULL"]) {
      expect(stmt).toContain(part);
    }
    expect(stmt).not.toMatch(/;/);
    expect(stmt).toMatch(/LEFT JOIN public\.production_events pe ON pe\.location = b\.site AND pe\.id = k\.event_id/);
    expect(f).toMatch(/UPDATE reporting_private\.batches x SET state = 'frozen', source_cutoff = v_cutoff/);
    expect(before(f, "WITH members AS", "SET state = 'frozen'")).toBe(true);
  });

  it("the candidate is private, RLS-enabled, writable only while its rebuild is active, deletable only after it finished", () => {
    expect(codes).toContain("ALTER TABLE reporting_private.source_candidate ENABLE ROW LEVEL SECURITY");
    expect(codes).toContain("REVOKE ALL ON TABLE reporting_private.source_candidate FROM PUBLIC, anon, authenticated");
    expect(codes).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reporting_private.source_candidate TO service_role");
    const g = fn("reporting_private.source_candidate_guard");
    expect(g).toMatch(/IF v_kind = 'rebuild' AND v_state = 'active' THEN RETURN/);
    expect(g).toMatch(/IF TG_OP = 'DELETE' AND v_state IN \('published', 'failed', 'abandoned'\) THEN RETURN OLD;/);
    expect(g).toMatch(/RAISE EXCEPTION 'source_candidate of batch % is immutable \(state %\)'/);
    expect(codes).toContain("CREATE TRIGGER source_candidate_guard BEFORE INSERT OR UPDATE OR DELETE ON reporting_private.source_candidate FOR EACH ROW EXECUTE FUNCTION reporting_private.source_candidate_guard()");
    expect(codes).toContain("REVOKE ALL ON FUNCTION reporting_private.source_candidate_guard() FROM PUBLIC, anon, authenticated, service_role");
  });
});

describe("lease renewal, takeover and abandon (B1)", () => {
  it("renew extends the current live lease to 360 s and keeps the fence", () => {
    const f = fn("public.renew_reporting_lease");
    expect(f).toMatch(/b := reporting_private\.lock_batch\(p_batch, p_fence, true\);/);
    expect(f).toMatch(/v_lease timestamptz := now\(\) \+ interval '360 seconds'/);
    expect(f).not.toMatch(/lease_fence =/);
  });

  it("resume: only an expired, valid batch at the expected fence; fence +1 on site and batch; leased work back to pending; no re-snapshot", () => {
    const f = fn("public.resume_reporting_batch");
    expect(before(f, "FOR SHARE", "FROM reporting_private.site_state s WHERE s.site = v_site FOR UPDATE")).toBe(true);
    expect(f).toMatch(/RAISE EXCEPTION 'reporting batch % cannot be resumed: %; abandon it'/);
    expect(f).toMatch(/IF p_expected_fence IS NULL OR b\.lease_fence <> p_expected_fence OR v_sfence <> p_expected_fence THEN/);
    expect(f).toMatch(/IF b\.lease_expires_at IS NOT NULL AND b\.lease_expires_at > now\(\) THEN RAISE EXCEPTION 'reporting batch % is busy until %'/);
    expect(f).toMatch(/v_new := v_sfence \+ 1;/);
    expect(f).toMatch(/UPDATE reporting_private\.site_state s SET lease_fence = v_new/);
    expect(f).toMatch(/UPDATE reporting_private\.batches x SET lease_fence = v_new/);
    expect(f).toMatch(/UPDATE reporting_private\.partition_work w SET state = 'pending', lease_fence = NULL WHERE w\.batch_id = p_batch AND w\.state = 'leased'/);
    expect(f).not.toMatch(/batch_changes|batch_events|source_candidate|partition_results|production_events/);
  });

  it("abandon: needs a reason and the current fence; refuses a live valid batch; keeps evidence and pending journal", () => {
    const f = fn("public.abandon_reporting_batch");
    expect(f).toMatch(/IF p_reason IS NULL OR pg_catalog\.btrim\(p_reason\) = '' THEN RAISE EXCEPTION/);
    expect(f).toMatch(/IF b\.lease_expires_at > now\(\) AND reporting_private\.batch_drift\(p_batch\) IS NULL THEN RAISE EXCEPTION/);
    expect(f).toMatch(/SET state = 'abandoned', failure_kind = v_reason/);
    expect(f).not.toMatch(/DELETE FROM|acknowledged_at|batch_changes/);
  });

  it("every B1 function is SECURITY INVOKER with an empty search path, no dynamic SQL, service-only", () => {
    for (const name of ["public.begin_reporting_rebuild", "public.copy_reporting_source_page", "public.freeze_reporting_rebuild", "public.renew_reporting_lease", "public.resume_reporting_batch", "public.abandon_reporting_batch", "reporting_private.batch_drift", "reporting_private.lock_batch", "reporting_private.order_key", "reporting_private.source_candidate_guard"]) {
      const f = fn(name);
      expect(f, name).toMatch(/SECURITY INVOKER SET search_path = ''/);
      expect(f, name).not.toMatch(/\bEXECUTE\b|format\(/);
    }
    for (const sig of ["public.begin_reporting_rebuild(text)", "public.copy_reporting_source_page(uuid, bigint, text)", "public.freeze_reporting_rebuild(uuid, bigint)", "public.renew_reporting_lease(uuid, bigint)", "public.resume_reporting_batch(uuid, bigint)", "public.abandon_reporting_batch(uuid, bigint, text)"]) {
      expect(codes).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated`);
      expect(codes).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role`);
    }
  });
});

// ---------------------------------------------------------------------------
// Pure references
// ---------------------------------------------------------------------------

describe("copy page selection and cursor (pure reference)", () => {
  const rows = (n: number, bytes = 100) => Array.from({ length: n }, (_, i) => ({ id: `e${String(i).padStart(5, "0")}`, bytes }));

  it("1,000 rows: a full page that is NOT complete (there may be more)", () => {
    const r = selectSourcePage(rows(1500));
    expect(r.kept).toHaveLength(1000);
    expect(r.complete).toBe(false);
  });

  it("a byte-capped page ends at its actual last row and is NOT complete, even when fewer than 1,000 rows were read", () => {
    const r = selectSourcePage(rows(20, 100_000));
    expect(r.kept).toHaveLength(10);
    expect(r.bytes).toBe(1_000_000);
    expect(r.complete).toBe(false);
  });

  it("complete only after a true end-of-source read; an empty read is complete", () => {
    expect(selectSourcePage(rows(7))).toMatchObject({ complete: true });
    expect(selectSourcePage([])).toEqual({ kept: [], bytes: 0, complete: true });
  });

  it("a single row over 1 MiB fails visibly", () => {
    expect(() => selectSourcePage([{ id: "big", bytes: 1024 * 1024 + 1 }])).toThrow(ReportingJobError);
  });

  it("cursor decisions", () => {
    expect(copyCursorDecision({ after: null, complete: false }, null)).toBe("next");
    expect(copyCursorDecision({ after: "e999", complete: false, last: { after: null } }, null)).toBe("replay");
    expect(copyCursorDecision({ after: "e999", complete: false, last: { after: null } }, "e999")).toBe("next");
    expect(copyCursorDecision({ after: "e999", complete: false, last: { after: null } }, "e500")).toBe("mismatch");
    expect(copyCursorDecision({ after: "e1203", complete: true, last: { after: "e999" } }, "e1203")).toBe("complete");
    expect(copyCursorDecision({ after: "e1203", complete: true, last: { after: "e999" } }, "e999")).toBe("replay");
  });

  it("a final EMPTY page's lost-response retry replays (empty site; exact multiple of 1,000 rows)", () => {
    // Empty site: the first request (null) returned 0 rows and completed; the cursor stayed null.
    expect(selectSourcePage([])).toMatchObject({ kept: [], complete: true });
    expect(copyCursorDecision({ after: null, complete: true, last: { after: null } }, null)).toBe("replay");
    // 2,000 rows: page 2 after e01999... page 3 after the last id read 0 rows and completed; cursor unchanged.
    expect(copyCursorDecision({ after: "e01999", complete: true, last: { after: "e01999" } }, "e01999")).toBe("replay");
    // Anything else after completion is refused.
    expect(copyCursorDecision({ after: "e01999", complete: true, last: { after: "e01999" } }, "e00999")).toBe("complete");
  });
});

describe("batch drift: refresh rejection and a legitimate rule-change rebuild (pure reference)", () => {
  const base = (over: Partial<DriftInput> = {}): DriftInput => ({
    batch: { kind: "refresh", captureEpoch: 4, ruleVersion: "item-counting-summary-v2", baseGenerationId: "g1", site: "au", batchId: "b1" },
    control: { captureEpoch: 4, ruleVersion: "item-counting-summary-v2", captureEnabled: true },
    site: { activeBatchId: "b1", activeGenerationId: "g1" },
    base: { site: "au", state: "published", complete: true, ruleVersion: "item-counting-summary-v2", captureEpoch: 4 },
    ...over,
  });

  it("a valid refresh is usable", () => {
    expect(batchDrift(base())).toBeNull();
  });

  it("refresh on an older-rule base is rejected; a rebuild replacing that base at the current rule is legitimate", () => {
    const olderBase = { site: "au", state: "published", complete: true, ruleVersion: "item-counting-summary-v1", captureEpoch: 3 };
    expect(batchDrift(base({ base: olderBase }))).toBe("refresh base is not at the current rule and capture epoch");
    const rebuild = base({ base: olderBase });
    rebuild.batch = { ...rebuild.batch, kind: "rebuild" };
    expect(batchDrift(rebuild)).toBeNull();
    // ...but the rebuild's OWN captured rule/epoch must match current control.
    expect(batchDrift({ ...rebuild, batch: { ...rebuild.batch, ruleVersion: "item-counting-summary-v1" } })).toBe("rule version changed");
  });

  it("toggle, epoch, rule and base drift invalidate a batch", () => {
    expect(batchDrift(base({ control: { captureEpoch: 4, ruleVersion: "item-counting-summary-v2", captureEnabled: false } }))).toBe("capture is disabled");
    expect(batchDrift(base({ control: { captureEpoch: 5, ruleVersion: "item-counting-summary-v2", captureEnabled: true } }))).toBe("capture epoch changed");
    expect(batchDrift(base({ site: { activeBatchId: "b1", activeGenerationId: "g2" } }))).toBe("published base changed");
    expect(batchDrift(base({ site: { activeBatchId: "b9", activeGenerationId: "g1" } }))).toBe("not the site's active batch");
    expect(batchDrift(base({ base: { site: "uk", state: "published", complete: true, ruleVersion: "item-counting-summary-v2", captureEpoch: 4 } }))).toMatch(/not a complete published generation of this site/);
    const noBase = base({ site: { activeBatchId: "b1", activeGenerationId: null }, base: null });
    noBase.batch = { ...noBase.batch, baseGenerationId: null };
    expect(batchDrift(noBase)).toBe("refresh has no published base");
    expect(batchDrift({ ...noBase, batch: { ...noBase.batch, kind: "rebuild" } })).toBeNull();
  });
});

describe("B1 wrappers", () => {
  const BATCH = "0b9d6c62-3d55-4c3d-9a9e-0a9b7f3c1e11";
  function fake(data: unknown) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const client: RpcClient = { rpc: async (f, a) => (calls.push([f, a]), { data, error: null }) };
    return { client, calls };
  }

  it("validate arguments before any call", async () => {
    const { client, calls } = fake([]);
    await expect(copyReportingSourcePage(client, "not-a-uuid", 1, null)).rejects.toThrow(/uuid/);
    await expect(copyReportingSourcePage(client, BATCH, 0, null)).rejects.toThrow(/fence/);
    await expect(copyReportingSourcePage(client, BATCH, 1, "")).rejects.toThrow(/afterEventId/);
    await expect(abandonReportingBatch(client, BATCH, 1, " ")).rejects.toThrow(/reason/);
    await expect(beginReportingRebuild(client, "staging" as never)).rejects.toThrow(/unsupported site/);
    expect(calls).toEqual([]);
  });

  it("copy passes only the cursor and validates the checksum", async () => {
    const row = { rows_copied: 1000, bytes_copied: 512000, after_event_id: null, next_after_event_id: "e00999", page_checksum: "a".repeat(64), complete: false, pages: 1, total_rows: 1000, replay: false };
    const { client, calls } = fake([row]);
    expect(await copyReportingSourcePage(client, BATCH, 7, null)).toMatchObject({ nextAfterEventId: "e00999", complete: false, replay: false });
    expect(calls[0]).toEqual(["copy_reporting_source_page", { p_batch: BATCH, p_fence: 7, p_after_event_id: null }]);
    await expect(copyReportingSourcePage(fake([{ ...row, page_checksum: "md5" }]).client, BATCH, 7, null)).rejects.toThrow(/SHA-256/);
  });

  it("renew must keep the fence; resume must advance it", async () => {
    await expect(renewReportingLease(fake([{ batch_id: BATCH, lease_fence: 8, lease_expires_at: "t" }]).client, BATCH, 7)).rejects.toThrow(/changed the fence/);
    expect(await renewReportingLease(fake([{ batch_id: BATCH, lease_fence: 7, lease_expires_at: "t" }]).client, BATCH, 7)).toMatchObject({ leaseFence: 7 });
    const refresh = { batch_id: BATCH, lease_fence: 8, lease_expires_at: "t", state: "frozen", returned_work: 2, kind: "refresh", base_generation_id: "g1", rule_version: "item-counting-summary-v1", capture_epoch: 4, source_cutoff: "t0", rebuild_progress: null };
    await expect(resumeReportingBatch(fake([{ ...refresh, lease_fence: 7 }]).client, BATCH, 7)).rejects.toThrow(/did not advance/);
    expect(await resumeReportingBatch(fake([refresh]).client, BATCH, 7)).toMatchObject({ leaseFence: 8, returnedWork: 2, kind: "refresh", rebuildProgress: null });
  });

  it("freeze maps its counts", async () => {
    const r = await freezeReportingRebuild(fake([{ batch_id: BATCH, source_cutoff: "t", change_count: 3, event_count: 4, upserted: 3, deleted: 1, candidate_rows: 1200 }]).client, BATCH, 7);
    expect(r).toEqual({ batchId: BATCH, sourceCutoffUtc: "t", changeCount: 3, eventCount: 4, upserted: 3, deleted: 1, candidateRows: 1200 });
  });
});

describe("order_key trims EXACTLY what the shared TypeScript order key trims (no indexed lookup can miss a row)", () => {
  /** The characters inside order_key's btrim set, decoded from the SQL E'' literal. */
  function sqlTrimSet(): Set<string> {
    const f = fn("reporting_private.order_key");
    const lit = /pg_catalog\.btrim\(p_order, E'((?:[^'\\]|\\.)*)'\)/.exec(f)?.[1];
    if (lit === undefined) throw new Error("order_key btrim literal not found");
    const out = new Set<string>();
    for (let i = 0; i < lit.length; i++) {
      if (lit[i] !== "\\") {
        out.add(lit[i]);
        continue;
      }
      const e = lit[++i];
      if (e === "u") {
        out.add(String.fromCharCode(parseInt(lit.slice(i + 1, i + 5), 16)));
        i += 4;
      } else {
        const simple: Record<string, string> = { t: "\t", n: "\n", f: "\f", r: "\r", b: "\b" };
        if (!(e in simple)) throw new Error(`unsupported escape \\${e}`);
        out.add(simple[e]);
      }
    }
    return out;
  }

  it("the SQL set equals the set JavaScript's String.prototype.trim removes, over every BMP code point", () => {
    const js = new Set<string>();
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates are never trimmed
      const ch = String.fromCharCode(cp);
      if (ch.trim() === "") js.add(ch);
    }
    const sql = sqlTrimSet();
    const show = (s: Set<string>) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).sort().join(",");
    expect(show(sql)).toBe(show(js));
    // The well-known cases the planner named.
    for (const ch of [" ", "﻿", " ", "　", "\u000b"]) expect(sql.has(ch)).toBe(true);
  });

  it("btrim with that set gives the same key as evidenceOrderKey for whitespace-wrapped orders", async () => {
    const { evidenceOrderKey } = await import("../../src/lib/domain/productionCounts");
    const set = sqlTrimSet();
    const btrim = (s: string) => {
      let a = 0;
      let b = s.length;
      while (a < b && set.has(s[a])) a++;
      while (b > a && set.has(s[b - 1])) b--;
      return s.slice(a, b);
    };
    for (const raw of ["5010", " 5010", " 5010﻿", "\t5010　", "50 10", "  ", "", "​5010"]) {
      expect(btrim(raw), JSON.stringify(raw)).toBe(evidenceOrderKey(raw));
    }
  });
});
