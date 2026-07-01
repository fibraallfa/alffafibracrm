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
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-slate-200 transition-colors hover:bg-white/10 hover:text-white"
            >
              <item.icon className="h-4 w-4" aria-hidden="true" />
              {item.title}
            </Link>
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
