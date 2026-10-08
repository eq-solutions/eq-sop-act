# @eq-solutions/sop-act

The NSW *Building and Construction Industry Security of Payment Act 1999* day-count rules, plus the NSW business-day calendar they run on. EQ Service and EQ Ops both import this package, so the same payment claim always gets the same dates in both apps.

**This is not legal advice.** It computes the standard statutory dates. Contract-specific terms and edge cases are the user's call.

## What it computes

| Date | Rule | Section |
|---|---|---|
| Payment schedule due | Earlier of the contract's period and 10 business days after the claim is served | s14(4)(b) |
| Due date for payment | Contract date, capped at 15 business days (head contractor) or 20 (subcontractor); an exempt residential contract's own date applies, default 10 | s11(1A), (1B), (1C), (8) |
| Notice of intention window | 20 business days after the due date, when no schedule was given and the claim wasn't paid | s17(2)(a) |
| Adjudication application | 10 business days after the schedule (short schedule), 20 after the due date (scheduled amount unpaid), or 10 after the 5-day second chance (no schedule) | s17(3)(c)–(e) |

A business day excludes weekends, NSW public holidays and 27–31 December (s4). Public holidays are calculated for 2025–2032 and should be checked against the NSW gazette each year. Outside that range the calendar throws rather than guessing.

Every result carries `SOP_ACT_NSW_RULES.RULES_VERSION`. Store it with the dates so it's always clear which rules produced them.

## Use

Pin a release tag. Never pin `main`:

```json
"@eq-solutions/sop-act": "github:eq-solutions/eq-sop-act#v1.0.0"
```

```ts
import { computeResponseStageDeadlines, SOP_ACT_NSW_RULES } from '@eq-solutions/sop-act'
```

The repo ships both the `.ts` source (types) and the built `.js` (runtime), so consumers need no build step.

## Changing a rule

1. Edit `sop-act-nsw.ts` or `business-days.ts`, citing the section.
2. Bump `RULES_VERSION`.
3. Run `npm run build`, `npm run typecheck` and `npm test`. Commit the `.ts` and `.js` files together; CI fails if they differ.
4. Tag a release (`vX.Y.Z`), then bump the pin in each app deliberately.
