// The handful of vitest-style matchers these tests use, on node:assert, so
// the suite runs on Node's built-in test runner with no test framework
// dependency. The tests themselves are unchanged from eq-service.
import assert from 'node:assert/strict'

export function expect(actual: unknown) {
  return {
    toBe: (expected: unknown) => assert.equal(actual, expected),
    toEqual: (expected: unknown) => assert.deepEqual(actual, expected),
    toBeNull: () => assert.equal(actual, null),
    toContain: (expected: unknown) =>
      assert.ok((actual as { includes(v: unknown): boolean }).includes(expected), `expected ${String(actual)} to contain ${String(expected)}`),
    toBeGreaterThan: (expected: number) => assert.ok((actual as number) > expected, `expected ${String(actual)} > ${expected}`),
    toThrow: (expected?: string | RegExp) => {
      if (expected === undefined) return assert.throws(actual as () => unknown)
      const pattern = typeof expected === 'string' ? new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : expected
      return assert.throws(actual as () => unknown, { message: pattern })
    },
    not: {
      toBe: (expected: unknown) => assert.notEqual(actual, expected),
      toBeNull: () => assert.notEqual(actual, null),
    },
  }
}
