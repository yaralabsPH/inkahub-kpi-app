import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemberPanel, TeamMembersCard } from "../../src/components/TeamMembersCard";

const auth = vi.hoisted(() => ({ role: null as string | null, client: vi.fn() }));
vi.mock("@/lib/auth/AuthProvider", () => ({
  useAuth: () => ({ profile: auth.role ? { user_id: "owner-id", role: auth.role } : null }),
}));
vi.mock("@/lib/repository/supabase/client", () => ({
  getBackendMode: () => "supabase",
  getSupabase: auth.client,
}));

const member = {
  user_id: "member-id", display_name: "Jane Smith", role: "staff" as const,
  locations: ["au"], allowed_nav: null, barcode: "TEST-BARCODE", hourly_rate: 25,
};
const callbacks = {
  setTab: vi.fn(), onRename: vi.fn(), onRole: vi.fn(), onToggleLocation: vi.fn(),
  onSetNav: vi.fn(), onIssueBarcode: vi.fn(), onPrint: vi.fn(), onRate: vi.fn(), onRemove: vi.fn(),
};
function panel(over: Partial<Parameters<typeof MemberPanel>[0]> = {}) {
  return renderToStaticMarkup(<MemberPanel {...callbacks} member={member} isSelf={false} busy={false} tab="access" {...over} />);
}
function checkbox(html: string, label: string) {
  const buttons = html.match(/<button\b[\s\S]*?<\/button>/g) ?? [];
  const result = buttons.find((b) => b.includes('role="checkbox"') && b.includes(`>${label}</span>`));
  expect(result, `checkbox ${label}`).toBeDefined();
  return result!;
}

describe("Team member rendering", () => {
  beforeEach(() => { auth.role = null; auth.client.mockClear(); });

  it.each([null, "manager", "staff", "kiosk", "cs"])("does not initialize team data for %s", (role) => {
    auth.role = role;
    expect(renderToStaticMarkup(<TeamMembersCard />)).toBe("");
    expect(auth.client).not.toHaveBeenCalled();
  });

  it("locks mandatory Welcome and unavailable Dashboard for non-owners", () => {
    const html = panel();
    expect(checkbox(html, "Welcome")).toContain('aria-checked="true"');
    expect(checkbox(html, "Welcome")).toContain('disabled=""');
    expect(checkbox(html, "Dashboard")).toContain('aria-checked="false"');
    expect(checkbox(html, "Dashboard")).toContain('disabled=""');
  });

  it("allows an owner to edit Dashboard but keeps Settings available after Clear", () => {
    const html = panel({ member: { ...member, role: "owner", allowed_nav: [] } });
    expect(checkbox(html, "Dashboard")).not.toContain('disabled=""');
    expect(checkbox(html, "Settings")).toContain('aria-checked="true"');
    expect(checkbox(html, "Settings")).toContain('disabled=""');
  });

  it("disables competing writes while a member change is saving", () => {
    const html = panel({ busy: true });
    expect(html).toMatch(/<input[^>]*disabled=""/);
    expect(html).toMatch(/<select[^>]*disabled=""/);
    for (const button of html.match(/<button\b[\s\S]*?<\/button>/g) ?? []) {
      if (button.includes('role="checkbox"') || /Select all|>Clear<|Reset to role default|Remove member/.test(button)) {
        expect(button).toContain('disabled=""');
      }
    }
    expect(panel({ busy: true, tab: "production" })).toMatch(/<input[^>]*disabled=""/);
  });

  it("exposes one tabbable selected tab and labels its panel", () => {
    const html = panel({ tab: "locations" });
    const tabs = (html.match(/<button\b[^>]*>/g) ?? []).filter((b) => b.includes('role="tab"'));
    expect(tabs).toHaveLength(3);
    expect(tabs.filter((t) => t.includes('tabindex="0"'))).toHaveLength(1);
    expect(tabs.find((t) => t.includes('tabindex="0"'))).toContain('aria-selected="true"');
    const panelId = /role="tabpanel" id="([^"]+)"/.exec(html)?.[1];
    expect(panelId).toBeTruthy();
    for (const tab of tabs) expect(tab).toContain(`aria-controls="${panelId}"`);
    expect(html).toMatch(/role="tabpanel"[^>]+aria-labelledby="[^"]+-locations"/);
  });

  it("keeps self-role and self-removal protections", () => {
    const html = panel({ isSelf: true, member: { ...member, role: "owner" } });
    expect(html).toMatch(/<select[^>]*disabled=""/);
    expect(html).not.toContain("Remove member</button>");
    expect(html).toContain("You can&#x27;t remove yourself");
  });
});
