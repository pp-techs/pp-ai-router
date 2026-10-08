import { Alert, AlertDescription } from "@/components/ui/alert";

export function FormError({ error }: { error: Error | null | string }) {
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>{typeof error === "string" ? error : error.message}</AlertDescription>
    </Alert>
  );
}
