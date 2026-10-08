// Canonical home: @eq-solutions/sop-act (repo eq-solutions/eq-sop-act). Moved
// from eq-service lib/payment-claims/ on 2026-10-09, unchanged apart from the
// '.js' import extension. Change rules here, bump RULES_VERSION, tag a release.
/**
 * SOP Act NSW calculation engine — Payment Claim Calendar.
 *
 * Computes the two deadlines and the adjudication window a payment claim
 * carries under the NSW Building and Construction Industry Security of
 * Payment Act 1999 ("the Act"), for BOTH directions this table tracks:
 *   - 'issued'   — a claim this business serves on a customer.
 *   - 'received' — a claim a subcontractor serves on this business.
 * The Act's mechanics are symmetric between claimant and respondent, so the
 * same two functions cover both; `PaymentClaimForCalc.direction` only
 * affects display/labelling upstream, never the day-count arithmetic here.
 * What DOES change the arithmetic is the claimant's position in the
 * contracting chain (`claimantType`) — s11 sets a different maximum due
 * date for each.
 *
 * Deliberately isolated in one file, in plain TypeScript (not PL/pgSQL),
 * so the day-counts are easy to unit-test and easy to check in one place.
 *
 * Every figure below is taken from the in-force text on
 * legislation.nsw.gov.au ("Current version for 20 August 2024 to date",
 * read 2026-10-08) and cites its subsection. The aim is the standard
 * statutory dates, not legal advice: contract-specific terms and edge
 * cases are the user's call, and the UI says so (LegalReviewBanner).
 *
 * Pending amendment: the Fair Trading and Building Legislation Amendment
 * Act 2026 No 28 (not commenced at 2026-10-08) reportedly replaces
 * "business day" with "working day" in this Act. Re-check s4's definition
 * (and business-days.ts) when it commences.
 */
import { parseIsoDate, formatIsoDate, addBusinessDaysIso, todayUtc, } from './business-days.js';
// ─────────── Named constants — the one block a lawyer needs to check ───────────
export const SOP_ACT_NSW_RULES = {
    /**
     * s14(4)(b): a respondent who doesn't provide a payment schedule within
     * the EARLIER of (i) the time required by the contract or (ii) 10
     * business days after the payment claim is served becomes liable to pay
     * the claimed amount. We take the lesser of the contract's own figure (if
     * the claim carries one) and this ceiling.
     */
    PAYMENT_SCHEDULE_MAX_BUSINESS_DAYS: 10,
    /**
     * Maximum "due date for payment", business days after the payment claim
     * is made, by claimant type:
     *   - head_contractor (principal → head contractor): 15 — s11(1A)(a)
     *   - subcontractor   (anyone else, incl. a contractor dealing directly
     *     with a principal and engaging no subcontractors — see the Act's
     *     s4 definitions of "head contractor" and "subcontractor"): 20 — s11(1B)(a)
     * The contract may set an EARLIER date (s11(1A)(b), s11(1B)(b)); a term
     * allowing payment LATER than this has no effect (s11(8)). So a
     * contract-specified figure is capped at these values, never extends them.
     */
    DUE_DATE_MAX_BUSINESS_DAYS: {
        head_contractor: 15,
        subcontractor: 20,
    },
    /**
     * s11(1C): under an exempt residential construction contract the
     * contract's own due date applies (s11(1C)(a)) — s11(8)'s cap does not
     * reach (1C) — and only if the contract is silent does this default
     * apply (s11(1C)(b)).
     */
    EXEMPT_RESIDENTIAL_DEFAULT_DUE_DATE_BUSINESS_DAYS: 10,
    /**
     * s17(2)(a): where no payment schedule was provided and the claimed
     * amount wasn't paid by the due date, the claimant must serve notice of
     * intention to apply for adjudication "within the period of 20 business
     * days immediately following the due date for payment". This is a
     * DEADLINE window that opens the day after the due date and closes 20
     * business days after it — not a minimum wait (the 2026.09 version of
     * this file had it backwards).
     */
    NOTICE_OF_INTENTION_WINDOW_BUSINESS_DAYS_AFTER_DUE_DATE: 20,
    /**
     * s17(2)(b): the respondent then gets 5 business days "after receiving
     * the claimant's notice" to provide a payment schedule.
     */
    NOTICE_OF_INTENTION_SECOND_CHANCE_BUSINESS_DAYS: 5,
    /**
     * s17(3)(c): where the scheduled amount is less than the claimed amount
     * (s17(1)(a)(i)), the adjudication application must be made within 10
     * business days after the claimant receives the payment schedule.
     */
    ADJUDICATION_DISPUTED_AMOUNT_BUSINESS_DAYS: 10,
    /**
     * s17(3)(d): where a payment schedule was provided but the respondent
     * fails to pay the scheduled amount by the due date (s17(1)(a)(ii)), the
     * application must be made within 20 business days after the due date.
     */
    ADJUDICATION_UNPAID_SCHEDULED_AMOUNT_BUSINESS_DAYS: 20,
    /**
     * s17(3)(e): where no payment schedule was provided (s17(1)(b)), the
     * application must be made within 10 business days after the end of the
     * s17(2)(b) 5-day period.
     */
    ADJUDICATION_NO_SCHEDULE_WINDOW_BUSINESS_DAYS: 10,
    /**
     * Freeform version tag stamped onto every row this calculator writes
     * (`payment_claims.sop_act_rules_version`) — bump it whenever this rules
     * block changes, so it's clear which rules each claim was computed under.
     */
    RULES_VERSION: 'sop-act-nsw-2026.10',
};
// ─────────── computeResponseStageDeadlines — always computable from the claim date ───────────
/**
 * Business days after the claim date that the due date for payment falls,
 * per s11 — or null when the claimant type isn't set (s11 has no
 * type-agnostic default, so guessing one would put a wrong legal date on
 * screen).
 */
