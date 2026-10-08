import { describe, it } from 'node:test'
import { expect } from './expect.js'
import {
  getNswPublicHolidays,
  isNswPublicHoliday,
  isWeekend,
  isBusinessDay,
  addBusinessDays,
  addBusinessDaysIso,
  businessDaysBetween,
  businessDaysBetweenIso,
  parseIsoDate,
  formatIsoDate,
} from '../business-days.js'

describe('parseIsoDate / formatIsoDate', () => {
  it('round-trips an ISO date', () => {
    expect(formatIsoDate(parseIsoDate('2026-09-20'))).toBe('2026-09-20')
  })

  it('parses in UTC regardless of host timezone', () => {
    const d = parseIsoDate('2026-01-01')
    expect(d.getUTCFullYear()).toBe(2026)
    expect(d.getUTCMonth()).toBe(0)
    expect(d.getUTCDate()).toBe(1)
  })
})

describe('getNswPublicHolidays', () => {
  it('includes the fixed-date holidays for 2026', () => {
    const holidays = getNswPublicHolidays(2026)
    expect(holidays.has('2026-01-01')).toBe(true) // New Year's Day
    expect(holidays.has('2026-01-26')).toBe(true) // Australia Day (Monday in 2026)
    expect(holidays.has('2026-04-25')).toBe(true) // Anzac Day
    expect(holidays.has('2026-12-25')).toBe(true) // Christmas Day
    expect(holidays.has('2026-12-26')).toBe(true) // Boxing Day
  })

  it('includes Easter-derived holidays consistent with Easter Sunday 2026 (5 April)', () => {
    const holidays = getNswPublicHolidays(2026)
    expect(holidays.has('2026-04-03')).toBe(true) // Good Friday
    expect(holidays.has('2026-04-04')).toBe(true) // Easter Saturday
    expect(holidays.has('2026-04-05')).toBe(true) // Easter Sunday
    expect(holidays.has('2026-04-06')).toBe(true) // Easter Monday
  })

  it('includes King\'s Birthday (2nd Monday of June) and Labour Day (1st Monday of October)', () => {
    const holidays = getNswPublicHolidays(2026)
    // 2026: June 1 is a Monday, so 2nd Monday is June 8.
    expect(holidays.has('2026-06-08')).toBe(true)
    // 2026: October 1 is a Thursday, so 1st Monday is October 5.
    expect(holidays.has('2026-10-05')).toBe(true)
  })

  it('Mondayises a fixed-date holiday that falls on a weekend', () => {
    // 25 Dec 2027 is a Saturday, 26 Dec 2027 is a Sunday — both should get
    // weekday substitutes (Mon 27th and Tue 28th) alongside the actual dates.
    const holidays = getNswPublicHolidays(2027)
    expect(holidays.has('2027-12-25')).toBe(true)
    expect(holidays.has('2027-12-26')).toBe(true)
    expect(holidays.has('2027-12-27')).toBe(true)
    expect(holidays.has('2027-12-28')).toBe(true)
  })

  it('throws outside the supported year range', () => {
    expect(() => getNswPublicHolidays(2020)).toThrow()
    expect(() => getNswPublicHolidays(2099)).toThrow()
  })
})

describe('isWeekend / isNswPublicHoliday / isBusinessDay', () => {
  it('flags Saturday and Sunday as weekend', () => {
    expect(isWeekend(parseIsoDate('2026-09-19'))).toBe(true) // Saturday
    expect(isWeekend(parseIsoDate('2026-09-20'))).toBe(true) // Sunday
    expect(isWeekend(parseIsoDate('2026-09-21'))).toBe(false) // Monday
  })

  it('flags a known public holiday', () => {
    expect(isNswPublicHoliday(parseIsoDate('2026-12-25'))).toBe(true)
    expect(isNswPublicHoliday(parseIsoDate('2026-12-24'))).toBe(false)
  })

  it('a business day is neither a weekend nor a public holiday', () => {
    expect(isBusinessDay(parseIsoDate('2026-09-21'))).toBe(true) // Monday, not a holiday
    expect(isBusinessDay(parseIsoDate('2026-01-01'))).toBe(false) // New Year's Day
    expect(isBusinessDay(parseIsoDate('2026-09-19'))).toBe(false) // Saturday
  })

  it('excludes 27–31 December, per the SOP Act s4 definition of business day', () => {
    // 2026-12-29/30/31 are Tue–Thu and not public holidays — still not business days.
    expect(isBusinessDay(parseIsoDate('2026-12-29'))).toBe(false)
    expect(isBusinessDay(parseIsoDate('2026-12-30'))).toBe(false)
    expect(isBusinessDay(parseIsoDate('2026-12-31'))).toBe(false)
    // 2026-12-24 (Thursday) is an ordinary business day.
    expect(isBusinessDay(parseIsoDate('2026-12-24'))).toBe(true)
  })
})

describe('addBusinessDays / addBusinessDaysIso', () => {
  it('skips a weekend entirely', () => {
    // Friday 2026-09-18 + 1 business day = Monday 2026-09-21.
    expect(addBusinessDaysIso('2026-09-18', 1)).toBe('2026-09-21')
  })

  it('skips a public holiday that falls on a business day', () => {
    // Thursday 2026-12-24 + 1 business day skips Christmas Day (Fri) and
    // the weekend, landing on Monday 2026-12-28 (Boxing Day observed
    // Sat->Mon substitute check aside, 26th is a Saturday in 2026 so no
    // substitute is created that year; confirm the walk still skips it).
    const result = addBusinessDaysIso('2026-12-24', 1)
    expect(result).not.toBe('2026-12-25')
  })

  it('skips the whole Christmas shutdown into the new year', () => {
    // Thu 2026-12-24 + 1: Fri 25th holiday, weekend, 28–31 Dec excluded by
    // SOP Act s4, Fri 2027-01-01 holiday, weekend → Mon 2027-01-04.
    expect(addBusinessDaysIso('2026-12-24', 1)).toBe('2027-01-04')
  })

  it('never counts the start date itself', () => {
    // Adding 0 business days is a no-op.
    expect(addBusinessDaysIso('2026-09-21', 0)).toBe('2026-09-21')
  })

  it('matches addBusinessDays (Date overload) for the same inputs', () => {
    const dateResult = addBusinessDays(parseIsoDate('2026-09-18'), 5)
    const isoResult = addBusinessDaysIso('2026-09-18', 5)
    expect(formatIsoDate(dateResult)).toBe(isoResult)
  })
})

describe('businessDaysBetween / businessDaysBetweenIso', () => {
  it('returns 0 for the same date', () => {
    expect(businessDaysBetweenIso('2026-09-21', '2026-09-21')).toBe(0)
  })

  it('counts business days forward, excluding the start', () => {
    // Monday 2026-09-21 -> Friday 2026-09-25 is 4 business days.
    expect(businessDaysBetweenIso('2026-09-21', '2026-09-25')).toBe(4)
  })

  it('is symmetric (negated) when reversed', () => {
    const forward = businessDaysBetweenIso('2026-09-21', '2026-09-25')
    const backward = businessDaysBetweenIso('2026-09-25', '2026-09-21')
    expect(backward).toBe(-forward)
  })

  it('round-trips with addBusinessDaysIso', () => {
    const start = '2026-09-21'
    const end = addBusinessDaysIso(start, 10)
    expect(businessDaysBetween(parseIsoDate(start), parseIsoDate(end))).toBe(10)
  })
})
