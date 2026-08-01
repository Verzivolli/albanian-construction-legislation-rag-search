// Left sidebar (2026-08-01): the dynamic, DB-backed list of laws the chat
// can search. Each law has a toggle (include/exclude from search scope)
// and, where the database has one, a link straight to the official source
// document -- two separate actions, not the same click.
"use client";

import type { LawSummary } from "@/lib/laws";

interface DocumentSidebarProps {
  laws: LawSummary[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
}

export default function DocumentSidebar({ laws, selectedIds, onToggle }: DocumentSidebarProps) {
  return (
    <aside className="flex w-full flex-col gap-3 lg:w-80">
      <p className="font-mono text-xs tracking-[0.15em] text-steel uppercase">Dokumentet</p>
      <div className="flex flex-col gap-2">
        {laws.map((law) => {
          const isOn = selectedIds.has(law.id);
          return (
            <div
              key={law.id}
              className="flex items-start gap-2 rounded border border-steel/30 px-2 py-2"
            >
              {/* A real checkbox, styled to read as a toggle switch rather
                  than a form checkbox -- accent-color is a plain CSS
                  property that recolors native form controls (checkbox,
                  radio, range) without needing to hand-build one from
                  divs, and it already respects the Rebar accent. */}
              <input
                type="checkbox"
                checked={isOn}
                onChange={() => onToggle(law.id)}
                className="mt-1 accent-rebar focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rebar focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                aria-label={`Përfshi "${law.title}" në kërkim`}
              />
              <div className="min-w-0 flex-1">
                <p className={`truncate text-xs ${isOn ? "text-ink" : "text-steel"}`}>
                  {law.title}
                </p>
                <div className="mt-0.5 flex items-center gap-2">
                  <span className="font-mono text-[10px] text-steel">
                    {law.law_type} {law.law_number}
                  </span>
                  {law.link && (
                    <a
                      href={law.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-[10px] text-rebar underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rebar focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                      title="Hap burimin zyrtar"
                    >
                      burimi ↗
                    </a>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
