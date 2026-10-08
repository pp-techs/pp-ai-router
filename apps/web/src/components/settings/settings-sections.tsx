import { LogOutIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { auth } from "@/api/http";
import { OverrideModal } from "@/pages/pricing/override-dialog";
import { OverridesCard } from "@/pages/pricing/overrides-card";
import { PriceSearchCard } from "@/pages/pricing/search-card";
import { PricingSyncCard } from "@/pages/pricing/sync-card";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { setTheme, THEMES, useTheme, type Theme } from "@/theme";

export function PricingSection() {
  return (
    <div className="grid gap-6">
      <PricingSyncCard />
      <OverridesCard
        onNew={() => void OverrideModal.show({ base: null })}
        onEdit={(price) => void OverrideModal.show({ base: price })}
      />
      <PriceSearchCard onOverride={(price) => void OverrideModal.show({ base: price })} />
    </div>
  );
}

const THEME_META: Record<Theme, { label: string; icon: typeof SunIcon }> = {
  system: { label: "System", icon: MonitorIcon },
  light: { label: "Light", icon: SunIcon },
  dark: { label: "Dark", icon: MoonIcon },
};

export function AppearanceSection() {
  const theme = useTheme();
  return (
    <FieldGroup>
      <Field>
        <FieldLabel id="theme-label">Theme</FieldLabel>
        <ToggleGroup
          variant="outline"
          aria-labelledby="theme-label"
          value={[theme]}
          onValueChange={([next]) => next && setTheme(next as Theme)}
        >
          {THEMES.map((t) => {
            const { label, icon: Icon } = THEME_META[t];
            return (
              <ToggleGroupItem key={t} value={t}>
                <Icon />
                {label}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        <FieldDescription>
          System follows your operating system and switches with it. The choice is kept in this
          browser.
        </FieldDescription>
      </Field>
    </FieldGroup>
  );
}

export function AccountSection() {
  return (
    <FieldGroup>
      <Field>
        <FieldLabel>Admin session</FieldLabel>
        <FieldDescription>
          The admin token is kept in this tab's session storage only. Closing the tab or signing out
          forgets it.
        </FieldDescription>
        <div>
          <Button variant="outline" onClick={auth.clear}>
            <LogOutIcon data-icon="inline-start" />
            Sign out
          </Button>
        </div>
      </Field>
    </FieldGroup>
  );
}
