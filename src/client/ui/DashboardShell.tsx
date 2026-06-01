import { Button, Chip, Tab, Tabs } from "@heroui/react";
import { LogOut, Moon, Radio, Settings, Sun, User } from "lucide-react";
import type { ReactNode } from "react";
import { FiniusLogo } from "./FiniusLogo";
import { useTheme } from "../theme";
import type { TabKey } from "./state/urlState";

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  return (
    <Button
      isIconOnly
      radius="full"
      variant="bordered"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      onPress={toggle}
    >
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </Button>
  );
}

export function DashboardShell({ tab, live, secure, me, mine, onToggleMine, onTabChange, onLogout, onOpenSetup, children }: {
  tab: TabKey;
  live: boolean;
  secure?: boolean;
  me?: { email: string | null; displayName: string | null; githubLogin: string | null } | null;
  mine: boolean;
  onToggleMine: () => void;
  onTabChange: (tab: TabKey) => void;
  onLogout: () => void;
  onOpenSetup: () => void;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-[1440px] px-3 py-3 text-foreground">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-3">
            <FiniusLogo size={44} />
            <h1 className="font-display text-5xl font-semibold leading-none tracking-tight text-default-900">Finius</h1>
          </div>
          <Tabs aria-label="Views" color="primary" radius="full" selectedKey={tab} onSelectionChange={(key) => onTabChange(key as TabKey)}>
            <Tab key="home" title="Home" />
            <Tab key="sessions" title="Sessions" />
            <Tab key="people" title="People" />
            <Tab key="models" title="Models" />
          </Tabs>
        </div>
        <div className="flex items-center gap-3">
          {me ? (
            <Button radius="full" variant={mine ? "solid" : "bordered"} color={mine ? "primary" : "default"} startContent={<User size={18} />} onPress={onToggleMine}>
              My sessions
            </Button>
          ) : null}
          {secure ? (
            <Button isIconOnly radius="full" variant="bordered" aria-label="Log out" onPress={onLogout}>
              <LogOut size={18} />
            </Button>
          ) : null}
          <ThemeToggle />
          <Button isIconOnly radius="full" variant="bordered" aria-label="Telemetry setup" onPress={onOpenSetup}>
            <Settings size={18} />
          </Button>
          <Chip color={live ? "success" : "default"} variant={live ? "flat" : "bordered"} startContent={<Radio size={14} className="ml-1" />}>
            {live ? "Live" : "Connecting"}
          </Chip>
        </div>
      </header>
      {children}
    </main>
  );
}
