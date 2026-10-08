import { useNavigate } from "@tanstack/react-router";
import type { SettingsSection } from "./sections";

/** Opens the settings dialog by setting `?settings=` on the current page, so it survives a reload and Back closes it. */
export function useOpenSettings() {
  const navigate = useNavigate();
  return (section: SettingsSection = "pricing") =>
    void navigate({ to: ".", search: (prev) => ({ ...prev, settings: section }) });
}
