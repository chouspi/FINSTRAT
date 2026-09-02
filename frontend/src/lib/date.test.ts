import { describe, expect, it } from 'vitest'
import { dateToIsoTimestamp, formatCzechDate, parseCzechDate } from './date'

describe('dateToIsoTimestamp', () => {
  it('uses the current instant for the current local date', () => {
    const now = new Date()
    const today = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)

    expect(dateToIsoTimestamp(today, now)).toBe(now.toISOString())
  })

  it('uses local noon for a historical date', () => {
    const expected = new Date('2020-01-02T12:00:00').toISOString()
    expect(dateToIsoTimestamp('2020-01-02')).toBe(expected)
  })

  it('formats and validates Czech calendar dates', () => {
    expect(formatCzechDate('2026-08-21')).toBe('21.08.2026')
    expect(parseCzechDate('21.8.2026')).toBe('2026-08-21')
    expect(parseCzechDate('31.2.2026')).toBeNull()
  })
})
