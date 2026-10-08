# Changelog

## 1.0.0 — 2026-10-09

- First release. The rules and calendar move from eq-service `lib/payment-claims/` (rules version `sop-act-nsw-2026.10`), with no behaviour change. Due dates depend on claimant type (s11), the notice-of-intention window is corrected (s17(2)(a)), and business days exclude NSW public holidays and 27–31 December.
- Tests now run on Node's built-in test runner instead of vitest, with the same cases.
