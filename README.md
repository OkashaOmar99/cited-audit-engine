# Cited — audit engine

The deterministic core behind [Cited](https://cited-cx1.pages.dev): it builds a batched prompt, calls the Gemini API, scores which brands were cited in the answers, and produces a fix kit — without inventing data.

> This is the engine, not the hosted product. It contains no API keys and no customer data.

## What it does

- `validateInput` — domain + industry + up to 5 questions
- `buildAuditPrompt` — one prompt covering all questions (one API call)
- `callGemini` — REST call with JSON response schema
- `scoreAnalysis` — visibility score derived **only** from returned mentions
- `extractCompetitors` — deduped competitor set, excluding the target and question subjects
- `normalizeFixKit` — sanitized `llms.txt`, JSON-LD, homepage sentences, directory plan
- `toPublicReport` — strips the paid artifacts from the public report

## Run

```bash
npm test
```

To use it, call `runAudit({ apiKey, input })`. `apiKey` is your own Google AI Studio key.

## Sample

`sample-report.json` is a hand-authored demonstration report. It is not real audit data.

## Why this is public

Cited sells AI-visibility audits. We publish the scoring engine so the methodology is inspectable — a score you cannot verify is not worth paying for.
