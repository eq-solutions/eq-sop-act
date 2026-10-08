import { describe, it, before, after, mock } from 'node:test'
import { expect } from './expect.js'
import {
  SOP_ACT_NSW_RULES,
  computeResponseStageDeadlines,
  computeAdjudicationWindow,
  classifySopActBranch,
  computeAllSopActFields,
  type PaymentClaimForCalc,
} from '../sop-act-nsw.js'
import { addBusinessDaysIso, formatIsoDate, todayUtc } from '../business-days.js'

// The module under test reads the wall clock (todayUtc) to decide whether a
// deadline has passed. Pin it so no assertion depends on the day CI runs.
// 2026-09-25 is a Friday, well after every hard-coded fixture claim date
// below and clear of any NSW public holiday or the 27–31 Dec exclusion.
before(() => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-25T00:00:00Z') })
})
after(() => {
  mock.timers.reset()
})

/** Base fixture — a hard-dated subcontractor claim with no contract
 *  overrides and no outcome recorded yet. Tests override what they need. */
function baseClaim(overrides: Partial<PaymentClaimForCalc> = {}): PaymentClaimForCalc {
  return {
    direction: 'issued',
    claimantType: 'subcontractor',
    claimDateCertainty: 'hard',
    hardClaimDate: '2026-03-02', // a Monday; no NSW holidays in March 2026
    claimedAmount: 100000,
    contractResponseBusinessDays: null,
    contractDueDateBusinessDays: null,
    paymentScheduleReceived: false,
    paymentScheduleReceivedDate: null,
    scheduledAmount: null,
    amountPaid: null,
    amountPaidDate: null,
    noticeOfIntentionServedDate: null,
    ...overrides,
  }
}

/** A claim date `offset` business days from the pinned "today" (negative =
 *  in the past) — for fixtures that need a deadline just ahead or behind. */
function claimDateFromToday(offset: number): string {
  return addBusinessDaysIso(formatIsoDate(todayUtc()), offset)
}

/** Statutory-debt fixture with hard-coded dates, worked by hand:
 *  claim Tue 2026-01-06 → schedule due 2026-01-20 (10 BD) → due date for
 *  payment 2026-02-04 (20 BD, skipping Australia Day Mon 26 Jan) → s17(2)(a)
 *  notice window closes 2026-03-04 (20 BD after the due date). */
const DEBT_CLAIM_DATE = '2026-01-06'
const DEBT_DUE_DATE = '2026-02-04'
const DEBT_NOTICE_DEADLINE = '2026-03-04'

