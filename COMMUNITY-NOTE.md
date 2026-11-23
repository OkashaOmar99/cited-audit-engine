# Community note

This repository contains the deterministic scoring engine behind
[Cited](https://cited-cx1.pages.dev). It is published so the methodology is
inspectable: the score is derived only from the brand and domain mentions a
model actually returns, and the sample report is a hand-authored demo, not
real customer data.

## Contributing

Bug reports and focused pull requests are welcome — especially around domain
normalization, mention detection, and keeping untrusted model output from
leaking into a report. Run `npm test` before opening a PR.

## Honesty notes

- No API keys or credentials belong in this repository. `runAudit` takes your
  own key as an argument.
- AI output varies between runs. This engine measures a point-in-time snapshot
  and cannot guarantee that any assistant will cite a business.
- There are no contributors, adopters, press mentions, or star counts to claim
  here yet. Contributions are tracked by the repository's own history.
