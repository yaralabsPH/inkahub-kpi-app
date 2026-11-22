import { describe, expect, it } from "vitest";
import {
  autoMailTubeForUnframedOrder,
  MAIL_TUBE_LARGE_PRODUCT_ID,
  MAIL_TUBE_SMALL_PRODUCT_ID,
} from "@/lib/domain/skuRouting";
import { packagingContents } from "../contents";
import { evaluatePackaging } from "../evaluate";
import type { RuleSetBody } from "../ruleSet";

/**
 * Proves the rule engine can express today's hard-coded mail-tube choice:
 * any A0 unframed or A0 free print -> large tube, otherwise small tube.
 *
 * The two rules below restate existing code behaviour for the comparison;
 * they are test data, not the production rule set.
 */
const tubeRules: RuleSetBody = {
  schema_version: 1,
  catalogue: [
    { key: "TUBE-L", product_id: MAIL_TUBE_LARGE_PRODUCT_ID, label: "Large tube" },
    { key: "TUBE-S", product_id: MAIL_TUBE_SMALL_PRODUCT_ID, label: "Small tube" },
  ],
  rules: [
    { id: "tube-large", packing_point: "unframed", kinds: ["unframed", "free_print", "accessory"], contains_sizes: ["A0"],
      output: { mode: "fixed", packages: [{ key: "TUBE-L", qty: 1 }] } },
    { id: "tube-small", packing_point: "unframed", kinds: ["unframed", "free_print", "accessory"],
      output: { mode: "fixed", packages: [{ key: "TUBE-S", qty: 1 }] } },
  ],
  examples: [],
};

// Synthetic SKUs with no framed or picture-frame lines.
const FLAT_SKUS = [
  "INKA-ABC0001-A0-UN",
  "INKA-ABC0002-A1-UN",
  "INKA-ABC0003-A4-UN",
  "INKA-S2ABC0004-A0-UN",
  "INKA-S3ABC0005-A2-UN",
  "INKA-AUX-FP-ABC-A0",
  "INKA-AUX-FP-ABC-A3",
  "INKA-AUX-HOOKS",
  "INKA-GC0001-50",
];

function newTube(skus: string[]): string | null {
  const lines = skus.map((sku, i) => ({ sku, quantity: (i % 3) + 1 }));
  const ev = evaluatePackaging(tubeRules, "unframed", packagingContents(lines, "unframed"));
  expect(ev.status).toBe("resolved");
  if (ev.packages.length === 0) return null;
  expect(ev.packages).toHaveLength(1);
  expect(ev.packages[0].qty).toBe(1);
  return ev.packages[0].product_id;
}

describe("mail-tube parity with autoMailTubeForUnframedOrder", () => {
  it("matches the old choice for every combination of flat lines", () => {
    let checked = 0;
    for (let mask = 0; mask < 1 << FLAT_SKUS.length; mask++) {
      const skus = FLAT_SKUS.filter((_, i) => mask & (1 << i));
      expect(newTube(skus), skus.join(", ") || "(empty order)").toBe(autoMailTubeForUnframedOrder(skus));
      checked++;
    }
    expect(checked).toBe(512);
  });

  it("differs on purpose when the order has a framed parcel: the prints go in the box (CJ decision Q4)", () => {
    const skus = ["INKA-ABC0009-A1-FB", "INKA-ABC0002-A1-UN"];
    expect(autoMailTubeForUnframedOrder(skus)).toBe(MAIL_TUBE_SMALL_PRODUCT_ID);
    expect(newTube(skus)).toBeNull();
  });
});
