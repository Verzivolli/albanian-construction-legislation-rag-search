// Supabase client for use in Server Components / Route Handlers -- checks
// "who's logged in" during server-side rendering. Server Components can't
// write cookies themselves (read-only), so `setAll` here is best-effort;
// the actual session-refresh write-back happens in middleware.ts instead.
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  // cookies() is async in this Next.js version -- same Promise-based
  // pattern we already confirmed for dynamic route params.
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component that can't set cookies (only
            // Route Handlers/Server Actions can) -- safe to ignore here,
            // since middleware.ts is what actually refreshes+persists the
            // session on every request regardless.
          }
        },
      },
    }
  );
}
