import type { ReactNode } from "react";
import { Field, FieldDescription } from "@/components/ui/field";
import { Label } from "@/components/ui/label";

/** Label wrapping its control (so no ids are needed to associate them), with an optional hint below. */
export function FormField({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Field className={className}>
      <Label className="flex-col items-stretch gap-2">
        <span>{label}</span>
        {children}
      </Label>
      {hint && <FieldDescription>{hint}</FieldDescription>}
    </Field>
  );
}
