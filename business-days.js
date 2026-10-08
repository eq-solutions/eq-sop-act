// Canonical home: @eq-solutions/sop-act (repo eq-solutions/eq-sop-act). Moved
// from eq-service lib/payment-claims/ on 2026-10-09, unchanged.
/**
 * NSW public holiday calendar + business-day arithmetic — Payment Claim Calendar.
 *
 * This is supporting infrastructure for `sop-act-nsw.ts`'s statutory
 * day-counts. See that file's header for the full legal-review disclaimer;
 * it applies here too, since a wrong holiday list shifts every computed
 * deadline by however many days the calendar is off by.
 *
 * The holiday dates below are ALGORITHMICALLY DERIVED (fixed calendar dates,
 * a standard Easter-Sunday calculation, and the well-known "Nth weekday of
 * month" rules for King's Birthday / Labour Day) — they are NOT copied from
 * a verified NSW Government gazette. In real life the exact NSW public
 * holiday list is gazetted year-by-year and can carry one-off additions
 * (e.g. a locally-declared holiday) this calculator cannot know about.
 * Confirm the relevant year's dates against the NSW Government gazette
 * (https://www.nsw.gov.au/about-nsw/public-holidays) before relying on this
 * for a real claim — same "requires legal review" posture as the rest of
 * this feature.
 *
 * Scope: 2025–2032. Extend `FIXED_HOLIDAYS_BY_NAME` / the year range below
 * well before it runs out — `getNswPublicHolidays()` throws for a year
 * outside range rather than silently returning an empty (wrong) list.
 */
const MIN_YEAR = 2025;
const MAX_YEAR = 2032;
export function parseIsoDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}
export function formatIsoDate(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
function addDays(date, days) {
    const out = new Date(date.getTime());
    out.setUTCDate(out.getUTCDate() + days);
    return out;
}
/**
 * Anonymous Gregorian algorithm (Meeus/Jones/Butcher) for the date of
 * Easter Sunday. Standard, well-verified computer-science algorithm — not
 * the part of this module that needs legal review.
 */
function easterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const monthPlusDay = h + l - 7 * m + 114;
    const month = Math.floor(monthPlusDay / 31); // 3 = March, 4 = April
    const day = (monthPlusDay % 31) + 1;
    return new Date(Date.UTC(year, month - 1, day));
}
/** The Nth occurrence (1-based) of `weekday` (0=Sun..6=Sat) in `month` of `year`. */
function nthWeekdayOfMonth(year, month, weekday, n) {
    const first = new Date(Date.UTC(year, month - 1, 1));
    const firstWeekday = first.getUTCDay();
    const offset = (weekday - firstWeekday + 7) % 7;
    const day = 1 + offset + (n - 1) * 7;
    return new Date(Date.UTC(year, month - 1, day));
}
/**
 * NSW "Mondayisation" — when a fixed-date public holiday falls on a
 * weekend, an additional holiday is observed on the next Monday (and, for
 * consecutive Sat/Sun pairs like Christmas/Boxing Day, the second one
 * pushes to the Tuesday). This is the general pattern NSW has followed;
 * per this file's header, treat as "generally known", not gazette-verified.
 *
 * Anzac Day is deliberately NOT passed through this — NSW does not
 * Mondayise Anzac Day (observed on 25 April regardless of weekday).
 */
