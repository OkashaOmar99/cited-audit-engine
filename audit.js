/**
 * Cited — shared audit engine.
 *
 * Pure helpers + Gemini REST calls. Imported by Pages Functions and node:test.
 * No framework, no paid services, no fabricated data.
 */

export const DEFAULT_MODEL = "gemini-2.5-flash";
export const MAX_QUESTIONS = 5;
export const KV_TTL = 604800; // 7 days

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const MULTI_TLD = [
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au",
  "co.nz", "co.jp", "co.in", "com.br", "com.mx", "com.sg", "co.za",
];

const DOMAIN_RE = /^(?=[a-z0-9.-]{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export class AuditError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "AuditError";
    this.status = status;
  }
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/* ------------------------------------------------------------------ *
 * String / domain helpers
 * ------------------------------------------------------------------ */

function clean(value, max = 200) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Sanitizer for multi-line artifacts. Keeps line structure, drops control chars. */
function cleanBlock(value, max = 12000) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, max);
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const token = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function normalizeDomain(value) {
  let s = String(value ?? "").trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split(/[/?#:@]/)[0];
  return s.replace(/\.$/, "");
}

export function isValidDomain(value) {
  return DOMAIN_RE.test(String(value ?? ""));
}

export function baseDomain(host) {
  const parts = String(host ?? "").toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const last2 = parts.slice(-2).join(".");
  return MULTI_TLD.includes(last2) ? parts.slice(-3).join(".") : last2;
}

export function brandFromDomain(host) {
  const base = baseDomain(host);
  return base.split(".")[0] || "";
}

/** True when the target business was actually named in a single answer. */
export function isTargetMention(targetDomain, brands = [], domains = []) {
  const targetBrand = token(brandFromDomain(targetDomain));
  const targetBase = token(baseDomain(targetDomain));
  if (!targetBrand) return false;

  for (const d of domains) {
    const b = token(baseDomain(normalizeDomain(d)));
    if (b && (b === targetBase || b === targetBrand)) return true;
  }

  for (const brand of brands) {
    const t = token(brand);
    if (t === targetBrand) return true;
    const word = new RegExp(`(^|[^a-z0-9])${escapeRe(targetBrand)}([^a-z0-9]|$)`);
    if (targetBrand.length >= 4 && word.test(String(brand).toLowerCase())) return true;
  }
  return false;
}

/** Every distinct brand/domain in an answer except the target business. */
export function extractCompetitors(targetDomain, brands = [], domains = []) {
  const out = [];
  const seen = new Set();
  const targetBrand = token(brandFromDomain(targetDomain));
  const targetBase = token(baseDomain(targetDomain));

  const add = (name, key) => {
    if (!name || !key || key === targetBrand || key === targetBase || seen.has(key)) return;
    // "Monday.com" (brand) and "monday.com" (domain) are the same competitor.
    for (const existing of seen) {
      if (existing.length >= 3 && key.length >= 3 &&
          (existing.startsWith(key) || key.startsWith(existing))) return;
    }
    seen.add(key);
    out.push(name);
  };

  for (const b of brands) {
    const name = clean(b, 60);
    if (!name || isTargetMention(targetDomain, [name], [])) continue;
    add(name, token(name));
  }
  for (const d of domains) {
    const host = normalizeDomain(d);
    if (!host || isTargetMention(targetDomain, [], [host])) continue;
    const base = baseDomain(host);
    // Dedupe by brand label so "Notion" and "notion.so" count as one competitor.
    add(base, token(brandFromDomain(host)));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Input validation
 * ------------------------------------------------------------------ */

export function validateInput(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Invalid request body." };
  }
  const domain = normalizeDomain(input.domain);
  if (!isValidDomain(domain)) {
    return { ok: false, error: "Enter a valid domain, e.g. acme.com" };
  }
  const industry = clean(input.industry, 120);
  if (industry.length < 2) {
    return { ok: false, error: "Enter your industry." };
  }
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  if (rawQuestions.length > MAX_QUESTIONS) {
    return { ok: false, error: `Maximum ${MAX_QUESTIONS} questions.` };
  }
  const questions = rawQuestions.map((q) => clean(q, 240)).filter((q) => q.length >= 3);
  if (!questions.length) {
    return { ok: false, error: "Add at least one real customer question." };
  }
  return { ok: true, value: { domain, industry, questions } };
}

/* ------------------------------------------------------------------ *
 * Deterministic scoring (derived only from model-returned mentions)
 * ------------------------------------------------------------------ */

export function scoreAnalysis({ domain, questions, answers }) {
  const total = questions.length;
  let citedCount = 0;
  const tally = new Map();
  const rows = [];

  for (let i = 0; i < total; i++) {
    const a = answers[i] || {};
    const brands = Array.isArray(a.citedBrands)
      ? a.citedBrands.slice(0, 20).map((x) => clean(x, 60)).filter(Boolean)
      : [];
    const domains = Array.isArray(a.citedDomains)
      ? a.citedDomains.slice(0, 20).map((x) => clean(x, 120)).filter(Boolean)
      : [];
    const isCited = isTargetMention(domain, brands, domains);
    // A brand named in the question itself ("how do I check if ChatGPT cites my
    // business") is the subject, not a competitor who beat us. Drop it.
    const questionTokens = token(questions[i]);
    const competitors = extractCompetitors(domain, brands, domains).filter(
      (name) => !questionTokens.includes(token(name))
    );

    if (isCited) citedCount++;
    for (const c of competitors) {
      const k = token(c);
      const previous = tally.get(k) || { name: c, count: 0 };
      previous.count++;
      tally.set(k, previous);
    }

    rows.push({
      question: questions[i],
      answer: clean(a.answer, 4000),
      citedBrands: brands,
      citedDomains: domains,
      isCited,
      competitors,
    });
  }

  const competitors = [...tally.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name)
  );
  const visibilityScore = total ? Math.round((citedCount / total) * 100) : 0;
  const gaps = competitors
    .filter((c) => c.count >= 2)
    .map((c) => `${c.name} was cited in ${c.count} of ${total} answers where you were not.`);

  return {
    visibilityScore,
    totalQuestions: total,
    citedCount,
    missingCount: total - citedCount,
    answers: rows,
    competitors,
    gaps,
  };
}

/* ------------------------------------------------------------------ *
 * Gemini
 * ------------------------------------------------------------------ */

export const AUDIT_SCHEMA = {
  type: "OBJECT",
  properties: {
    answers: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          question: { type: "STRING" },
          answer: { type: "STRING" },
          citedBrands: { type: "ARRAY", items: { type: "STRING" } },
          citedDomains: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["question", "answer", "citedBrands", "citedDomains"],
      },
    },
  },
  required: ["answers"],
};

