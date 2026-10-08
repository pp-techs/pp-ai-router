import { useState } from "react";
import { toast } from "../lib/toast.ts";
import { Button } from "./button.tsx";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Clipboard is unavailable here; select the text and copy it manually.");
    }
  }

  return (
    <Button small onClick={() => void copy()}>
      {copied ? "Copied ✓" : label}
    </Button>
  );
}
