import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { api } from "@/api/client";
import { auth } from "@/api/http";
import { FormError } from "@/components/form-error";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToken } from "@/lib/use-token";

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
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">⇄ AI Router</CardTitle>
          <CardDescription>
            Sign in with the admin token (the server's ADMIN_TOKEN).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
            <FormField label="Admin token">
              <Input
                type="password"
                autoComplete="current-password"
                required
                autoFocus
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </FormField>
            <FormError error={error} />
            <Button type="submit" disabled={busy}>
              {busy && <Spinner data-icon="inline-start" />}
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