export const FIX_KIT_SCHEMA = {
  type: "OBJECT",
  properties: {
    llmsTxt: { type: "STRING" },
    jsonLd: { type: "STRING" },
    homepageSentences: { type: "ARRAY", items: { type: "STRING" } },
    directories: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          url: { type: "STRING" },
          note: { type: "STRING" },
        },
        required: ["name", "url", "note"],
      },
    },
  },
  required: ["llmsTxt", "jsonLd", "homepageSentences", "directories"],
};

export function buildAuditPrompt({ domain, industry, questions }) {
  const list = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  return `You are auditing AI search visibility for a real business.
Business domain: ${domain}
Industry: ${industry}
Customer questions (${questions.length}):

${list}

TASK
Answer each question as a helpful, neutral AI assistant would — as if you knew nothing about ${domain} unless it genuinely deserves mention. Then report exactly which brands and websites your answer named.

RULES
- Return one item per question, in the SAME ORDER as above.
- "answer": your full answer text (60-140 words). Be concrete and useful.
- "citedBrands": brand or product names you actually named in that answer. Use [] if none.
- "citedDomains": website hosts you actually referenced, lowercase, e.g. "notion.so". Use [] if none.
- Do NOT invent statistics, rankings, market share, funding or review counts. Use no numbers unless they are in the question itself.
- Every entry in citedBrands / citedDomains MUST appear in the answer text. Never list a brand you did not name.
- Only include ${domain} if you truly named it in the answer.
Return strict JSON matching the schema.`;
}

export function buildFixKitPrompt({ domain, industry, competitors, gaps }) {
  const comp = competitors.slice(0, 8).map((c) => c.name).join(", ") || "unnamed competitors";
  const gapText = gaps.slice(0, 5).join("\n- ") || "You were absent from several answers.";
  return `You are writing a precise, implementable AI-visibility fix kit for a real business.
Domain: ${domain}
Industry: ${industry}
Competitors currently cited in AI answers: ${comp}
Observed gaps:
- ${gapText}

Produce FOUR artifacts. Be specific to this business and industry. No fluff, no hype, no invented statistics or awards.

1. "llmsTxt" — a complete llms.txt file as plain text. Include a "# " title, a "> " summary, and short sections for company, product, key facts and preferred citation. Use only facts implied by the domain/industry; mark anything unverified as "TODO:" instead of inventing it.

2. "jsonLd" — a valid JSON-LD object serialized as a STRING (no HTML wrapper). Use @context "https://schema.org", @type "Organization", name, url (https://${domain}), description, sameAs as an empty array, knowsAbout as a short array. Do not invent founding dates, employee counts, addresses or ratings.

3. "homepageSentences" — 4 to 6 short, factual sentences the owner can add above the fold so AI systems can identify the company. Plain, specific, verifiable in principle. No superlatives.

4. "directories" — 5 to 8 REAL, widely known business directories or data sources relevant to this industry where the company should have a consistent listing. Each item: "name", "url" (the real directory homepage — use only widely known ones), "note" (one short sentence on why it matters for AI citation). Do not invent URLs.

Return strict JSON matching the schema.`;
}