function withWeekendSubstitute(dates) {
    const out = [];
    const taken = new Set(dates.map((d) => formatIsoDate(d)));
    for (const date of dates) {
        out.push(date);
        const dow = date.getUTCDay();
        if (dow === 6 || dow === 0) {
            // Saturday -> next Monday; Sunday -> next Monday. If that Monday is
            // already taken (e.g. Boxing Day substitute colliding with New
            // Year's Day substitute in a rare year-boundary case), push to Tuesday.
            let substitute = addDays(date, dow === 6 ? 2 : 1);
            while (taken.has(formatIsoDate(substitute))) {
                substitute = addDays(substitute, 1);
            }
            taken.add(formatIsoDate(substitute));
            out.push(substitute);
        }
    }
    return out;
}
const holidayCache = new Map();
/** All NSW public holidays for `year` as a Set of ISO date strings. */
export function getNswPublicHolidays(year) {
    if (year < MIN_YEAR || year > MAX_YEAR) {
        throw new Error(`getNswPublicHolidays: year ${year} is outside the supported range ` +
            `${MIN_YEAR}-${MAX_YEAR}. Extend lib/payment-claims/business-days.ts.`);
    }
    const cached = holidayCache.get(year);
    if (cached)
        return cached;
    const easter = easterSunday(year);
    const goodFriday = addDays(easter, -2);
    const easterSaturday = addDays(easter, -1);
    const easterMonday = addDays(easter, 1);
    const mondayised = withWeekendSubstitute([
        new Date(Date.UTC(year, 0, 1)), // New Year's Day
        new Date(Date.UTC(year, 0, 26)), // Australia Day
        new Date(Date.UTC(year, 11, 25)), // Christmas Day
        new Date(Date.UTC(year, 11, 26)), // Boxing Day
    ]);
    const fixedNoSubstitute = [
        new Date(Date.UTC(year, 3, 25)), // Anzac Day — not Mondayised in NSW
    ];
    const easterHolidays = [goodFriday, easterSaturday, easter, easterMonday];
    const nthWeekday = [
        nthWeekdayOfMonth(year, 6, 1, 2), // King's Birthday — 2nd Monday of June
        nthWeekdayOfMonth(year, 10, 1, 1), // Labour Day — 1st Monday of October
    ];
    const all = new Set([
        ...mondayised,
        ...fixedNoSubstitute,
        ...easterHolidays,
        ...nthWeekday,
    ].map(formatIsoDate));
    holidayCache.set(year, all);
    return all;
}
export function isNswPublicHoliday(date) {
    return getNswPublicHolidays(date.getUTCFullYear()).has(formatIsoDate(date));
}
export function isWeekend(date) {
    const dow = date.getUTCDay();
    return dow === 0 || dow === 6;
}
/**
 * 27–31 December. Not public holidays, but the SOP Act's own s4 definition
 * of "business day" excludes them alongside weekends and public holidays.
 */
export function isSopActChristmasShutdownDay(date) {
    return date.getUTCMonth() === 11 && date.getUTCDate() >= 27;
}
/**
 * A "business day" as defined in s4 of the Building and Construction
 * Industry Security of Payment Act 1999 (NSW): any day other than a
 * Saturday, Sunday or public holiday, or 27, 28, 29, 30 or 31 December.
 */
export function isBusinessDay(date) {
    return !isWeekend(date) && !isNswPublicHoliday(date) && !isSopActChristmasShutdownDay(date);
}
/**
 * Add `days` NSW business days to `start`. `start` itself is never counted
 * — "10 business days after 3 March" means the 3rd is day zero. Negative
 * `days` walks backwards (used nowhere yet, but keeps the function honest
 * for a future "N business days before" need instead of a second copy).
 */
export function addBusinessDays(start, days) {
    let remaining = Math.abs(days);
    const step = days >= 0 ? 1 : -1;
    let cursor = start;
    while (remaining > 0) {
        cursor = addDays(cursor, step);
        if (isBusinessDay(cursor))
            remaining--;
    }
    return cursor;
}
/** Same as `addBusinessDays`, ISO-date in, ISO-date out — the shape most callers want. */
export function addBusinessDaysIso(startIso, days) {
    return formatIsoDate(addBusinessDays(parseIsoDate(startIso), days));
}
/**
 * Count of NSW business days strictly between `start` (exclusive) and `end`
 * (inclusive). Returns a negative number if `end` is before `start`.
 */
export function businessDaysBetween(start, end) {
    if (end.getTime() === start.getTime())
        return 0;
    const step = end.getTime() > start.getTime() ? 1 : -1;
    let cursor = start;
    let count = 0;
    while (cursor.getTime() !== end.getTime()) {
        cursor = addDays(cursor, step);
        if (isBusinessDay(cursor))
            count += step;
    }
    return count;
}
export function businessDaysBetweenIso(startIso, endIso) {
    return businessDaysBetween(parseIsoDate(startIso), parseIsoDate(endIso));
}
/** Today, as a UTC-midnight Date — the calculator's "as of" reference point. */
export function todayUtc() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
