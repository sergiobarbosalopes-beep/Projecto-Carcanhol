import { NextResponse } from "next/server";
import { z } from "zod";
import { hasCarcanholMembership } from "@/src/auth/membership";
import { createClient } from "@/src/database/server";

const GENERIC_LOGIN_ERROR =
  "Não foi possível iniciar sessão. Verifique os dados ou contacte o administrador.";

const loginSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(1).max(4096),
  })
  .strict();

function loginError(status: number) {
  return NextResponse.json(
    { error: GENERIC_LOGIN_ERROR },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return loginError(400);
  }

  const credentials = loginSchema.safeParse(body);

  if (!credentials.success) {
    return loginError(400);
  }

  try {
    return await authenticate(credentials.data);
  } catch {
    return loginError(503);
  }
}

async function authenticate(credentials: z.infer<typeof loginSchema>) {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword(credentials);

  if (error || !data.user) {
    return loginError(401);
  }

  let hasMembership = false;

  try {
    hasMembership = await hasCarcanholMembership(supabase, data.user.id);
  } catch {
    const { error: signOutError } = await supabase.auth.signOut({
      scope: "local",
    });

    return loginError(signOutError ? 500 : 503);
  }

  if (!hasMembership) {
    const { error: signOutError } = await supabase.auth.signOut({
      scope: "local",
    });

    return loginError(signOutError ? 500 : 401);
  }

  return NextResponse.json(
    { success: true },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
