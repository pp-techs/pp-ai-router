import { CoinsIcon, PaintbrushIcon, UserIcon, type LucideIcon } from "lucide-react";

export const SETTINGS_SECTIONS = ["pricing", "appearance", "account"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const SECTION_META: Record<
  SettingsSection,
  { label: string; description: string; icon: LucideIcon }
> = {
  pricing: {
    label: "Pricing",
    description:
      "Prices are USD per 1M tokens. Fetched lists are synced daily; an override always wins.",
    icon: CoinsIcon,
  },
  appearance: {
    label: "Appearance",
    description: "Choose how the console looks on this device.",
    icon: PaintbrushIcon,
  },
  account: {
    label: "Account",
    description: "The admin session of this browser tab.",
    icon: UserIcon,
  },
};

export const parseSection = (value: unknown): SettingsSection | undefined =>
  SETTINGS_SECTIONS.find((s) => s === value);
