import { useState } from "react";
import { TeamMembersCard } from "@/components/TeamMembersCard";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useAppStore } from "@/lib/state/appStore";
import { getSupabase } from "@/lib/repository/supabase/client";
import { printAllLanyards, downloadAllLanyardsAsJpegs } from "@/lib/utils/lanyard";

/**
 * Team page - dedicated home for team-member administration. Hosts the
 * existing TeamMembersCard (invite / role / barcode issuance) and a Print
 * All Lanyards card that batches every active staff barcode into a single
 * print window / PDF export.
 */
export function Team() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Team</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Manage team members, roles, and lanyard barcodes for this location.
        </p>
      </div>

      <TeamMembersCard />

      <PrintAllLanyardsButton />

      <DownloadAllLanyardsButton />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Print all team lanyards: fetches every active staff barcode for the
// current location and opens a multi-page print window. Use the browser's
// "Save as PDF" destination to download as a single PDF.
// ---------------------------------------------------------------------------

function PrintAllLanyardsButton() {
  const location = useAppStore((s) => s.location);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const onClick = async () => {
    setMsg(null);
    setLoading(true);
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from("staff_barcodes")
        .select("display_name, barcode")
        .eq("location", location)
        .eq("active", true)
        .order("display_name", { ascending: true });
      if (error) {
        setMsg(`Couldn't load team members: ${error.message}`);
        return;
      }
      const rows = (data ?? []) as Array<{ display_name: string; barcode: string }>;
      if (rows.length === 0) {
        setMsg("No active team members with barcodes for this location.");
        return;
      }
      printAllLanyards(
        rows.map((r) => ({ name: r.display_name, barcode: r.barcode })),
      );
      setMsg(`Opened print window with ${rows.length} lanyard${rows.length === 1 ? "" : "s"}. In the print dialog, choose "Save as PDF" to download.`);
    } catch (e) {
      setMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Print all team lanyards</CardTitle>
        <span className="text-xs text-slate-500">
          Generate printable lanyard cards for every active team member at this location.
        </span>
      </CardHeader>
      <CardBody className="space-y-2">
        <Button onClick={onClick} disabled={loading}>
          {loading ? "Loading..." : "Print all team lanyards (PDF)"}
        </Button>
        {msg ? (
          <div className="text-xs text-slate-600 dark:text-slate-300">{msg}</div>
        ) : null}
        <div className="text-[11px] text-slate-500">
          Opens a print window with one card per staff member, each on its
          own page. Pick "Save as PDF" as the destination in the print
          dialog to download all lanyards as a single PDF file.
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Download all team lanyards as a ZIP of JPEGs. One JPEG per staff member,
// named like Sarah_C0EBE911.jpg. Useful when the operator wants individual
// image files instead of a printable PDF (e.g. to upload to a label printer
// or share via WhatsApp / email).
// ---------------------------------------------------------------------------

function DownloadAllLanyardsButton() {
  const location = useAppStore((s) => s.location);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const onClick = async () => {
    setMsg(null);
    setLoading(true);
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from("staff_barcodes")
        .select("display_name, barcode")
        .eq("location", location)
        .eq("active", true)
        .order("display_name", { ascending: true });
      if (error) {
        setMsg(`Couldn't load team members: ${error.message}`);
        return;
      }
      const rows = (data ?? []) as Array<{ display_name: string; barcode: string }>;
      if (rows.length === 0) {
        setMsg("No active team members with barcodes for this location.");
        return;
      }
      const result = await downloadAllLanyardsAsJpegs(
        rows.map((r) => ({ name: r.display_name, barcode: r.barcode })),
      );
      setMsg(`Downloaded ${result.filename} (${result.count} lanyard${result.count === 1 ? "" : "s"}). Extract the zip - each file is a print-ready JPEG.`);
    } catch (e) {
      setMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Download all team lanyards (JPEG ZIP)</CardTitle>
        <span className="text-xs text-slate-500">
          One JPEG per active team member, packaged into a single zip download. Useful for label printers or sharing individual cards.
        </span>
      </CardHeader>
      <CardBody className="space-y-2">
        <Button onClick={onClick} disabled={loading}>
          {loading ? "Generating..." : "Download all as JPEGs (zip)"}
        </Button>
        {msg ? (
          <div className="text-xs text-slate-600 dark:text-slate-300">{msg}</div>
        ) : null}
        <div className="text-[11px] text-slate-500">
          Each JPEG is 85mm x 55mm at 300 DPI (~1000 x 650 px) with the staff name, Code128 barcode, and the 8-char token. Filenames look like Sarah_C0EBE911.jpg so you can find a specific person fast.
        </div>
      </CardBody>
    </Card>
  );
}
