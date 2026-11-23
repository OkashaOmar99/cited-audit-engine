import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeDomain,
  isValidDomain,
  baseDomain,
  brandFromDomain,
  isTargetMention,
  extractCompetitors,
  validateInput,
  scoreAnalysis,
  normalizeAnswers,
  normalizeFixKit,
  toPublicReport,
  buildAuditPrompt,
  MAX_QUESTIONS,
} from "./audit.js";

/* ---------- domains ---------- */

test("normalizeDomain strips protocol, www, path, port and trailing dot", () => {
  assert.equal(normalizeDomain("https://www.Acme.com/path?q=1"), "acme.com");
  assert.equal(normalizeDomain("HTTP://ACME.COM:8080/"), "acme.com");
  assert.equal(normalizeDomain("  acme.com.  "), "acme.com");
});

test("isValidDomain accepts real hosts and rejects junk", () => {
  assert.equal(isValidDomain("acme.com"), true);
  assert.equal(isValidDomain("sub.acme.co.uk"), true);
  assert.equal(isValidDomain("not a domain"), false);
  assert.equal(isValidDomain("acme"), false);
  assert.equal(isValidDomain("http://acme.com"), false);
});

test("baseDomain and brandFromDomain handle multi-part TLDs", () => {
  assert.equal(baseDomain("shop.acme.co.uk"), "acme.co.uk");
  assert.equal(baseDomain("www.notion.so"), "notion.so");
  assert.equal(brandFromDomain("shop.acme.co.uk"), "acme");
  assert.equal(brandFromDomain("notion.so"), "notion");
});

/* ---------- mention detection ---------- */

test("isTargetMention matches brand or domain and avoids substring false positives", () => {
  assert.equal(isTargetMention("acme.com", ["Acme"], []), true);
  assert.equal(isTargetMention("acme.com", [], ["www.acme.com"]), true);
  assert.equal(isTargetMention("acme.com", ["Acme Inc"], []), true);
  assert.equal(isTargetMention("acme.com", ["Acme Corporation"], []), true);
  assert.equal(isTargetMention("acme.com", ["Notion"], ["notion.so"]), false);
  assert.equal(isTargetMention("acme.com", ["Superacme"], []), false);
});

test("extractCompetitors drops the target and dedupes brand/domain pairs", () => {
  const result = extractCompetitors(
    "acme.com",
    ["Acme", "Notion", "Asana"],
    ["acme.com", "notion.so", "linear.app"]
  );
  assert.deepEqual(result, ["Notion", "Asana", "linear.app"]);
});

test("extractCompetitors treats a brand and its matching domain as one", () => {
  const result = extractCompetitors(
    "acme.com",
    ["Monday.com", "Notion"],
    ["monday.com", "notion.so"]
  );
  assert.deepEqual(result, ["Monday.com", "Notion"]);
});

/* ---------- scoring ---------- */

test("scoreAnalysis derives the score only from returned mentions", () => {
  const domain = "acme.com";
  const questions = ["Question one", "Question two", "Question three", "Question four"];
  const answers = [
    { question: questions[0], answer: "a", citedBrands: ["Acme", "Notion"], citedDomains: ["acme.com", "notion.so"] },
    { question: questions[1], answer: "b", citedBrands: ["Notion", "Asana"], citedDomains: ["notion.so", "asana.com"] },
    { question: questions[2], answer: "c", citedBrands: ["Acme Inc"], citedDomains: [] },
    { question: questions[3], answer: "d", citedBrands: ["Notion", "Asana"], citedDomains: ["notion.so"] },
  ];

  const result = scoreAnalysis({ domain, questions, answers });
  assert.equal(result.visibilityScore, 50);
  assert.equal(result.totalQuestions, 4);
  assert.equal(result.citedCount, 2);
  assert.equal(result.missingCount, 2);
  assert.equal(result.answers[0].isCited, true);
  assert.equal(result.answers[1].isCited, false);
  assert.deepEqual(result.competitors, [
    { name: "Notion", count: 3 },
    { name: "Asana", count: 2 },
  ]);
  assert.equal(result.gaps.length, 2);
  assert.match(result.gaps[0], /Notion was cited in 3 of 4 answers/);
});

test("scoreAnalysis invents nothing when the model returns no mentions", () => {
  const questions = ["Question one", "Question two"];
  const result = scoreAnalysis({
    domain: "acme.com",
    questions,
    answers: questions.map((question) => ({ question, answer: "answer", citedBrands: [], citedDomains: [] })),
  });
  assert.equal(result.visibilityScore, 0);
  assert.equal(result.citedCount, 0);
  assert.deepEqual(result.competitors, []);
  assert.deepEqual(result.gaps, []);
});

