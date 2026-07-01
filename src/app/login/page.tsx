import { Suspense } from "react";
import { BrandLogo } from "@/components/layout/brand-logo";
import { LoginForm } from "@/modules/usuarios/components/login-form";

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-alffa-navy px-4 text-white">
      <div className="w-full max-w-md rounded-lg border border-white/10 bg-white/8 p-6 shadow-2xl backdrop-blur">
        <div className="mb-8 text-center">
          <BrandLogo className="mx-auto mb-4" priority />
          <h1 className="text-2xl font-semibold">ALFFA FIBRA</h1>
          <p className="mt-1 text-sm text-cyan-100">CRM Enterprise</p>
        </div>
        <Suspense fallback={<div className="h-48 rounded-md bg-white/5" />}>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
