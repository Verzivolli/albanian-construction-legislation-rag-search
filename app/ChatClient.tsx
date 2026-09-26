"use client";

// KodiAI's KTP chat screen (app/chat/ChatClient.tsx) running on recorded answers: the
// questions below were answered by the real pipeline and saved to public/ktp-demo.json,
// so the demo needs no database, vector index or LLM key.
import { useEffect, useState } from "react";
import { STRINGS, type Lang } from "./strings";

type Citation = {
  id: string;
  ktp_number?: string;
  title?: string;
  status?: string;
  section_level?: string;
  section_number?: string;
};
type QA = { question: string; answer: string; citations: Citation[] };
type KbDocument = { id: string; label: string; title: string | null; status: string | null; source_url: string | null };
type KbReference = KbDocument & { section_label: string | null; text: string };
type DemoData = { recorded_at: string; documents: KbDocument[]; qa: QA[]; references: Record<string, KbReference> };

type Turn =
  | { role: "user"; text: string }
  | { role: "answer"; text: string; citations: Citation[] }
  | { role: "demo"; text: string };

const DEMO_TEXT: Record<Lang, { notRecorded: string; suggestions: string; tagline: string }> = {
  en: {
    notRecorded:
      "This demo only has recorded answers for the example questions below. Live search over all KTP codes is part of KodiAI, still in development.",
    suggestions: "Try an example question",
    tagline: "Albanian design codes (KTP) search",
  },
  sq: {
    notRecorded:
      "Ky demo ka përgjigje të regjistruara vetëm për pyetjet shembull më poshtë. Kërkimi i plotë në të gjitha KTP-të është pjesë e KodiAI, ende në zhvillim.",
    suggestions: "Provo një pyetje shembull",
    tagline: "Kërkim në kushtet teknike (KTP)",
  },
};

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** One chip per section: the pipeline cites each retrieved chunk, and several chunks can share a section label. */
function groupCitations(citations: Citation[]) {
  const groups = new Map<string, { citation: Citation; count: number }>();
  for (const c of citations) {
    const key = `${c.ktp_number}|${c.section_level}|${c.section_number}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { citation: c, count: 1 });
  }
  return [...groups.values()];
}

export default function ChatClient() {
  const [lang, setLang] = useState<Lang>("sq");
  const [data, setData] = useState<DemoData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(false);
  const [referenceId, setReferenceId] = useState<string | null>(null);

  const t = STRINGS[lang];
  const d = DEMO_TEXT[lang];
  const reference = referenceId ? data?.references[referenceId] ?? null : null;

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("kodiai-lang");
      if (saved === "en" || saved === "sq") setLang(saved);
    } catch {
      // storage blocked: keep the default language
    }
    fetch("/ktp-demo.json")
      .then((r) => (r.ok ? (r.json() as Promise<DemoData>) : Promise.reject()))
      .then(setData)
      .catch(() => setLoadError(true));
  }, []);

  function switchLang(next: Lang) {
    setLang(next);
    try {
      window.localStorage.setItem("kodiai-lang", next);
    } catch {
      // storage blocked: the toggle still works for this visit
    }
  }

  function submit(q: string) {
    if (!q.trim() || loading || !data) return;
    setLoading(true);
    setQuery("");
    setTurns((prev) => [...prev, { role: "user", text: q }]);
    const hit = data.qa.find((item) => normalize(item.question) === normalize(q));
    // Short pause so the flow reads like a search, not an instant lookup.
    setTimeout(() => {
      setTurns((prev) => [
        ...prev,
        hit ? { role: "answer", text: hit.answer, citations: hit.citations } : { role: "demo", text: d.notRecorded },
      ]);
      setLoading(false);
    }, 600);
  }

  const asked = new Set(turns.filter((turn) => turn.role === "user").map((turn) => normalize(turn.text)));
  const suggestions = (data?.qa ?? []).filter((item) => !asked.has(normalize(item.question)));

  return (
    <main className={referenceId ? "chat-page has-reference" : "chat-page"}>
      <div className="demo-banner">
        Demo — KodiAI, work in progress. Answers were recorded from the real search pipeline for the example questions.
      </div>
      <header className="site">
        <div className="wrap site-nav">
          <div className="brand">
            <span className="dot" />
            KodiAI · KTP
          </div>
          <nav className="nav-links">
            <span>{d.tagline}</span>
            <span className="lang-toggle" role="group" aria-label="Language">
              <span className={lang === "en" ? "active" : ""} onClick={() => switchLang("en")}>
                EN
              </span>
              <span className={lang === "sq" ? "active" : ""} onClick={() => switchLang("sq")}>
                SQ
              </span>
            </span>
          </nav>
        </div>
      </header>

      <div className="chat-shell">
        <aside className="doc-sidebar" aria-label="Search scope">
          <div className="doc-sidebar-head">
            <div>
              <div className="sidebar-title">Sources</div>
              <div className="sidebar-count">{data?.documents.length ?? 0} KTP documents indexed</div>
            </div>
          </div>
          {!data && !loadError && <div className="sidebar-note">Loading sources...</div>}
          {loadError && <div className="sidebar-note error">Demo data failed to load.</div>}
          {data && (
            <div className="doc-list">
              {[...data.documents].sort((x, y) => x.label.localeCompare(y.label, "sq", { numeric: true })).map((document) => (
                <details key={document.id} className="doc-row">
                  <summary style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
                    <span className="doc-compact">
                      <span className="doc-label">{document.label}</span>
                      <span className="doc-title">{document.title ?? document.id}</span>
                    </span>
                  </summary>
                  <div className="doc-expanded">
                    <div>{document.title ?? document.id}</div>
                    <div className="doc-meta">{document.status}</div>
                  </div>
                </details>
              ))}
            </div>
          )}
        </aside>

        <section className="chat-main">
          <div className="chat-stream">
            {turns.map((turn, i) => {
              if (turn.role === "user") {
                return (
                  <div key={i} className="msg-user">
                    {turn.text}
                  </div>
                );
              }
              if (turn.role === "demo") {
                return (
                  <div key={i} className="msg-state msg-nomatch">
                    <div className="msg-icon">i</div>
                    <div>
                      <div className="msg-title">Demo</div>
                      <p className="msg-body">{turn.text}</p>
                    </div>
                  </div>
                );
              }
              return (
                <div key={i} className="msg-answer">
                  <p>{turn.text}</p>
                  <div className="calc-strip" style={{ justifyContent: "flex-start" }}>
                    {groupCitations(turn.citations).map(({ citation, count }) => (
                      <button
                        key={citation.id}
                        type="button"
                        className="calc-chip citation-chip"
                        onClick={() => setReferenceId(citation.id)}
                      >
                        {citation.ktp_number ? `KTP ${citation.ktp_number}` : ""}
                        {citation.section_level && citation.section_number
                          ? ` ${citation.section_level} ${citation.section_number}`
                          : ""}
                        {count > 1 && <span className="citation-count">×{count}</span>}
                        <span className="ref">{citation.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}

            {data && suggestions.length > 0 && !loading && (
              <div className="suggestions">
                <div className="suggestions-title">{d.suggestions}</div>
                {suggestions.map((item) => (
                  <button key={item.question} type="button" className="suggestion" onClick={() => submit(item.question)}>
                    {item.question}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="chat-input-row">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit(query)}
              placeholder="Pyet për kushtet teknike të projektimit (KTP)..."
              disabled={loading || !data}
            />
            <button className="btn btn-primary" onClick={() => submit(query)} disabled={loading || !data}>
              {loading ? t.searching : t.ask}
            </button>
          </div>
        </section>
      </div>

      {referenceId && (
        <aside className="reference-drawer" aria-label="Citation reference">
          <div className="reference-head">
            <div>
              <div className="sidebar-title">Reference</div>
              <div className="sidebar-count">{reference?.label ?? referenceId}</div>
            </div>
            <button type="button" className="drawer-close" onClick={() => setReferenceId(null)}>
              Close
            </button>
          </div>
          {reference ? (
            <div className="reference-body">
              <div className="reference-label">{reference.label}</div>
              {reference.title && <h2>{reference.title}</h2>}
              {reference.section_label && <div className="reference-section">{reference.section_label}</div>}
              {reference.status && <div className="reference-status">{reference.status}</div>}
              <p>{reference.text}</p>
            </div>
          ) : (
            <div className="sidebar-note error">Reference not available in this demo.</div>
          )}
        </aside>
      )}
    </main>
  );
}
