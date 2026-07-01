"use client";

import { FormEvent, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff, Lock, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ApiResult } from "@/types/api";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    const formData = new FormData(event.currentTarget);

    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: formData.get("email"),
        password: formData.get("password"),
      }),
    });
    const result = (await response.json()) as ApiResult<unknown>;

    if (result.status === "success") {
      router.replace(searchParams.get("redirect") ?? "/dashboard");
      router.refresh();
      return;
    }

    setError(result.message);
    setLoading(false);
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <label className="block space-y-2">
        <span className="text-sm font-medium">E-mail</span>
        <div className="relative">
          <Mail className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
          <Input
            className="pl-9 text-slate-950"
            name="email"
            placeholder="usuario@alffafibra.com.br"
            required
            type="email"
          />
        </div>
      </label>
      <label className="block space-y-2">
        <span className="text-sm font-medium">Senha</span>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
          <Input
            className="pl-9 pr-10 text-slate-950"
            name="password"
            placeholder="Digite sua senha"
            required
            type={showPassword ? "text" : "password"}
          />
          <button
            aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
            className="absolute right-3 top-3 text-slate-400"
            onClick={() => setShowPassword((current) => !current)}
            type="button"
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </label>
      {error ? <p className="rounded-md bg-red-500/15 p-3 text-sm text-red-100">{error}</p> : null}
      <Button className="w-full" disabled={loading} type="submit">
        {loading ? "Entrando" : "Entrar"}
      </Button>
    </form>
  );
}
