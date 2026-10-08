import { createFileRoute, redirect } from "@tanstack/react-router";
import { auth } from "@/api/http";
import { LoginPage } from "@/pages/login";

/** Only same-origin paths: `from` comes from the URL, so never follow `//host` or `https://…`. */
const safePath = (value: unknown) =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : undefined;

export const Route = createFileRoute("/login")({
  validateSearch: (search): { from?: string } => {
    const from = safePath(search.from);
    return from ? { from } : {};
  },
  beforeLoad: ({ search }) => {
    if (auth.token()) throw redirect({ href: search.from ?? "/", replace: true });
  },
  component: LoginPage,
});
