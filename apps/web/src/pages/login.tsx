import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { api } from "../api/client.ts";
import { auth } from "../api/http.ts";
import { Button } from "../components/button.tsx";
import { Field, FormError, Input } from "../components/fields.tsx";
import { useToken } from "../lib/use-token.ts";

export function LoginPage() {
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? "/";
  const stored = useToken();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (stored) return <Navigate to={from} replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.checkToken(token.trim());
      auth.set(token.trim());
      void navigate(from, { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center p-4">
      <form
        onSubmit={(e) => void submit(e)}
        className="grid w-full max-w-sm gap-4 rounded-xl border border-line bg-surface p-6 shadow-sm"
      >
        <div>
          <h1 className="text-xl font-semibold">⇄ AI Router</h1>
          <p className="mt-1 text-muted">
            Sign in with the admin token (the server's ADMIN_TOKEN).
          </p>
        </div>
        <Field label="Admin token">
          <Input
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
        <FormError error={error} />
        <Button type="submit" variant="primary" loading={busy}>
          Sign in
        </Button>
      </form>
    </div>
  );
}
