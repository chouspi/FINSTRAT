import { describe, expect, it } from 'vitest'
import { allocateDebtBudget, calculateIncomeAllocation, createCashPaymentPayload, createCoinmatePaymentPayload, formatCzkInput, parseCzkInput, redirectBtcToDeferredVwce } from './incomePlan'

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

  it('caps debt allocation at the real balance and redistributes excess by the debt-free profile', () => {
    const result = calculateIncomeAllocation(10000, 0, 0, 60, 25, 15, true, {
      eligibleDebtBalanceCzk: 500,
      withoutDebtBtcPercent: 80,
      withoutDebtCashPercent: 20,
    })

    expect(result.debtBudget).toBe(500)
    expect(result.freshDebtBudget).toBe(500)
    expect(result.btcAmount).toBe(7600)
    expect(result.cashAmount).toBe(1900)
    expect(result.btcAmount + result.debtBudget + result.cashAmount).toBe(10000)
  })

  it('subtracts reserved payments from the remaining real debt capacity', () => {
    const result = calculateIncomeAllocation(10000, 500, 0, 60, 25, 15, true, {
      eligibleDebtBalanceCzk: 1000,
      withoutDebtBtcPercent: 80,
      withoutDebtCashPercent: 20,
    })

    expect(result.scheduledApplied).toBe(500)
    expect(result.debtBudget).toBe(500)
    expect(result.btcAmount + result.cashAmount + result.debtBudget + result.scheduledApplied).toBe(10000)
  })
})

describe('CZK input formatting', () => {
  it('groups thousands while preserving a decimal part', () => {
    expect(formatCzkInput('1000')).toBe('1 000')
    expect(formatCzkInput('1234567,50')).toBe('1 234 567,50')
    expect(parseCzkInput('1 234 567,50')).toBe(1234567.5)
  })
})

describe('Coinmate QR payment', () => {
  it('creates an SPD 1.0 payload with all Coinmate payment descriptors', () => {
    expect(createCoinmatePaymentPayload(1234.5, 'CZ65 0800 0000 1920 0014 5399', '123456', 'Coinmate deposit')).toBe('SPD*1.0*ACC:CZ6508000000192000145399*AM:1234.50*CC:CZK*X-VS:123456*MSG:Coinmate deposit*')
    expect(() => createCoinmatePaymentPayload(100, '  ', '123456', 'Coinmate deposit')).toThrow('IBAN')
  })
})

describe('Cash QR payment', () => {
  it('creates an SPD 1.0 payload for the configured Cash account', () => {
    expect(createCashPaymentPayload(1500.5, 'CZ65 0800 0000 1920 0014 5399')).toBe('SPD*1.0*ACC:CZ6508000000192000145399*AM:1500.50*CC:CZK*MSG:Cash rezerva*')
    expect(() => createCashPaymentPayload(100, '  ')).toThrow('IBAN')
  })
})