function resolveDueDateBusinessDays(claim, assumptionsUsed) {
    const contractDays = claim.contractDueDateBusinessDays;
    if (claim.claimantType == null) {
        assumptionsUsed.push('Due date for payment: not computed — claimant type is not set. s11 gives a head contractor claiming from the principal a 15-business-day maximum, any other subcontractor 20, and exempt residential work its own rule, so there is no safe default.');
        return null;
    }
    if (claim.claimantType === 'exempt_residential') {
        if (contractDays != null) {
            assumptionsUsed.push(`Due date for payment: exempt residential contract — the contract's ${contractDays} business days applies (s11(1C)(a); s11(8)'s cap does not apply to s11(1C)).`);
            return contractDays;
        }
        const fallback = SOP_ACT_NSW_RULES.EXEMPT_RESIDENTIAL_DEFAULT_DUE_DATE_BUSINESS_DAYS;
        assumptionsUsed.push(`Due date for payment: exempt residential contract with no contract figure set — used the ${fallback}-business-day default (s11(1C)(b)).`);
        return fallback;
    }
    const max = SOP_ACT_NSW_RULES.DUE_DATE_MAX_BUSINESS_DAYS[claim.claimantType];
    const subsection = claim.claimantType === 'head_contractor' ? 's11(1A)' : 's11(1B)';
    const who = claim.claimantType === 'head_contractor' ? 'head contractor claiming from the principal' : 'subcontractor';
    if (contractDays == null) {
        assumptionsUsed.push(`Due date for payment: ${who}, no contract figure set — used the ${max}-business-day statutory maximum (${subsection}(a)). If the contract sets an earlier date, enter it as the contract due-date override.`);
        return max;
    }
    if (contractDays > max) {
        assumptionsUsed.push(`Due date for payment: the contract's ${contractDays} business days is later than the ${max}-business-day maximum for a ${who} (${subsection}(a)) and has no effect to that extent (s11(8)) — used ${max}.`);
        return max;
    }
    assumptionsUsed.push(`Due date for payment: contract-specified ${contractDays} business days, within the ${max}-business-day maximum for a ${who} (${subsection}(b)).`);
    return contractDays;
}
/**
 * Computes the payment-schedule due date and the due date for payment.
 * Both follow purely from the claim date + claimant type + any contract
 * overrides — never from what actually happened afterwards, so this is
 * always computable (returns nulls only when an input it needs is missing).
 */
