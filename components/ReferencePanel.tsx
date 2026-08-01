// Right panel (2026-08-01): shows the real article behind whichever
// citation was last clicked in the chat. Fetches GET /api/articles/:id --
// already-built, already-tested, real Postgres data -- not a mock/temp
// store, per the "Option A" decision (see plan.md) over faking it.
"use client";

import { useState, useEffect } from "react";

interface ArticleDetail {
  id: string;
  unitType: number;
  unitNumber: string;
  chapter: string | null;
  text: string;
  lawId: string;
  lawTitle: string;
  citation: string;
}

interface ReferencePanelProps {
  articleId: string;
  onClose: () => void;
}

export default function ReferencePanel({ articleId, onClose }: ReferencePanelProps) {
  const [article, setArticle] = useState<ArticleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Re-fetches every time `articleId` changes -- clicking a DIFFERENT
  // citation while the panel is already open should load the new one, not
  // just leave the old content showing.
  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/articles/${articleId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.article) setArticle(data.article);
        else setError(data.error ?? "Nuk u gjet.");
      })
      .catch(() => setError("Gabim rrjeti -- serveri nuk u arrit."))
      .finally(() => setLoading(false));
  }, [articleId]);

  return (
    <aside className="flex w-full flex-col gap-3 rounded-lg border border-steel/30 bg-parchment p-4 text-graphite lg:w-96">
      <div className="flex items-center justify-between">
        <p className="font-mono text-xs tracking-[0.15em] text-steel uppercase">Referenca</p>
        <button
          onClick={onClose}
          aria-label="Mbyll referencën"
          className="text-steel hover:text-graphite focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rebar focus-visible:ring-offset-2 focus-visible:ring-offset-parchment"
        >
          ✕
        </button>
      </div>

      {loading && (
        <p className="font-mono text-sm text-steel">Duke ngarkuar...</p>
      )}
      {error && <p className="text-sm text-rebar">{error}</p>}
      {article && !loading && (
        <>
          <p className="font-mono text-xs text-rebar">{article.citation}</p>
          <p className="text-xs text-steel">{article.lawTitle}</p>
          <p className="whitespace-pre-line text-sm">{article.text}</p>
        </>
      )}
    </aside>
  );
}
