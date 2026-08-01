// Runs BEFORE every matching request (see config.matcher below), on every
// navigation. This is the one place a refreshed Supabase session token
// actually gets written back -- Server Components are read-only and can't
// do this themselves (see lib/supabase/server.ts's comment). Skipping this
// file is the single most common cause of "random logout" bugs in a
// Supabase + Next.js app, per the library's own documentation.
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        // Real signature confirmed against the installed package's own
        // types.d.ts: setAll takes a SECOND `headers` argument (Cache-
        // Control etc.) that must be applied to the response too, so a
        // CDN/reverse proxy never caches one user's session cookie onto a
        // different user's response.
        setAll(cookiesToSet, headers) {
          // Update the request's own cookies too (not just the response)
          // so any code running LATER in this same request, further down
          // the pipeline, sees the refreshed session -- not just the
          // browser on its NEXT request.
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
          Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
        },
      },
    }
  );

  // getClaims() (not getSession()/getUser()) is what the package's own
  // types now recommend here -- it verifies the token AND triggers a
  // refresh if the current one has expired, writing the new one back via
  // setAll above.
  await supabase.auth.getClaims();

  return response;
}

export const config = {
  // Run on everything EXCEPT static assets/images -- those never need an
  // auth check, so skipping them keeps every other request fast.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