export function computeResponseStageDeadlines(claim) {
    const assumptionsUsed = [];
    if (claim.claimDateCertainty !== 'hard' || !claim.hardClaimDate) {
        assumptionsUsed.push('No confirmed claim date yet (claim_date_certainty is not "hard") — deadlines cannot be computed until one is set.');
        return { paymentScheduleDueDate: null, dueDateForPayment: null, assumptionsUsed };
    }
    const claimDate = claim.hardClaimDate;
    // Payment schedule due date — earlier of the contract's own figure and
    // the statutory ceiling (s14(4)(b)).
    let scheduleDays = SOP_ACT_NSW_RULES.PAYMENT_SCHEDULE_MAX_BUSINESS_DAYS;
    if (claim.contractResponseBusinessDays != null) {
        scheduleDays = Math.min(claim.contractResponseBusinessDays, SOP_ACT_NSW_RULES.PAYMENT_SCHEDULE_MAX_BUSINESS_DAYS);
        assumptionsUsed.push(`Payment-schedule window: earlier of the contract's ${claim.contractResponseBusinessDays} business days and the ${SOP_ACT_NSW_RULES.PAYMENT_SCHEDULE_MAX_BUSINESS_DAYS}-business-day statutory ceiling (s14(4)(b)) → used ${scheduleDays}.`);
    }
    else {
        assumptionsUsed.push(`Payment-schedule window: no contract-specified figure on this claim — used the ${scheduleDays}-business-day statutory ceiling (s14(4)(b)(ii)).`);
    }
    const paymentScheduleDueDate = addBusinessDaysIso(claimDate, scheduleDays);
    const dueDateDays = resolveDueDateBusinessDays(claim, assumptionsUsed);
    const dueDateForPayment = dueDateDays == null ? null : addBusinessDaysIso(claimDate, dueDateDays);
    return { paymentScheduleDueDate, dueDateForPayment, assumptionsUsed };
}
// ─────────── computeAdjudicationWindow — branches on outcome fields ───────────
/**
 * Computes the adjudication-application window, if one is currently open or
 * determinable. Branches entirely on what has actually happened so far
 * (whether/when a payment schedule was received, the scheduled vs claimed
 * amount, whether payment has been made) — it does not guess ahead of the
 * facts. Returns `{ status: 'awaiting_outcome' }` whenever the next fact
 * needed to know which branch applies hasn't happened yet.
 */