describe('computeResponseStageDeadlines', () => {
  it('returns nulls when the claim date is not yet confirmed hard', () => {
    const result = computeResponseStageDeadlines(baseClaim({ claimDateCertainty: 'placeholder', hardClaimDate: null }))
    expect(result.paymentScheduleDueDate).toBeNull()
    expect(result.dueDateForPayment).toBeNull()
    expect(result.assumptionsUsed.length).toBeGreaterThan(0)
  })

  it('returns nulls when claim_date_certainty is hard but hardClaimDate is somehow missing', () => {
    const result = computeResponseStageDeadlines(baseClaim({ claimDateCertainty: 'hard', hardClaimDate: null }))
    expect(result.paymentScheduleDueDate).toBeNull()
    expect(result.dueDateForPayment).toBeNull()
  })

  describe('payment schedule (s14(4))', () => {
    it('uses the 10-business-day statutory ceiling when no contract override is set', () => {
      expect(computeResponseStageDeadlines(baseClaim()).paymentScheduleDueDate).toBe('2026-03-16')
    })

    it('caps a contract response window at the statutory ceiling, never extends past it', () => {
      const result = computeResponseStageDeadlines(baseClaim({ contractResponseBusinessDays: 20 }))
      expect(result.paymentScheduleDueDate).toBe('2026-03-16')
    })

    it('honours a contract response window shorter than the statutory ceiling', () => {
      const result = computeResponseStageDeadlines(baseClaim({ contractResponseBusinessDays: 5 }))
      expect(result.paymentScheduleDueDate).toBe(addBusinessDaysIso('2026-03-02', 5))
    })
  })

  describe('due date for payment (s11)', () => {
    it('subcontractor: 20 business days when the contract is silent (s11(1B))', () => {
      expect(computeResponseStageDeadlines(baseClaim()).dueDateForPayment).toBe('2026-03-30')
    })

    it('head contractor: 15 business days when the contract is silent (s11(1A))', () => {
      const result = computeResponseStageDeadlines(baseClaim({ claimantType: 'head_contractor' }))
      expect(result.dueDateForPayment).toBe('2026-03-23')
    })

    it('exempt residential: 10 business days only when the contract is silent (s11(1C)(b))', () => {
      const result = computeResponseStageDeadlines(baseClaim({ claimantType: 'exempt_residential' }))
      expect(result.dueDateForPayment).toBe('2026-03-16')
    })

    it('caps a later subcontractor contract term at 20 business days (s11(8))', () => {
      const result = computeResponseStageDeadlines(baseClaim({ contractDueDateBusinessDays: 30 }))
      expect(result.dueDateForPayment).toBe('2026-03-30')
      expect(result.assumptionsUsed.join(' ')).toContain('s11(8)')
    })

    it('caps a later head-contractor contract term at 15 business days (s11(8))', () => {
      const result = computeResponseStageDeadlines(baseClaim({ claimantType: 'head_contractor', contractDueDateBusinessDays: 20 }))
      expect(result.dueDateForPayment).toBe('2026-03-23')
    })

    it('honours an earlier contract due date', () => {
      const result = computeResponseStageDeadlines(baseClaim({ contractDueDateBusinessDays: 7 }))
      expect(result.dueDateForPayment).toBe(addBusinessDaysIso('2026-03-02', 7))
    })

    it('exempt residential: honours the contract figure outright, even past the s11(1A)/(1B) maxima (s11(1C)(a))', () => {
      const result = computeResponseStageDeadlines(baseClaim({ claimantType: 'exempt_residential', contractDueDateBusinessDays: 30 }))
      expect(result.dueDateForPayment).toBe(addBusinessDaysIso('2026-03-02', 30))
    })

    it('leaves the due date uncomputed when the claimant type is not set, but still computes the schedule date', () => {
      const result = computeResponseStageDeadlines(baseClaim({ claimantType: null }))
      expect(result.dueDateForPayment).toBeNull()
      expect(result.paymentScheduleDueDate).toBe('2026-03-16')
      expect(result.assumptionsUsed.join(' ')).toContain('claimant type is not set')
    })
  })

  it('behaves identically regardless of direction (issued vs received)', () => {
    const issued = computeResponseStageDeadlines(baseClaim({ direction: 'issued' }))
    const received = computeResponseStageDeadlines(baseClaim({ direction: 'received' }))
    expect(issued).toEqual(received)
  })
})

