import { describe, expect, it } from 'vitest'
import { allocateDebtBudget, calculateIncomeAllocation, createCashPaymentPayload, formatCzkInput, parseCzkInput, redirectBtcToDeferredVwce } from './incomePlan'

describe('allocateDebtBudget', () => {
  it('redistributes a capped debt share to remaining eligible debts', () => {
    const result = allocateDebtBudget([
      { id: 'small', priority: 5, balanceCzk: 100 },
      { id: 'large', priority: 5, balanceCzk: 1000 },
      { id: 'excluded', priority: 0, balanceCzk: 1000 },
    ], 500)

    expect(result.get('small')).toBe(100)
    expect(result.get('large')).toBe(400)
    expect(result.get('excluded')).toBe(0)
  })
})

describe('calculateIncomeAllocation', () => {
  it('redirects only the BTC allocation covered by the deferred VWCE pool', () => {
    expect(redirectBtcToDeferredVwce(6000, 2000)).toEqual({ btcAmount: 4000, vwceAmount: 2000 })
    expect(redirectBtcToDeferredVwce(6000, 10000)).toEqual({ btcAmount: 0, vwceAmount: 6000 })
  })

  it('ignores scheduled payments when income cannot cover their full amount', () => {
    expect(calculateIncomeAllocation(4000, 5000, 0, 60, 25, 15, true)).toMatchObject({
      scheduledApplied: 0,
      btcAmount: 2400,
      freshDebtBudget: 1000,
      cashAmount: 600,
    })
  })

  it('reserves covered future payments and redistributes the offset debt share to BTC and Cash', () => {
    const result = calculateIncomeAllocation(15000, 5000, 0, 60, 25, 15, true)
    expect(result.scheduledApplied).toBe(5000)
    expect(result.distributableCapital).toBe(10000)
    expect(result.freshDebtBudget).toBe(0)
    expect(result.btcAmount).toBe(8000)
    expect(result.cashAmount).toBe(2000)
    expect(result.btcAmount + result.debtBudget + result.cashAmount + result.scheduledApplied).toBe(15000)
  })
})

describe('CZK input formatting', () => {
  it('groups thousands while preserving a decimal part', () => {
    expect(formatCzkInput('1000')).toBe('1 000')
    expect(formatCzkInput('1234567,50')).toBe('1 234 567,50')
    expect(parseCzkInput('1 234 567,50')).toBe(1234567.5)
  })
})

describe('Cash QR payment', () => {
  it('matches the supplied Czech payment descriptors and changes only the amount', () => {
    expect(createCashPaymentPayload(100, '2026-08-24')).toBe('SPD*1.0*ACC:CZ0506000000000264886458*AM:100.0*CC:CZK*DT:20260824*')
    expect(createCashPaymentPayload(2000, '2026-08-24')).toBe('SPD*1.0*ACC:CZ0506000000000264886458*AM:2000.0*CC:CZK*DT:20260824*')
  })
})
