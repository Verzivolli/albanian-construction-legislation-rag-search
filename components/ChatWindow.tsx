// The interactive chat UI -- the first Client Component in this project
// ("use client" below). Everything in this file runs in the browser, not
// just on the server, because it needs to hold state and react to clicks.
"use client";

import { useState, useEffect, useRef } from "react";

// One citation, matching lib/generate.ts's Citation shape -- the id is
// what a click will use to load the real article into the reference panel.
interface Citation {
  id: string;
  citation: string;
}

// One entry in the conversation. citations/followUps are optional -- only
// assistant messages have them, a user's own question never does.
interface Message {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  followUps?: string[];
}

// Key used to save/restore the conversation in localStorage (decided
// 2026-07-29 -- survive a page refresh, but only on this one browser).
// Bumped to v2 (2026-08-01): citations changed shape (string[] ->
// {id, citation}[]) for the reference-panel feature -- old saved
// conversations have the wrong shape and would break the render (missing
// `key`s, blank badges) if loaded as-is. A real production app would need
// a proper versioned-migration strategy; for this dev-stage project,
// simply starting fresh under a new key is an honest, sufficient fix.
const STORAGE_KEY = "albanian-construction-chat-v2";

// Shown only when the conversation is empty -- gives a reviewer landing
// cold something concrete to tap, instead of a blank box with no hint of
// what the assistant can actually answer. Scoped to real questions the
// pilot legislation corpus can ground (see plan.md -- chat is
// legislation-only right now, Eurocodes aren't wired in yet).
const EXAMPLE_QUESTIONS = [
  "Kush cakton mbikëqyrësin e punimeve?",
  "Çfarë dokumentesh kërkohen përpara fillimit të punimeve?",
  "Cilat janë detyrat e mbikëqyrësit të punimeve?",
];

interface ChatWindowProps {
  // Which laws the sidebar currently has toggled on -- forwarded to
  // /api/chat as-is, see lib/retrieve.ts's `lawIds` filter (2026-08-01).
  selectedLawIds: string[];
  // Called with an article id when a citation badge is clicked -- owned by
  // ChatLayout, which passes it down to ReferencePanel too.
  onCitationClick: (articleId: string) => void;
}

