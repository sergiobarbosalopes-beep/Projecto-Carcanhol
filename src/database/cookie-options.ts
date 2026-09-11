import "server-only";

import type { CookieOptionsWithName } from "@supabase/ssr";

export const authCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
} satisfies CookieOptionsWithName;