/* ---------- validation ---------- */

test("validateInput caps questions and sanitizes fields", () => {
  const base = { domain: "https://www.Acme.com/x", industry: "  Project software " };
  const questions = Array.from({ length: MAX_QUESTIONS }, (_, i) => `Question ${i}`);
  const ok = validateInput({ ...base, questions });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.domain, "acme.com");
  assert.equal(ok.value.industry, "Project software");
  assert.equal(ok.value.questions.length, MAX_QUESTIONS);

  assert.equal(validateInput({ ...base, questions: [...questions, "Question six"] }).ok, false);
  assert.equal(validateInput({ domain: "bad domain", industry: "x", questions }).ok, false);
  assert.equal(validateInput({ domain: "acme.com", industry: "x", questions: [] }).ok, false);
});

/* ---------- normalization of untrusted output ---------- */

test("normalizeAnswers maps by question text even when out of order", () => {
  const questions = ["Question one", "Question two"];
  const raw = [
    { question: "Question two", answer: "second", citedBrands: [], citedDomains: [] },
    { question: "Question one", answer: "first", citedBrands: ["Notion"], citedDomains: ["notion.so"] },
  ];
  const result = normalizeAnswers(raw, questions);
  assert.equal(result[0].answer, "first");
  assert.equal(result[1].answer, "second");
  assert.equal(result[0].question, "Question one");
});

test("normalizeAnswers refuses to fabricate a missing answer", () => {
  assert.throws(
    () => normalizeAnswers([{ question: "Question one", answer: "only one" }], ["Question one", "Question two"]),
    /incomplete analysis/
  );
});

test("normalizeFixKit preserves newlines in llms.txt and JSON-LD", () => {
  const kit = normalizeFixKit({
    llmsTxt: "# Acme\n\n> A company.\n\n## Product\n- Thing one\n- Thing two",
    jsonLd: '{\n  "@type": "Organization",\n  "name": "Acme"\n}',
    homepageSentences: [],
    directories: [],
  });
  assert.match(kit.llmsTxt, /^# Acme\n\n> A company\./);
  assert.match(kit.jsonLd, /\n  "@type"/);
  assert.equal(JSON.parse(kit.jsonLd).name, "Acme");
});

test("normalizeFixKit validates JSON-LD and drops invalid directory entries", () => {
  const kit = normalizeFixKit({
    llmsTxt: "# Acme\n> A company.",
    jsonLd: '```json\n{"@type":"Organization","name":"Acme"}\n```',
    homepageSentences: ["Acme is a company.", "  "],
    directories: [
      { name: "G2", url: "https://www.g2.com", note: "Reviews." },
      { name: "No URL", url: "", note: "Dropped." },
    ],
  });
  assert.match(kit.llmsTxt, /^# Acme/);
  assert.deepEqual(JSON.parse(kit.jsonLd), { "@type": "Organization", name: "Acme" });
  assert.deepEqual(kit.homepageSentences, ["Acme is a company."]);
  assert.equal(kit.directories.length, 1);
  assert.equal(kit.directories[0].name, "G2");

  const broken = normalizeFixKit({ jsonLd: "not json", llmsTxt: "", homepageSentences: [], directories: [] });
  assert.equal(broken.jsonLd, "");
});

/* ---------- paid/free boundary + prompts ---------- */

test("toPublicReport strips the paid fix kit", () => {
  const report = { id: "abc", domain: "acme.com", analysis: {}, fixKit: { llmsTxt: "SECRET" } };
  const pub = toPublicReport(report);
  assert.equal(pub.domain, "acme.com");
  assert.equal("fixKit" in pub, false);
  assert.equal(report.fixKit.llmsTxt, "SECRET");
});

test("buildAuditPrompt contains every question and the domain", () => {
  const questions = ["Question one", "Question two", "Question three"];
  const prompt = buildAuditPrompt({ domain: "acme.com", industry: "Software", questions });
  questions.forEach((q) => assert.match(prompt, new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))));
  assert.match(prompt, /acme\.com/);
  assert.match(prompt, /citedBrands/);
});

test("scoreAnalysis does not count a brand named in the question as a competitor", () => {
  const result = scoreAnalysis({
    domain: "cited.com",
    questions: ["How do I check if ChatGPT cites my business?"],
    answers: [{
      answer: "You can check manually or use a tool.",
      citedBrands: ["ChatGPT", "Perplexity"],
      citedDomains: [],
    }],
  });
  assert.deepEqual(result.answers[0].competitors, ["Perplexity"]);
});
