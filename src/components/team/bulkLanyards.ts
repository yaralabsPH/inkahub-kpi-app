import { getSupabase } from "@/lib/repository/supabase/client";
import { printAllLanyards, downloadAllLanyardsAsJpegs } from "@/lib/utils/lanyard";

/**
 * Bulk lanyard actions for the Team page (moved here unchanged from the old
 * "Print all" / "Download all" cards). Each returns the message to show.
 */

async function loadActiveLanyards(location: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("staff_barcodes")
    .select("display_name, barcode")
    .eq("location", location)
    .eq("active", true)
    .order("display_name", { ascending: true });
  if (error) throw new Error(`Couldn't load team members: ${error.message}`);
  const rows = (data ?? []) as Array<{ display_name: string; barcode: string }>;
  return rows.map((r) => ({ name: r.display_name, barcode: r.barcode }));
}

const NONE = "No active team members with barcodes for this location.";

function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.startsWith("Couldn't") ? m : `Error: ${m}`;
}

export async function printAllTeamLanyards(location: string): Promise<string> {
  try {
    const staff = await loadActiveLanyards(location);
    if (staff.length === 0) return NONE;
    printAllLanyards(staff);
    return `Opened print window with ${staff.length} lanyard${staff.length === 1 ? "" : "s"}. In the print dialog, choose "Save as PDF" to download.`;
  } catch (e) {
    return errMsg(e);
  }
}

export async function downloadAllTeamLanyards(location: string): Promise<string> {
  try {
    const staff = await loadActiveLanyards(location);
    if (staff.length === 0) return NONE;
    const result = await downloadAllLanyardsAsJpegs(staff);
    return `Downloaded ${result.filename} (${result.count} lanyard${result.count === 1 ? "" : "s"}). Extract the zip - each file is a print-ready JPEG.`;
  } catch (e) {
    return errMsg(e);
  }
}
