import { useState } from "react";
import { OptionSelect } from "@/components/option-select";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { SECTION_META, SETTINGS_SECTIONS, parseSection, type SettingsSection } from "./sections";
import { AccountSection, AppearanceSection, PricingSection } from "./settings-sections";

const BODY: Record<SettingsSection, () => React.ReactNode> = {
  pricing: PricingSection,
  appearance: AppearanceSection,
  account: AccountSection,
};

/** Global settings in a dialog with its own sidebar, after shadcn's `sidebar-13`. Open while `section` is set. */
export function SettingsDialog({
  section,
  onSectionChange,
  onClose,
}: {
  section: SettingsSection | undefined;
  onSectionChange: (section: SettingsSection) => void;
  onClose: () => void;
}) {
  // Keep the last section rendered while the dialog fades out.
  const [shown, setShown] = useState<SettingsSection>("pricing");
  if (section && section !== shown) setShown(section);
  const meta = SECTION_META[shown];
  const Body = BODY[shown];

  return (
    <Dialog open={section !== undefined} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="overflow-hidden p-0 md:h-[min(40rem,85vh)] md:max-w-[min(64rem,calc(100%-2rem))] sm:max-w-[min(64rem,calc(100%-2rem))]">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Global settings of the admin console.
        </DialogDescription>
        <SidebarProvider className="min-h-0 items-start">
          <Sidebar collapsible="none" className="hidden md:flex">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {SETTINGS_SECTIONS.map((s) => {
                      const { label, icon: Icon } = SECTION_META[s];
                      return (
                        <SidebarMenuItem key={s}>
                          <SidebarMenuButton
                            isActive={s === shown}
                            onClick={() => onSectionChange(s)}
                          >
                            <Icon />
                            <span>{label}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
          <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
            <header className="flex h-14 shrink-0 items-center gap-2 px-4 pr-12">
              <Breadcrumb className="hidden md:block">
                <BreadcrumbList>
                  <BreadcrumbItem>Settings</BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>{meta.label}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
              <OptionSelect
                aria-label="Settings section"
                className="w-auto min-w-36 md:hidden"
                value={shown}
                onValueChange={(v) => {
                  const next = parseSection(v);
                  if (next) onSectionChange(next);
                }}
                options={SETTINGS_SECTIONS.map((s) => ({ value: s, label: SECTION_META[s].label }))}
              />
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 pt-0">
              <p className="text-muted-foreground">{meta.description}</p>
              <Body />
            </div>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
}
