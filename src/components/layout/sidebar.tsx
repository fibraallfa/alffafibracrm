"use client";

import Link from "next/link";
import { BrandLogo } from "@/components/layout/brand-logo";
import { navigationItems } from "@/config/navigation";
import { useCurrentUser } from "@/hooks/use-current-user";

export function Sidebar() {
  const { data: user } = useCurrentUser();
  const visibleItems = navigationItems.filter(
    (item) => user?.role === "ADMIN" || ("employeeVisible" in item) || (!("adminOnly" in item) && Boolean(user?.permissions?.[item.permission])),
  );

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r bg-alffa-navy text-white md:block">
      <div className="flex h-full flex-col">
        <div className="flex h-20 items-center gap-3 border-b border-white/10 px-5">
          <BrandLogo compact priority />
          <div>
            <p className="text-sm font-semibold">ALFFA FIBRA</p>
            <p className="text-xs text-cyan-100">CRM Enterprise</p>
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-3 py-4">
          {visibleItems.map((item) => (
            "comingSoon" in item && item.comingSoon ? (
              <div
                key={item.href}
                className="flex items-center justify-between rounded-md px-3 py-2.5 text-sm font-medium text-slate-400"
              >
                <span className="flex items-center gap-3">
                  <item.icon className="h-4 w-4" aria-hidden="true" />
                  {item.title}
                </span>
                <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-200">
                  Em breve
                </span>
              </div>
            ) : (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center justify-between gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-slate-200 transition-colors hover:bg-white/10 hover:text-white"
              >
                <span className="flex items-center gap-3">
                  <item.icon className="h-4 w-4" aria-hidden="true" />
                  {item.title}
                </span>
                {"badgeLabel" in item && item.badgeLabel ? (
                  <span
                    className={
                      "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] " +
                      ("badgeTone" in item && item.badgeTone === "green"
                        ? "bg-emerald-400/15 text-emerald-200"
                        : "bg-cyan-400/10 text-cyan-200")
                    }
                  >
                    {item.badgeLabel}
                  </span>
                ) : null}
              </Link>
            )
          ))}
        </nav>
        <div className="border-t border-white/10 p-4">
          <p className="text-xs text-slate-300">{user?.role === "ADMIN" ? "Administrador" : "Operador"}</p>
          <p className="truncate text-sm font-semibold">{user?.name ?? "Usuario"}</p>
        </div>
      </div>
    </aside>
  );
}
