"use client";

import { useEffect } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { BrandLogo } from "@/components/layout/brand-logo";
import { Button } from "@/components/ui/button";
import { clearCurrentUserCache, useCurrentUser } from "@/hooks/use-current-user";

type HeaderProps = {
  title: string;
};

export function Header({ title }: HeaderProps) {
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const { data: user } = useCurrentUser();
  const isDark = theme === "dark";

  useEffect(() => {
    if (!user) return;
    setTheme(user.role === "ADMIN" && user.theme === "dark" ? "dark" : "light");
  }, [setTheme, user?.id, user?.role, user?.theme]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    clearCurrentUserCache();
    router.replace("/login");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
      <div className="flex h-16 items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <BrandLogo compact className="h-10 w-10 md:hidden" imageClassName="p-0.5" />
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-normal">{title}</h1>
            <p className="truncate text-xs text-muted-foreground">ALFFA FIBRA CRM ENTERPRISE</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {user?.role === "ADMIN" ? <Button
            variant="outline"
            size="icon"
            type="button"
            aria-label="Alternar tema"
            title="Alternar tema"
            onClick={() => setTheme(isDark ? "light" : "dark")}
          >
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button> : null}
          <div className="hidden text-right sm:block">
            <p className="text-sm font-medium">{user?.name ?? "Usuário"}</p>
            <button className="text-xs text-muted-foreground hover:text-foreground" onClick={logout} type="button">
              Sair
            </button>
          </div>
          <div className="h-10 w-10 rounded-md bg-alffa-navy text-center text-sm font-bold leading-10 text-cyan-300">
            {(user?.name ?? "A").slice(0, 1).toUpperCase()}
          </div>
        </div>
      </div>
    </header>
  );
}
