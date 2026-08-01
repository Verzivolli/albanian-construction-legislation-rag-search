// Supabase client for use INSIDE Client Components (e.g. login/register
// forms) -- calls like signUp/signInWithPassword/signOut run from here.
// No cookie configuration needed: in a browser environment, createBrowserClient
// automatically reads/writes the session via the browser's own cookies.
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  );
}
