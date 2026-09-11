import { NextResponse } from "next/server";
import { createClient } from "@/src/database/server";

export async function POST() {
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signOut();

    if (error) {
      return logoutError();
    }

    return NextResponse.json(
      { success: true },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch {
    return logoutError();
  }
}

function logoutError() {
  return NextResponse.json(
    { error: "Não foi possível terminar a sessão. Tente novamente." },
    {
      status: 500,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
