import { Link, useLocation } from "@tanstack/react-router";
import {
  ChevronsUpDownIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  NetworkIcon,
  PaintbrushIcon,
  ServerIcon,
  Settings2Icon,
  TrendingUpIcon,
  UserIcon,
  type LucideIcon,
} from "lucide-react";
import { auth } from "@/api/http";
import { BrandMark } from "@/components/brand";
import { useOpenSettings } from "@/components/settings/settings-link";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";

const NAV: {
  to: "/" | "/providers" | "/models" | "/keys" | "/usage";
  label: string;
  icon: LucideIcon;
}[] = [
  { to: "/", label: "Overview", icon: LayoutDashboardIcon },
  { to: "/providers", label: "Providers", icon: ServerIcon },
  { to: "/models", label: "Models", icon: NetworkIcon },
  { to: "/keys", label: "API keys", icon: KeyRoundIcon },
  { to: "/usage", label: "Usage", icon: TrendingUpIcon },
];

function NavMain() {
  const pathname = useLocation({ select: (l) => l.pathname });
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Platform</SidebarGroupLabel>
      <SidebarMenu>
        {NAV.map(({ to, label, icon: Icon }) => (
          <SidebarMenuItem key={to}>
            <SidebarMenuButton
              tooltip={label}
              isActive={to === "/" ? pathname === "/" : pathname.startsWith(to)}
              render={<Link to={to} onClick={() => setOpenMobile(false)} />}
            >
              <Icon />
              <span>{label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}

function NavSecondary({ className }: { className?: string }) {
  const openSettings = useOpenSettings();
  return (
    <SidebarGroup className={className}>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Settings" onClick={() => openSettings()}>
              <Settings2Icon />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function UserBadge() {
  return (
    <>
      <Avatar>
        <AvatarFallback>A</AvatarFallback>
      </Avatar>
      <div className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium">Admin</span>
        <span className="truncate text-xs">Token session</span>
      </div>
    </>
  );
}

function NavUser() {
  const { isMobile } = useSidebar();
  const openSettings = useOpenSettings();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<SidebarMenuButton size="lg" className="aria-expanded:bg-muted" />}
          >
            <UserBadge />
            <ChevronsUpDownIcon className="ml-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <UserBadge />
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => openSettings("appearance")}>
                <PaintbrushIcon />
                Appearance
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openSettings("account")}>
                <UserIcon />
                Account
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={auth.clear}>
              <LogOutIcon />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function AppSidebar() {
  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/" />}>
              <BrandMark />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-heading font-semibold">AI Router</span>
                <span className="truncate text-xs">Admin console</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain />
        <NavSecondary className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