export function computeAdjudicationWindow(claim, deadlines) {
    const assumptionsUsed = [];
    // Already paid in full — nothing to adjudicate.
    if (claim.amountPaid != null && claim.claimedAmount != null && claim.amountPaid >= claim.claimedAmount) {
        assumptionsUsed.push('Amount paid meets or exceeds the claimed amount — adjudication is not applicable.');
        return { status: 'not_applicable', assumptionsUsed };
    }
    if (!deadlines.paymentScheduleDueDate) {
        assumptionsUsed.push('Response-stage deadlines are not computable yet (no confirmed claim date) — outcome unknown.');
        return { status: 'awaiting_outcome', assumptionsUsed };
    }
    const today = formatIsoDate(todayUtc());
    // Branch 1: a payment schedule was received (s17(1)(a)).
    if (claim.paymentScheduleReceived) {
        if (claim.scheduledAmount == null || claim.claimedAmount == null) {
            assumptionsUsed.push('Payment schedule received, but the scheduled or claimed amount is not recorded yet — cannot tell if it is disputed.');
            return { status: 'awaiting_outcome', assumptionsUsed };
        }
        // s17(1)(a)(i): scheduled amount short of the claimed amount — the
        // window runs from the date the schedule was received (s17(3)(c)).
        if (claim.scheduledAmount < claim.claimedAmount) {
            if (!claim.paymentScheduleReceivedDate) {
                assumptionsUsed.push('Scheduled amount is short, but the date the payment schedule was received is not recorded — cannot start the window.');
                return { status: 'awaiting_outcome', assumptionsUsed };
            }
            const start = claim.paymentScheduleReceivedDate;
            const end = addBusinessDaysIso(start, SOP_ACT_NSW_RULES.ADJUDICATION_DISPUTED_AMOUNT_BUSINESS_DAYS);
            assumptionsUsed.push(`Scheduled amount ($${claim.scheduledAmount}) is less than claimed ($${claim.claimedAmount}) — adjudication application must be made within ${SOP_ACT_NSW_RULES.ADJUDICATION_DISPUTED_AMOUNT_BUSINESS_DAYS} business days after the payment schedule was received (s17(1)(a)(i), s17(3)(c)), i.e. by ${end}. If the scheduled amount itself also goes unpaid past the due date, a separate s17(1)(a)(ii) window may arise — not computed here.`);
            return { status: 'window', start, end, assumptionsUsed };
        }
        // s17(1)(a)(ii): scheduled amount covers the claim, but was it paid by
        // the due date? If not, the window runs 20 business days after the due
        // date (s17(3)(d)).
        if (claim.amountPaid != null && claim.amountPaid >= claim.scheduledAmount) {
            assumptionsUsed.push('Scheduled amount meets or exceeds the claimed amount and has been paid — no shortfall to adjudicate.');
            return { status: 'not_applicable', assumptionsUsed };
        }
        if (!deadlines.dueDateForPayment) {
            assumptionsUsed.push('Scheduled amount covers the claim, but no due date for payment is computed yet — cannot tell whether it has been paid late.');
            return { status: 'awaiting_outcome', assumptionsUsed };
        }
        if (today <= deadlines.dueDateForPayment) {
            assumptionsUsed.push(`Scheduled amount meets or exceeds the claimed amount — payment is not due until ${deadlines.dueDateForPayment}.`);
            return { status: 'awaiting_outcome', assumptionsUsed };
        }
        const start = deadlines.dueDateForPayment;
        const end = addBusinessDaysIso(start, SOP_ACT_NSW_RULES.ADJUDICATION_UNPAID_SCHEDULED_AMOUNT_BUSINESS_DAYS);
        assumptionsUsed.push(`Scheduled amount was not recorded as paid by the due date (${start}) — adjudication application must be made within ${SOP_ACT_NSW_RULES.ADJUDICATION_UNPAID_SCHEDULED_AMOUNT_BUSINESS_DAYS} business days after the due date (s17(1)(a)(ii), s17(3)(d)), i.e. by ${end}.`);
        return { status: 'window', start, end, assumptionsUsed };
    }
    // Branch 2: no payment schedule (s17(1)(b)) — has the payment-schedule
    // due date passed yet? The respondent can still provide one on that day.
    if (today <= deadlines.paymentScheduleDueDate) {
        assumptionsUsed.push('No payment schedule received yet, and the payment-schedule due date has not passed — still awaiting the respondent.');
        return { status: 'awaiting_outcome', assumptionsUsed };
    }
    // No schedule in time: the respondent is liable for the claimed amount on
    // the due date (s14(4)). Adjudication then needs non-payment by the due
    // date (s17(1)(b)) and a notice of intention served within the 20 business
    // days immediately following it (s17(2)(a)).
    if (!deadlines.dueDateForPayment) {
        assumptionsUsed.push('No due date for payment computed yet — cannot progress the statutory-debt branch.');
        return { status: 'awaiting_outcome', assumptionsUsed };
    }
    const dueDate = deadlines.dueDateForPayment;
    if (today <= dueDate) {
        assumptionsUsed.push(`No payment schedule was provided in time, so the respondent is liable for the claimed amount on the due date for payment, ${dueDate} (s14(4)). A notice of intention to apply for adjudication can only be served after that date passes unpaid (s17(1)(b), s17(2)(a)).`);
        return { status: 'awaiting_outcome', assumptionsUsed };
    }
    const noticeDeadline = addBusinessDaysIso(dueDate, SOP_ACT_NSW_RULES.NOTICE_OF_INTENTION_WINDOW_BUSINESS_DAYS_AFTER_DUE_DATE);
    const served = claim.noticeOfIntentionServedDate;
    if (served && served > noticeDeadline) {
        assumptionsUsed.push(`Notice of intention recorded as served ${served}, after the s17(2)(a) window closed on ${noticeDeadline} — adjudication under s17(1)(b) is not available on that notice. Recovery of the debt in court (s15(2)(a)(i)) is unaffected.`);
        return { status: 'not_applicable', assumptionsUsed };
    }
    if (!served || served <= dueDate) {
        if (served) {
            assumptionsUsed.push(`Notice of intention recorded as served ${served}, on or before the due date for payment (${dueDate}) — outside the s17(2)(a) window, so it is treated as not yet served.`);
        }
        if (today > noticeDeadline) {
            assumptionsUsed.push(`No valid notice of intention recorded and the s17(2)(a) window (the 20 business days after the due date ${dueDate}) closed on ${noticeDeadline} — adjudication under s17(1)(b) is no longer available. Recovery of the debt in court (s15(2)(a)(i)) is unaffected.`);
            return { status: 'not_applicable', assumptionsUsed };
        }
        assumptionsUsed.push(`No payment schedule was provided and the due date for payment (${dueDate}) has passed — a notice of intention to apply for adjudication must be served no later than ${noticeDeadline} (s17(2)(a)), and hasn't been recorded as served yet.`);
        return { status: 'awaiting_outcome', assumptionsUsed };
    }
    const secondChanceEnd = addBusinessDaysIso(served, SOP_ACT_NSW_RULES.NOTICE_OF_INTENTION_SECOND_CHANCE_BUSINESS_DAYS);
    const adjudicationEnd = addBusinessDaysIso(secondChanceEnd, SOP_ACT_NSW_RULES.ADJUDICATION_NO_SCHEDULE_WINDOW_BUSINESS_DAYS);
    assumptionsUsed.push(`Notice of intention served ${served}, within the s17(2)(a) window — respondent's 5-business-day chance to provide a payment schedule ends ${secondChanceEnd} (s17(2)(b); counted from the service date, assuming the respondent received the notice that day); if still unanswered, the adjudication application must be made by ${adjudicationEnd} (s17(3)(e)).`);
    return { status: 'window', start: secondChanceEnd, end: adjudicationEnd, assumptionsUsed };
}
// ─────────── classifySopActBranch — combines both into the DB's single-column state ───────────
/**
 * Reduces the two functions above into the single `sop_act_branch`
 * classification `payment_claims` stores. Not one of the two named
 * functions the plan called for (those are the two above, kept
 * independently testable) — this is the thin combination layer the write
 * path uses to populate the DB column.
 */
