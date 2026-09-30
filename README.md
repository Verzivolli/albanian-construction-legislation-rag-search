# KTP Search — KodiAI demo

AI search over Albania's technical design codes (*Kushtet Teknike të Projektimit*, KTP): ask a
question in Albanian, get an answer grounded in the code text, with a citation chip for every
section used. Click a chip to read the cited section itself.

> **Demo of ongoing work.** This is the KTP chat of KodiAI (a construction-engineering assistant
> for Albania, in development), packaged as a standalone app. It runs the **same production
> pipeline** as KodiAI: each visitor can ask **5 questions of their own per day**, answered live,
> follow-ups included. The 8 example questions replay answers recorded from the pipeline and
> don't count toward the limit.

**Live demo:** https://albanian-construction-legislation-r.vercel.app

## Example questions (all recorded live)
Seismic ground categories and the response-spectrum method (KTP N.2-89), wind loads (KTP 7-78),
snow loads (KTP 8-78), masonry design states (KTP 9-78), lightning-protection categories
(KTP 16-78), road design criteria (KTP 22-78), limit states for concrete bridges and culverts
(KTP 21-78, 23-78).

## How the real pipeline works
1. The 24 KTP documents are split along their own structure (chapter / section / point), so a
   citation always points to a real numbered clause.
2. The question is checked for language and follow-up context, rewritten, and matched with
   keyword retrieval in Postgres; the hits are widened with neighbouring points, section ranges
   and summary tables from the same code.
3. A second model re-ranks the candidate sections; the answer model writes only from those
   excerpts and must return the ids of the excerpts it used.
4. Citations shown to the user come from those ids, not from the answer text, and the ids are
   checked against the retrieved excerpts, so a citation can't be invented.
5. An evaluation harness (80 questions with expected answers, judged by a separate model)
   compares pipeline variants, so changes are measured instead of guessed.

## Stack
Next.js (App Router) + React + TypeScript; OpenRouter models (DeepSeek for rewriting and answering).
KodiAI runs this pipeline on Supabase Postgres. The demo runs the **same SQL** on **PGlite**
(Postgres compiled to WebAssembly, inside the serverless function), loaded from a read-only export
of the three KTP tables (`data/ktp-export.json`: 24 codes, 658 sections, 2,163 paragraphs), so it
needs no external database. The 5-per-visitor limit uses a signed cookie plus a per-IP counter
(`lib/limit.ts`, self-check in `scripts/limit-check.ts`).

## Run locally
```bash
npm install
OPENROUTER_API_KEY=... npm run dev     # http://localhost:3000
```

## How it was built
Built by a civil engineer with AI coding agents (Claude Code). The agent writes code from
written specs, and every change is reviewed, tested and checked before it is kept.

*Previous content of this repo (an earlier legislation-only RAG chat) remains in the git history.*
