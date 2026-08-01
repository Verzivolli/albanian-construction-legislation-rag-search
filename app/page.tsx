// Landing page -- stays a Server Component (no "use client" here). It
// renders on the server, sends plain HTML down; only the ChatWindow piece
// inside it ships client-side JavaScript to become interactive.
import ChatLayout from "@/components/ChatLayout";
import ThemeToggle from "@/components/ThemeToggle";
import { getLaws } from "@/lib/laws";

// Server Component -- calls getLaws() directly during render (same
// direct-call pattern as the removed /laws page, see plan.md's Decision 1)
// so the sidebar's law list is real data on first paint, not an empty
// list that fills in after a client-side fetch.
export default async function Home() {
  const laws = await getLaws();

  return (
    <div className="flex min-h-screen flex-col items-center gap-6 p-4 sm:p-8">
      {/* Title-block header, styled after a technical drawing's own
          metadata stamp -- tracked-out mono eyebrow label over a plain
          heading, a hairline rule underneath instead of a card/box. */}
      <header className="mt-6 w-full max-w-2xl">
        {/* min-w-0 + flex-1 on the label (2026-08-01, self-critique pass,
            mobile fix): without it, a flex child's default min-width is
            "as wide as its content," so a long tracked-out label refuses
            to wrap and instead pushes/collides with ThemeToggle on narrow
            screens. min-w-0 lets it actually shrink and wrap within its
            own column; flex-shrink-0 on the toggle keeps IT from being
            squeezed instead. */}
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 flex-1 font-mono text-xs tracking-[0.15em] text-steel uppercase">
            Asistent AI · Legjislacioni i Ndërtimit
          </p>
          <div className="flex-shrink-0">
            <ThemeToggle />
          </div>
        </div>
        <h1 className="mt-1 text-2xl font-semibold text-ink">
          Pyetje mbi legjislacionin e ndërtimit
        </h1>
        <div className="mt-3 h-px w-full bg-steel/40" />
      </header>
      <ChatLayout laws={laws} />
    </div>
  );
}