describe('computeAdjudicationWindow', () => {
  function adjudicate(overrides: Partial<PaymentClaimForCalc>) {
    const claim = baseClaim(overrides)
    return computeAdjudicationWindow(claim, computeResponseStageDeadlines(claim))
  }

  it('is awaiting_outcome when deadlines are not computable', () => {
    expect(adjudicate({ claimDateCertainty: 'placeholder', hardClaimDate: null }).status).toBe('awaiting_outcome')
  })

  it('is not_applicable once paid in full', () => {
    expect(adjudicate({ amountPaid: 100000 }).status).toBe('not_applicable')
  })

  it('is awaiting_outcome before the payment-schedule due date passes with no schedule yet', () => {
    expect(adjudicate({ hardClaimDate: claimDateFromToday(0) }).status).toBe('awaiting_outcome')
  })

  it('is still awaiting_outcome ON the payment-schedule due date — the respondent has all of that day', () => {
    expect(adjudicate({ hardClaimDate: claimDateFromToday(-10) }).status).toBe('awaiting_outcome')
  })

  describe('payment schedule provided, scheduled amount short (s17(1)(a)(i))', () => {
    it('opens a window of 10 business days from the schedule receipt date (s17(3)(c))', () => {
      const result = adjudicate({
        paymentScheduleReceived: true,
        paymentScheduleReceivedDate: '2026-03-10',
        scheduledAmount: 60000,
      })
      expect(result.status).toBe('window')
      if (result.status === 'window') {
        expect(result.start).toBe('2026-03-10')
        expect(result.end).toBe('2026-03-24')
      }
    })
  })

  describe('payment schedule provided, scheduled amount covers the claim (s17(1)(a)(ii))', () => {
    it('is not_applicable once the scheduled amount is paid', () => {
      const result = adjudicate({
        paymentScheduleReceived: true,
        paymentScheduleReceivedDate: '2026-03-10',
        scheduledAmount: 100000,
        amountPaid: 100000,
      })
      expect(result.status).toBe('not_applicable')
    })

    it('is awaiting_outcome while the due date for payment has not passed', () => {
      const result = adjudicate({
        hardClaimDate: claimDateFromToday(-5),
        paymentScheduleReceived: true,
        paymentScheduleReceivedDate: claimDateFromToday(-2),
        scheduledAmount: 100000,
      })
      expect(result.status).toBe('awaiting_outcome')
    })

    it('opens a window of 20 business days after the due date once it passes unpaid (s17(3)(d))', () => {
      const result = adjudicate({
        paymentScheduleReceived: true,
        paymentScheduleReceivedDate: '2026-03-10',
        scheduledAmount: 100000,
      })
      expect(result.status).toBe('window')
      if (result.status === 'window') {
        expect(result.start).toBe('2026-03-30')
        expect(result.end).toBe(addBusinessDaysIso('2026-03-30', 20))
      }
    })
  })

  describe('no payment schedule (s17(1)(b), s17(2))', () => {
    it('is awaiting_outcome after the schedule date but before the due date for payment', () => {
      const result = adjudicate({ hardClaimDate: claimDateFromToday(-15) })
      expect(result.status).toBe('awaiting_outcome')
      expect(result.assumptionsUsed.join(' ')).toContain('s14(4)')
    })

    it('is awaiting_outcome with the notice deadline stated while the s17(2)(a) window is open', () => {
      const result = adjudicate({ hardClaimDate: claimDateFromToday(-25) })
      expect(result.status).toBe('awaiting_outcome')
      const dueDate = claimDateFromToday(-5)
      expect(result.assumptionsUsed.join(' ')).toContain(`no later than ${addBusinessDaysIso(dueDate, 20)}`)
    })

    it('is not_applicable once the 20-business-day notice window has closed with no notice served', () => {
      const result = adjudicate({ hardClaimDate: DEBT_CLAIM_DATE })
      expect(result.status).toBe('not_applicable')
      expect(result.assumptionsUsed.join(' ')).toContain(`closed on ${DEBT_NOTICE_DEADLINE}`)
    })

    it('opens the adjudication window once a notice is served inside the s17(2)(a) window', () => {
      const result = adjudicate({ hardClaimDate: DEBT_CLAIM_DATE, noticeOfIntentionServedDate: '2026-02-20' })
      expect(result.status).toBe('window')
      if (result.status === 'window') {
        const secondChanceEnd = addBusinessDaysIso('2026-02-20', 5)
        expect(result.start).toBe(secondChanceEnd)
        expect(result.end).toBe(addBusinessDaysIso(secondChanceEnd, 10))
      }
    })

    it('accepts a notice served on the last day of the window', () => {
      const result = adjudicate({ hardClaimDate: DEBT_CLAIM_DATE, noticeOfIntentionServedDate: DEBT_NOTICE_DEADLINE })
      expect(result.status).toBe('window')
    })

    it('rejects a notice served after the window closed', () => {
      const result = adjudicate({ hardClaimDate: DEBT_CLAIM_DATE, noticeOfIntentionServedDate: '2026-03-05' })
      expect(result.status).toBe('not_applicable')
    })

    it('treats a notice served on or before the due date as not served', () => {
      const result = adjudicate({ hardClaimDate: DEBT_CLAIM_DATE, noticeOfIntentionServedDate: DEBT_DUE_DATE })
      expect(result.status).toBe('not_applicable')
      expect(result.assumptionsUsed.join(' ')).toContain('treated as not yet served')
    })

    it('is awaiting_outcome when the claimant type is unset (no due date to count from)', () => {
      expect(adjudicate({ hardClaimDate: DEBT_CLAIM_DATE, claimantType: null }).status).toBe('awaiting_outcome')
    })
  })

  it('behaves identically regardless of direction (issued vs received)', () => {
    const issued = adjudicate({ direction: 'issued', paymentScheduleReceived: true, paymentScheduleReceivedDate: '2026-03-10', scheduledAmount: 60000 })
    const received = adjudicate({ direction: 'received', paymentScheduleReceived: true, paymentScheduleReceivedDate: '2026-03-10', scheduledAmount: 60000 })
    expect(issued).toEqual(received)
  })
})

