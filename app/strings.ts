// Whole-site i18n mechanism per 1.7 (IMPLEMENTATION-ROADMAP.md): a plain dictionary keyed by
// UI lang, persisted client-side in localStorage -- no i18n library (none installed,
// deliberately not adding one per web/package.json review). Content behind the search itself
// is answered by the model in the query's language regardless of this toggle; this dictionary
// only covers static chrome strings. Scoped to /chat for now -- extend to the landing page's
// existing (stubbed) lang-toggle by reusing this same dictionary shape when that's tackled.
export type Lang = "en" | "sq";

export const STRINGS: Record<Lang, Record<string, string>> = {
  en: {
    tagline: "Legal & code search",
    placeholder: "Ask about Albanian construction law...",
    ask: "Ask",
    searching: "Searching...",
    noMatchTitle: "No confident match found",
    errorTitle: "Something went wrong",
    errorBody: "Request failed — server didn't respond. Your question wasn't lost.",
    retry: "Retry",
    signOut: "Sign out",
    empty: "Ask a question to get started. Last 5 turns are kept in this chat only, nothing saved server-side.",
  },
  sq: {
    tagline: "Kërkim ligjor dhe kodesh",
    placeholder: "Pyet për legjislacionin e ndërtimit...",
    ask: "Pyet",
    searching: "Duke kërkuar...",
    noMatchTitle: "Nuk u gjet përputhje e sigurt",
    errorTitle: "Ndodhi një gabim",
    errorBody: "Kërkesa dështoi — serveri nuk u përgjigj. Pyetja juaj nuk humbi.",
    retry: "Provo përsëri",
    signOut: "Dil",
    empty: "Bëj një pyetje për të filluar. 5 kthesat e fundit ruhen vetëm në këtë chat, asgjë nuk ruhet në server.",
  },
};