export function classifySopActBranch(claim, deadlines, adjudication) {
    if (claim.amountPaid != null && claim.claimedAmount != null) {
        if (claim.amountPaid >= claim.claimedAmount)
            return 'paid_in_full';
        if (claim.amountPaid > 0)
            return 'paid_short';
    }
    if (!deadlines.paymentScheduleDueDate)
        return 'awaiting_claim_date';
    if (claim.paymentScheduleReceived) {
        if (adjudication.status !== 'window')
            return 'scheduled_response_on_time';
        const short = claim.scheduledAmount != null && claim.claimedAmount != null && claim.scheduledAmount < claim.claimedAmount;
        // s17(1)(a)(i) shortfall vs s17(1)(a)(ii) scheduled amount left unpaid.
        return short ? 'scheduled_amount_disputed' : 'adjudication_eligible';
    }
    const today = formatIsoDate(todayUtc());
    if (today <= deadlines.paymentScheduleDueDate)
        return 'awaiting_response';
    if (adjudication.status === 'window')
        return 'adjudication_eligible';
    return 'no_response_statutory_debt';
}
/**
 * Runs both calculator functions and folds the result into exactly the
 * shape `payment_claims`'s computed columns need. This is what
 * create/update server actions call — never write `sop_act_branch` or
 * either deadline column by hand.
 */
export function computeAllSopActFields(claim) {
    const deadlines = computeResponseStageDeadlines(claim);
    const adjudication = computeAdjudicationWindow(claim, deadlines);
    const branch = classifySopActBranch(claim, deadlines, adjudication);
    return {
        paymentScheduleDueDate: deadlines.paymentScheduleDueDate,
        dueDateForPayment: deadlines.dueDateForPayment,
        sopActBranch: branch,
        adjudicationWindowStart: adjudication.status === 'window' ? adjudication.start : null,
        adjudicationWindowEnd: adjudication.status === 'window' ? adjudication.end : null,
        assumptionsUsed: [...deadlines.assumptionsUsed, ...adjudication.assumptionsUsed],
        rulesVersion: SOP_ACT_NSW_RULES.RULES_VERSION,
        computedAt: new Date().toISOString(),
    };
}
// Re-export so callers of this module don't also need to import from
// business-days.ts just to parse/format the dates this module returns.
export { parseIsoDate, formatIsoDate };
