import { createFileRoute } from "@tanstack/react-router";
import { AuditLogsPage } from "@/pages/audit/audit-page";

export const Route = createFileRoute("/_app/audit")({
  staticData: { crumb: "Audit Logs" },
  component: AuditLogsPage,
});
