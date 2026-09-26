# KTP Search — KodiAI demo

AI search over Albania's technical design codes (*Kushtet Teknike të Projektimit*, KTP): ask a
question in Albanian, get an answer grounded in the code text, with a citation chip for every
section used. Click a chip to read the cited section itself.

> **Demo of ongoing work.** This is the KTP chat of KodiAI (a construction-engineering assistant
> for Albania, in development), packaged as a standalone app. The answers for the 8 example
> questions were **recorded from the real pipeline** (2026-09-26) and are replayed here, so the
> demo needs no database, vector index or LLM key. Other questions get a short "demo" note.

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
Next.js (App Router) + React + TypeScript. The full version adds Supabase Postgres and
OpenRouter models (DeepSeek for rewriting and answering). This demo is a static page plus one JSON file (`public/ktp-demo.json`).

## Run locally
```bash
npm install
npm run dev     # http://localhost:3000
```

## How it was built
Built by a civil engineer with AI coding agents (Claude Code). The agent writes code from
written specs, and every change is reviewed, tested and checked before it is kept.

*Previous content of this repo (an earlier legislation-only RAG chat) remains in the git history.*
