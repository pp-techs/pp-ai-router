import { ArrowRightIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { api } from "@/api/client";
import { auth } from "@/api/http";
import { BrandMark } from "@/components/layout";
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
  const [reveal, setReveal] = useState(false);
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
      <div className="flex w-full max-w-sm flex-col items-center gap-4">
        <Card className="w-full">
          <CardHeader className="items-center text-center">
            <BrandMark className="mx-auto mb-2 size-10 rounded-xl" />
            <CardTitle className="text-xl">AI Router</CardTitle>
            <CardDescription>
              Sign in with the admin token (the server's ADMIN_TOKEN).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
              <FormField label="Admin token">
                <div className="relative">
                  <Input
                    type={reveal ? "text" : "password"}
                    autoComplete="current-password"
                    required
                    autoFocus
                    className="pr-9"
                    aria-invalid={error ? true : undefined}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="absolute top-1/2 right-1 -translate-y-1/2"
                    aria-label={reveal ? "Hide token" : "Show token"}
                    onClick={() => setReveal((v) => !v)}
                  >
                    {reveal ? <EyeOffIcon /> : <EyeIcon />}
                  </Button>
                </div>
              </FormField>
              <FormError error={error} />
              <Button type="submit" disabled={busy}>
                {busy && <Spinner data-icon="inline-start" />}
                Sign in
                {!busy && <ArrowRightIcon data-icon="inline-end" />}
              </Button>
            </form>
          </CardContent>
        </Card>
        <p className="text-xs text-muted-foreground">
          Self-hosted LLM router · OpenAI and Anthropic compatible
        </p>
      </div>
    </div>
  );
}
