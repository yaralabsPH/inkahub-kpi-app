import { useState, type ReactNode } from "react";
import { Lock, LogOut, KeyRound } from "lucide-react";
import { useAuth } from "@/lib/auth/AuthProvider";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

/**
 * Wraps the app and gates it behind a login screen when running in
 * Supabase mode. Also owns the password-recovery flow: when the user
 * clicks the reset link in their email, Supabase fires PASSWORD_RECOVERY
 * which lifts a flag here so we render the "Set new password" form
 * instead of the login form.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const {
    session, profile, locations, loading, error,
    passwordRecovery, signIn, signOut,
    requestPasswordReset, setNewPassword,
  } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Forgot-password sub-flow.
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSent, setForgotSent] = useState(false);

  // Set-new-password sub-flow (during recovery).
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [recoveryDone, setRecoveryDone] = useState(false);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950">
        <div className="text-sm text-slate-500">Loadingâ€¦</div>
      </div>
    );
  }

  // Password recovery mode wins over everything else - the user clicked
  // a reset link and needs to set a new password before doing anything.
  if (passwordRecovery && !recoveryDone) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 p-4">
        <div className="w-full max-w-md">
          <Card>
            <CardHeader>
              <CardTitle className="inline-flex items-center gap-2">
                <KeyRound size={16} /> Set a new password
              </CardTitle>
              <span className="text-xs text-slate-500">
                You arrived from a password-reset link. Choose a new password to continue.
              </span>
            </CardHeader>
            <CardBody>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setFormError(null);
                  if (newPw.length < 8) {
                    setFormError("Use at least 8 characters.");
                    return;
                  }
                  if (newPw !== newPw2) {
                    setFormError("Passwords don't match.");
                    return;
                  }
                  setBusy(true);
                  try {
                    await setNewPassword(newPw);
                    setRecoveryDone(true);
                  } catch (err) {
                    setFormError((err as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
                className="space-y-3"
              >
                <Field label="New password">
                  <Input
                    type="password"
                    required
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    autoFocus
                    autoComplete="new-password"
                  />
                </Field>
                <Field label="Confirm new password">
                  <Input
                    type="password"
                    required
                    value={newPw2}
                    onChange={(e) => setNewPw2(e.target.value)}
                    autoComplete="new-password"
                  />
                </Field>
                {formError ? (
                  <div className="text-sm text-red-600 dark:text-red-400">{formError}</div>
                ) : null}
                <Button type="submit" disabled={busy} className="w-full">
                  {busy ? "Updatingâ€¦" : "Update password"}
                </Button>
              </form>
            </CardBody>
          </Card>
        </div>
      </div>
    );
  }

  // Recovery just finished and we already have a session - drop through
  // to the app. If no session, fall through to the login form below.
  if (recoveryDone && session && profile) {
    return <>{children}</>;
  }

  // Not signed in -> show login form (+ optional forgot-password subform).
  if (!session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 p-4">
        <div className="w-full max-w-md">
          <Card>
            <CardHeader>
              <CardTitle className="inline-flex items-center gap-2">
                <Lock size={16} /> Sign in
              </CardTitle>
              <span className="text-xs text-slate-500">
                Inka Arthouse â€” multi-user mode. Use the email + password set up by your team's owner.
              </span>
            </CardHeader>
            <CardBody>
              {recoveryDone ? (
                <div className="text-sm text-emerald-600 dark:text-emerald-400 mb-3">
                  Password updated. Sign in with the new password.
                </div>
              ) : null}
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setFormError(null);
                  setBusy(true);
                  try {
                    await signIn(email, password);
                  } catch (err) {
                    setFormError((err as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
                className="space-y-3"
              >
                <Field label="Email">
                  <Input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoFocus
                    autoComplete="email"
                  />
                </Field>
                <Field label="Password">
                  <Input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                </Field>
                {formError ? (
                  <div className="text-sm text-red-600 dark:text-red-400">{formError}</div>
                ) : null}
                <Button type="submit" disabled={busy} className="w-full">
                  {busy ? "Signing inâ€¦" : "Sign in"}
                </Button>
              </form>

              {/* Forgot-password trigger + inline mini-form */}
              <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800">
                {!forgotOpen ? (
                  <button
                    type="button"
                    className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                    onClick={() => {
                      setForgotOpen(true);
                      setForgotEmail(email);
                      setForgotSent(false);
                    }}
                  >
                    Forgot your password?
                  </button>
                ) : (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setFormError(null);
                      setBusy(true);
                      try {
                        await requestPasswordReset(forgotEmail);
                        setForgotSent(true);
                      } catch (err) {
                        setFormError((err as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                    className="space-y-2"
                  >
                    <div className="text-xs text-slate-500">
                      Enter your email and we'll send a reset link.
                    </div>
                    <Field label="Email">
                      <Input
                        type="email"
                        required
                        value={forgotEmail}
                        onChange={(e) => setForgotEmail(e.target.value)}
                        autoComplete="email"
                      />
                    </Field>
                    {forgotSent ? (
                      <div className="text-xs text-emerald-600 dark:text-emerald-400">
                        Reset link sent. Check your inbox (and spam).
                      </div>
                    ) : null}
                    <div className="flex items-center gap-2">
                      <Button type="submit" disabled={busy} className="flex-1">
                        {busy ? "Sendingâ€¦" : forgotSent ? "Send again" : "Send reset link"}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => { setForgotOpen(false); setForgotSent(false); }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    );
  }

  // Signed in but profile not yet ready (loading second pass).
  if (!profile) {
    if (error) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 p-4">
          <Card>
            <CardHeader>
              <CardTitle>Profile not found</CardTitle>
            </CardHeader>
            <CardBody className="space-y-3">
              <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
              <Button variant="secondary" onClick={signOut} className="inline-flex items-center gap-2">
                <LogOut size={14} /> Sign out
              </Button>
            </CardBody>
          </Card>
        </div>
      );
    }
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950">
        <div className="text-sm text-slate-500">Loading profileâ€¦</div>
      </div>
    );
  }

  // Authenticated + profile loaded but no location grants.
  if (locations.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 p-4">
        <Card>
          <CardHeader>
            <CardTitle>No location access</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            <div className="text-sm text-slate-600 dark:text-slate-400">
              Your account has no location grants. The owner needs to add a row to
              <code className="mx-1 px-1 rounded bg-slate-100 dark:bg-slate-800">user_locations</code>
              giving you access to at least one location.
            </div>
            <Button variant="secondary" onClick={signOut} className="inline-flex items-center gap-2">
              <LogOut size={14} /> Sign out
            </Button>
          </CardBody>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}