export async function callGemini({ apiKey, model = DEFAULT_MODEL, prompt, schema }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let res;
  try {
    res = await fetch(`${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: schema,
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new AuditError(
      err?.name === "AbortError"
        ? "The model took too long to respond. Please retry."
        : "Could not reach the model. Please retry.",
      502
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const d = await res.json();
      detail = d?.error?.message || "";
    } catch { /* ignore */ }
    throw new AuditError(`Model request failed (${res.status}). ${detail}`.trim(), 502);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new AuditError("The model returned unreadable data. Please retry.", 502);
  }

  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("")
    : "";
  if (!text.trim()) {
    throw new AuditError("The model returned an empty response. Please retry.", 502);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AuditError("The model returned malformed JSON. Please retry.", 502);
  }
}

/* ------------------------------------------------------------------ *
 * Normalization of untrusted model output
 * ------------------------------------------------------------------ */

export function normalizeAnswers(rawAnswers, questions) {
  if (!Array.isArray(rawAnswers)) {
    throw new AuditError("The model returned an incomplete analysis. Please retry.", 502);
  }
  const byQuestion = new Map();
  for (const a of rawAnswers) {
    const k = token(a?.question);
    if (k) byQuestion.set(k, a);
  }
  return questions.map((question, i) => {
    const match = byQuestion.get(token(question)) || rawAnswers[i];
    if (!match || typeof match !== "object") {
      throw new AuditError("The model returned an incomplete analysis. Please retry.", 502);
    }
    const answer = clean(match.answer, 4000);
    if (!answer) {
      throw new AuditError("The model returned an incomplete answer. Please retry.", 502);
    }
    return {
      question,
      answer,
      citedBrands: Array.isArray(match.citedBrands)
        ? match.citedBrands.slice(0, 20).map((x) => clean(x, 60)).filter(Boolean)
        : [],
      citedDomains: Array.isArray(match.citedDomains)
        ? match.citedDomains.slice(0, 20).map((x) => clean(x, 120)).filter(Boolean)
        : [],
    };
  });
}

function toJsonLdString(value) {
  let s = typeof value === "string"
    ? value
    : (value && typeof value === "object" ? JSON.stringify(value, null, 2) : "");
  s = cleanBlock(s, 12000).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    JSON.parse(s);
    return s;
  } catch {
    return "";
  }
}

export function normalizeFixKit(raw) {
  if (!raw || typeof raw !== "object") {
    throw new AuditError("The model could not produce the fix kit. Please retry.", 502);
  }
  return {
    llmsTxt: cleanBlock(raw.llmsTxt, 12000),
    jsonLd: toJsonLdString(raw.jsonLd),
    homepageSentences: Array.isArray(raw.homepageSentences)
      ? raw.homepageSentences.slice(0, 8).map((x) => clean(x, 300)).filter(Boolean)
      : [],
    directories: Array.isArray(raw.directories)
      ? raw.directories.slice(0, 10)
          .map((d) => ({
            name: clean(d?.name, 80),
            url: clean(d?.url, 200),
            note: clean(d?.note, 300),
          }))
          .filter((d) => d.name && d.url)
      : [],
  };
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

export async function runAudit({ apiKey, model = DEFAULT_MODEL, input }) {
  if (!apiKey) {
    throw new AuditError("Audit service is not configured (missing GEMINI_API_KEY).", 503);
  }
  const validated = validateInput(input);
  if (!validated.ok) throw new AuditError(validated.error, 400);
  const { domain, industry, questions } = validated.value;

  // Call 1 of 2 — all questions in a single batched prompt.
  const rawAnalysis = await callGemini({
    apiKey,
    model,
    prompt: buildAuditPrompt({ domain, industry, questions }),
    schema: AUDIT_SCHEMA,
  });
  const answers = normalizeAnswers(rawAnalysis?.answers, questions);
  const analysis = scoreAnalysis({ domain, questions, answers });

  // Call 2 of 2 — fix kit from the verified competitor set.
  const rawKit = await callGemini({
    apiKey,
    model,
    prompt: buildFixKitPrompt({
      domain,
      industry,
      competitors: analysis.competitors,
      gaps: analysis.gaps,
    }),
    schema: FIX_KIT_SCHEMA,
  });
  const fixKit = normalizeFixKit(rawKit);

  return { domain, industry, questions, analysis, fixKit };
}

/** The free report never includes the paid fix kit. */
export function toPublicReport(report) {
  if (!report || typeof report !== "object") return null;
  const { fixKit, ...rest } = report;
  return rest;
}
