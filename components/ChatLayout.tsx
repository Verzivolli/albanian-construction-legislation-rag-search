// Holds state shared between the sidebar and the chat window (2026-08-01).
// Why this file exists at all: app/page.tsx is a Server Component (renders
// once on the server, can't hold React state or respond to clicks), but
// "which laws are toggled on" needs to live somewhere BOTH
// DocumentSidebar (writes it, via checkbox clicks) and ChatWindow (reads
// it, to send with each question) can reach. Neither is a parent of the
// other -- they're siblings -- so the state has to live one level up, in
// a shared parent. This is React's standard "lift state up" pattern, new
// to this project: when two components need to agree on the same piece of
// state, put that state in their nearest common ancestor and pass it down.
"use client";

import { useState } from "react";
import type { LawSummary } from "@/lib/laws";
import DocumentSidebar from "./DocumentSidebar";
import ChatWindow from "./ChatWindow";
import ReferencePanel from "./ReferencePanel";

interface ChatLayoutProps {
  laws: LawSummary[];
}

export default function ChatLayout({ laws }: ChatLayoutProps) {
  // Defaults to ALL laws selected -- search-everything, matching the
  // behavior before this feature existed. Toggling narrows it, never
  // starts from an empty (i.e. searches-nothing) scope.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(laws.map((l) => l.id))
  );
  // Which article the right panel should show -- null means the panel
  // isn't open at all (not just empty). Lives here for the same "lift
  // state up" reason as selectedIds: ChatWindow sets it (clicking a
  // citation), ReferencePanel reads it, they're siblings.
  const [activeArticleId, setActiveArticleId] = useState<string | null>(null);

  function handleToggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      // A Set's `has`/`delete`/`add` are the three operations a checkbox
      // toggle needs -- no manual array find/splice/filter juggling.
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    // max-w-[1440px], not a stock Tailwind size (2026-08-01) -- sized to
    // actually fit sidebar (320px) + chat (max-w-2xl, 672px) + reference
    // panel (384px) + gaps side by side without squeezing, now that both
    // panels were widened.
    <div className="flex w-full max-w-[1440px] flex-col gap-6 lg:flex-row lg:items-start">
      <DocumentSidebar laws={laws} selectedIds={selectedIds} onToggle={handleToggle} />
      <ChatWindow
        selectedLawIds={Array.from(selectedIds)}
        onCitationClick={setActiveArticleId}
      />
      {activeArticleId && (
        <ReferencePanel articleId={activeArticleId} onClose={() => setActiveArticleId(null)} />
      )}
    </div>
  );
}