describe('classifySopActBranch', () => {
  function classify(overrides: Partial<PaymentClaimForCalc>) {
    const claim = baseClaim(overrides)
    const deadlines = computeResponseStageDeadlines(claim)
    const adjudication = computeAdjudicationWindow(claim, deadlines)
    return classifySopActBranch(claim, deadlines, adjudication)
  }

  it('awaiting_claim_date when there is no confirmed claim date', () => {
    expect(classify({ claimDateCertainty: 'placeholder', hardClaimDate: null })).toBe('awaiting_claim_date')
  })

  it('awaiting_response before the payment-schedule due date', () => {
    expect(classify({ hardClaimDate: claimDateFromToday(0) })).toBe('awaiting_response')
  })

  it('awaiting_response on the payment-schedule due date itself', () => {
    expect(classify({ hardClaimDate: claimDateFromToday(-10) })).toBe('awaiting_response')
  })

  it('no_response_statutory_debt once the schedule date has passed with nothing served', () => {
    expect(classify({ hardClaimDate: DEBT_CLAIM_DATE })).toBe('no_response_statutory_debt')
  })

  it('scheduled_response_on_time when a full payment schedule is received and payment is not yet due', () => {
    expect(classify({
      hardClaimDate: claimDateFromToday(-5),
      paymentScheduleReceived: true,
      paymentScheduleReceivedDate: claimDateFromToday(-2),
      scheduledAmount: 100000,
    })).toBe('scheduled_response_on_time')
  })

  it('scheduled_amount_disputed when the scheduled amount is short', () => {
    expect(classify({
      paymentScheduleReceived: true,
      paymentScheduleReceivedDate: '2026-03-10',
      scheduledAmount: 60000,
    })).toBe('scheduled_amount_disputed')
  })

  it('adjudication_eligible when a full scheduled amount goes unpaid past the due date', () => {
    expect(classify({
      paymentScheduleReceived: true,
      paymentScheduleReceivedDate: '2026-03-10',
      scheduledAmount: 100000,
    })).toBe('adjudication_eligible')
  })

  it('adjudication_eligible once the statutory-debt adjudication window is open', () => {
    expect(classify({
      hardClaimDate: DEBT_CLAIM_DATE,
      noticeOfIntentionServedDate: '2026-02-20',
    })).toBe('adjudication_eligible')
  })

  it('paid_in_full once amount paid meets the claimed amount', () => {
    expect(classify({ amountPaid: 100000 })).toBe('paid_in_full')
  })

  it('paid_short when a partial amount has been paid', () => {
    expect(classify({ amountPaid: 40000 })).toBe('paid_short')
  })
})

describe('computeAllSopActFields', () => {
  it('stamps every claim with the current rules version', () => {
    const result = computeAllSopActFields(baseClaim())
    expect(result.rulesVersion).toBe(SOP_ACT_NSW_RULES.RULES_VERSION)
  })

  it('always includes at least one assumption in the trail', () => {
    const result = computeAllSopActFields(baseClaim())
    expect(result.assumptionsUsed.length).toBeGreaterThan(0)
  })

  it('leaves the adjudication window null when not open', () => {
    const result = computeAllSopActFields(baseClaim({ hardClaimDate: claimDateFromToday(0) }))
    expect(result.adjudicationWindowStart).toBeNull()
    expect(result.adjudicationWindowEnd).toBeNull()
  })

  it('populates the adjudication window when the statutory-debt branch is eligible', () => {
    const result = computeAllSopActFields(baseClaim({
      hardClaimDate: DEBT_CLAIM_DATE,
      noticeOfIntentionServedDate: '2026-02-20',
    }))
    expect(result.adjudicationWindowStart).not.toBeNull()
    expect(result.adjudicationWindowEnd).not.toBeNull()
    expect(result.sopActBranch).toBe('adjudication_eligible')
  })
})
