# Albanian Construction Legislation — RAG Search

A grounded AI chat assistant for Albanian construction law. Ask a question in Albanian, get an answer sourced from real legislation text — every claim is backed by a clickable citation that opens the actual cited article, not a paraphrase or a guess.

Built as a portfolio project to demonstrate a real, working RAG (Retrieval-Augmented Generation) pipeline: chunked legal text → vector search → LLM generation grounded strictly in retrieved context → citations traceable back to source, not hallucinated.

## What it does

- **Ask questions in Albanian**, get answers grounded in real construction-law text (currently: Ligj 8402/1998, Vendim 610/2022, Udhëzim 2/2005 — the pilot legislation set).
- **Every answer cites its source article** (e.g. "Neni 7, Ligj 8402/1998") as a clickable badge — click one and the actual article text loads in a reference panel, so you can verify the answer yourself instead of trusting it blindly.
- **Search-scope sidebar** — toggle which laws are included in retrieval, live. Uncheck a law and the AI genuinely can't draw on it anymore (enforced via a Pinecone metadata filter, not just a UI suggestion).
- **Conversation memory** — follow-up questions ("what about its annexes?") are understood in context via query rewriting, not treated as unrelated new questions.
- **Suggested follow-ups** — after each answer, three relevant next questions appear as one-tap chips.
- **Two-theme design** — a cyanotype/diazo pairing (the real historical blueprint print processes: white-on-blue and the inverted dark-on-cream), not a generic dark/light toggle.

## How it's grounded (the actual RAG pipeline)

1. Source legislation is chunked by its own real legal structure (one chunk per *Neni*/article, not arbitrary character splits) so a citation always points at something a human would recognize as "Article 7," never "part of a sentence."
2. Chunks are embedded and stored in Pinecone; the same chunk text lives in Postgres as the source of truth (Pinecone's copy is never trusted for the actual answer — only for finding *which* chunks are relevant).
3. A question is rewritten for context (if there's prior conversation), then expanded via HyDE (the model imagines a plausible answer passage first, and *that* is what gets embedded and searched — legal prose matches legal prose better than a bare question does).
4. The top matches are re-fetched fresh from Postgres and handed to the LLM with an explicit instruction: answer only from what's given, say so honestly if the context doesn't cover it, cite naturally.
5. Citations shown to the user come from retrieval, never parsed out of the model's own text — the model doesn't get to self-report its sources.

## Stack

- **Frontend/Backend:** Next.js (App Router) + TypeScript, Tailwind CSS v4
- **Relational DB:** PostgreSQL on Supabase — source of truth for law/article text
- **Vector DB:** Pinecone (integrated inference, `multilingual-e5-large`)
- **LLM:** fallback chain — Gemini 2.5 Flash → Groq (Llama) → OpenRouter free tier — no single point of failure, no paid LLM dependency
- **No LangChain** — retrieval, chunking, and the provider-fallback logic are all direct, hand-written implementations; every piece it might have covered turned out simpler done directly for this integrated-inference setup

## Running it locally

```bash
npm install
cp .env.example .env   # fill in your own keys — see below
npm run dev
```

### Environment variables

| Variable | What it's for |
|---|---|
| `DATABASE_URL` | Postgres connection string (Supabase transaction pooler) |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key (client + middleware) |
| `PINECONE_API_KEY` | Pinecone API key |
| `PINECONE_INDEX` | Name of the Pinecone index holding the legislation vectors |
| `GOOGLE_API_KEY` | Gemini (primary LLM) |
| `GROQ_API_KEY` | Groq (fallback 1) |
| `OPENROUTER_API_KEY` | OpenRouter free tier (fallback 2) |

This repo is the **deployable app only** — the Postgres schema and the data-ingestion pipeline (PDF → chunked article rows → embeddings) live in a separate development repo and aren't needed to run the app against an already-populated database.

## Notes on scope

- Rate-limited by IP (50 questions/day) rather than requiring an account — a deliberate scope call for a portfolio demo, not an oversight. See inline comments in `lib/rateLimit.ts`.
- Currently answers from the legislation corpus only; a parallel Eurocodes (European structural design standards) corpus exists and is fully ingested, but isn't wired into the chat pipeline yet.

## Built with AI-assisted development

This project was built collaboratively with Claude Code (Anthropic), used deliberately as a teaching/pairing tool throughout — every architectural decision (chunking strategy, vector DB choice, LLM fallback design, auth vs. rate-limiting tradeoffs) was presented with real alternatives and reasoning before being picked, not auto-generated. The applicant's own domain expertise (co-authored Eurocode national-annex adaptation work, published paper) shaped the actual scope and grounding requirements.