export default function ChatWindow({ selectedLawIds, onCitationClick }: ChatWindowProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  // null until the first /api/chat response hands one back -- see
  // app/api/chat/route.ts, which mints a fresh sessionId when it gets null.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs (2026-08-01, new to this project): a ref is a mutable box React
  // hands back that survives across re-renders WITHOUT triggering one when
  // you change it -- the opposite of useState, which re-renders on every
  // change. Used here to reach into the real DOM directly: `messagesEndRef`
  // marks an empty div at the bottom of the message list so we can scroll
  // to it; `inputRef` points at the actual <input> element so we can call
  // its native `.focus()`. Neither of these is "data to display," so
  // useState would be the wrong tool -- refs exist exactly for this kind
  // of direct DOM access.
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Runs ONCE, right after this component first appears on screen -- the
  // empty dependency array `[]` at the end is what means "only on mount,
  // never again". Reading localStorage is a side effect (touches something
  // outside React's own rendering, i.e. the browser's storage), not a pure
  // calculation of what to display -- that distinction is exactly what
  // useEffect exists for. Restores a saved conversation from a previous
  // visit, if one exists.
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      setMessages(parsed.messages);
      setSessionId(parsed.sessionId);
    }
  }, []);

  // Runs every time `messages` OR `sessionId` changes -- that's what the
  // dependency array [messages, sessionId] means, as opposed to the empty
  // array above. Writes the current conversation back out to localStorage,
  // so a refresh a moment later finds it again via the effect above.
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ messages, sessionId }));
  }, [messages, sessionId]);

  // Auto-scroll to the newest message. Runs after every change to
  // `messages` -- scrollIntoView is a real DOM method, only reachable
  // through the ref, not something React's own rendering can do for us.
  // Respects prefers-reduced-motion (2026-08-01, self-critique pass): a
  // user who's asked their OS to minimize motion gets an instant jump
  // instead of the smooth animated scroll.
  useEffect(() => {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    messagesEndRef.current?.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth" });
  }, [messages]);

  // Auto-focus the input on first load, and again after each reply lands
  // (loading flips back to false) -- lets someone keep typing a follow-up
  // without an extra click.
  useEffect(() => {
    if (!loading) inputRef.current?.focus();
  }, [loading]);

  async function submitQuestion(question: string) {
    if (!question.trim() || loading) return; // ignore empty submits / double-submits

    setInput("");
    setError(null);
    // Optimistic update: show the user's own message immediately, rather
    // than waiting on the network round-trip just to display what they
    // themselves already typed.
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, sessionId, lawIds: selectedLawIds }),
      });
      const data = await res.json();

      if (!res.ok) {
        // Matches route.ts's error shape: { error: "..." }. Covers both
        // the 429 rate-limit message and any 500 -- whatever text the
        // server sent is shown as-is.
        setError(data.error ?? "Something went wrong.");
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: data.answer,
            citations: data.citations,
            followUps: data.followUps,
          },
        ]);
        // Remember whatever sessionId the route used (freshly minted on
        // the very first message, or echoed back unchanged after that) so
        // the NEXT message continues this same conversation.
        setSessionId(data.sessionId);
      }
    } catch {
      setError("Gabim rrjeti -- serveri nuk u arrit.");
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    submitQuestion(input);
  }

  // Clears the visible conversation AND its localStorage copy, starting a
  // brand-new session on the next question (sessionId reset to null, same
  // as a first-ever visit).
  function handleStartOver() {
    setMessages([]);
    setSessionId(null);
    setError(null);
    localStorage.removeItem(STORAGE_KEY);
  }

  return (
    <div className="flex w-full max-w-2xl flex-1 flex-col gap-4">
      {messages.length === 0 ? (
        // Empty state -- only shown before the first message. Tapping an
        // example calls submitQuestion() directly (not just filling the
        // input), so it's a true one-tap ask, not an extra step.
        <div className="flex flex-col gap-3 py-6">
          <p className="font-mono text-xs tracking-[0.15em] text-steel uppercase">
            Provo një pyetje
          </p>
          <div className="flex flex-col gap-2">
            {/* focus-visible (2026-08-01, self-critique pass, new to this
                project): a CSS pseudo-class that only matches when focus
                arrived via keyboard (Tab), not a mouse click -- unlike
                plain `focus`, which fires either way. Ring stays hidden
                for mouse users (a click doesn't need a focus indicator,
                the click itself was visible feedback) but appears for
                keyboard users, who have no other way to see which element
                is active. Applied consistently across every interactive
                element in this file/DocumentSidebar/ReferencePanel/
                ThemeToggle -- previously only the text input had any
                focus styling at all. */}
            {EXAMPLE_QUESTIONS.map((q) => (
              <button
                key={q}
                onClick={() => submitQuestion(q)}
                className="rounded border border-dashed border-rebar/60 px-3 py-2 text-left text-sm text-ink hover:bg-rebar/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rebar focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <p className="font-mono text-xs tracking-[0.15em] text-steel uppercase">Biseda</p>
          <button
            onClick={handleStartOver}
            className="font-mono text-xs tracking-[0.1em] text-steel underline hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rebar focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            Rifillo
          </button>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {/* Using the array index as `key` is normally discouraged in React
            (breaks if items get reordered/removed), but this list is
            append-only -- messages are never reordered or deleted -- so
            it's safe here. */}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="self-end rounded-lg bg-rebar px-4 py-2 text-trace">
              <p>{m.content}</p>
            </div>
          ) : (
            // Assistant answers rendered as a "document excerpt" card, on
            // Parchment -- the honest metaphor: this text really is a
            // grounded quote/paraphrase of real law, not a generic bubble.
            <div key={i} className="self-start rounded-lg bg-parchment px-4 py-3 text-graphite">
              <p className="whitespace-pre-line">{m.content}</p>
              {m.citations && m.citations.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {/* The signature element: each citation as a small
                      stamped-looking badge -- dashed border, mono type,
                      alternating slight rotation like a real ink stamp --
                      instead of a plain trailing "Citations: ..." line. */}
                  {m.citations.map((c, j) => (
                    // A real button now, not a static span -- clicking
                    // loads the actual article into the reference panel
                    // via GET /api/articles/:id (ChatLayout owns the fetch
                    // trigger, this just reports which id was clicked).
                    <button
                      key={c.id}
                      onClick={() => onCitationClick(c.id)}
                      className={`rounded border border-dashed border-rebar px-1.5 py-0.5 font-mono text-[11px] text-rebar hover:bg-rebar/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rebar focus-visible:ring-offset-2 focus-visible:ring-offset-parchment ${
                        j % 2 === 0 ? "-rotate-1" : "rotate-1"
                      }`}
                    >
                      {c.citation}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        )}
        {/* Follow-up suggestions -- only after the MOST RECENT assistant
            reply (i === messages.length - 1), never on older messages
            further up in history, so the suggestions always match what
            was just answered. Same clickable-chip pattern/styling as the
            empty-state example questions: tapping one calls
            submitQuestion() directly, a real one-tap follow-up, not just
            filling the input. Naturally stops showing the instant a new
            question is asked -- the last message becomes the user's new
            one, not this assistant reply, so the condition below no
            longer matches. */}
        {!loading &&
          messages.length > 0 &&
          messages[messages.length - 1].role === "assistant" &&
          messages[messages.length - 1].followUps &&
          messages[messages.length - 1].followUps!.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="font-mono text-xs tracking-[0.15em] text-steel uppercase">
                Vazhdo me
              </p>
              {messages[messages.length - 1].followUps!.map((q) => (
                <button
                  key={q}
                  onClick={() => submitQuestion(q)}
                  className="rounded border border-dashed border-rebar/60 px-3 py-2 text-left text-sm text-ink hover:bg-rebar/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rebar focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                >
                  {q}
                </button>
              ))}
            </div>
          )}
        <div ref={messagesEndRef} />
      </div>

      {error && (
        <div className="rounded border-l-2 border-rebar bg-rebar/10 px-3 py-2 text-sm text-ink">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex gap-2">
        {/* Uses `focus:` here, not `focus-visible:` like the buttons below
            -- a text field's own focus ring is expected feedback for
            BOTH mouse and keyboard (clicking into a field to type is a
            different action from clicking a button), so it should always
            show, not just for keyboard navigation. */}
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Pyet për legjislacionin e ndërtimit..."
          className="flex-1 rounded-lg border border-steel/40 bg-surface px-3 py-2 font-mono text-sm text-ink placeholder:text-steel focus:border-rebar focus:outline-none focus:ring-2 focus:ring-rebar focus:ring-offset-2 focus:ring-offset-surface"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-rebar px-4 py-2 font-medium text-trace disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          {loading ? (
            // Three dots bouncing in sequence, not a static "..." --
            // negative animation-delay values start each dot partway
            // through the bounce cycle immediately, instead of all three
            // beginning in sync and only staggering after the first loop.
            // motion-safe: (2026-08-01, self-critique pass) -- Tailwind's
            // built-in prefers-reduced-motion gate. A user who's told
            // their OS to minimize motion gets three static dots instead
            // of a bouncing animation; motion-safe:animate-bounce only
            // applies the animation when the OS setting allows it.
            <span className="flex items-center gap-1" aria-label="Duke kërkuar">
              <span className="h-1.5 w-1.5 motion-safe:animate-bounce rounded-full bg-trace [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 motion-safe:animate-bounce rounded-full bg-trace [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 motion-safe:animate-bounce rounded-full bg-trace" />
            </span>
          ) : (
            "Dërgo"
          )}
        </button>
      </form>
    </div>
  );
}
