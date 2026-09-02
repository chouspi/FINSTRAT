export type IncomePlanDebt = { id: string; priority: number; balanceCzk: number }
export type IncomeAllocation = {
  scheduledApplied: number
  deferredApplied: number
  distributableCapital: number
  btcAmount: number
  freshDebtBudget: number
  debtBudget: number
  cashAmount: number
}
export type DeferredVwceAllocation = { btcAmount: number; vwceAmount: number }
export const CASH_PAYMENT_IBAN = 'CZ0506000000000264886458'

export function createCashPaymentPayload(amountCzk: number, paymentDate: string) {
  if (!Number.isFinite(amountCzk) || amountCzk <= 0) throw new Error('Částka QR platby musí být kladná.')
  const compactDate = paymentDate.replaceAll('-', '')
  if (!/^\d{8}$/.test(compactDate)) throw new Error('Datum QR platby není platné.')
  const amount = (Math.round(amountCzk * 100) / 100).toFixed(2).replace(/0$/, '')
  return `SPD*1.0*ACC:${CASH_PAYMENT_IBAN}*AM:${amount}*CC:CZK*DT:${compactDate}*`
}

export function formatCzkInput(value: string) {
  const compact = value.replace(/\s/g, '')
  const match = compact.match(/^(\d*)([,.]?)(\d*)$/)
  if (!match) return value
  const [, integer, separator, fraction] = match
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${grouped}${separator}${fraction}`
}

export function parseCzkInput(value: string) {
  const compact = value.replace(/\s/g, '').replace(',', '.')
  return compact === '' ? Number.NaN : Number(compact)
}

export function redirectBtcToDeferredVwce(btcAmount: number, deferredVwceCzk: number): DeferredVwceAllocation {
  const vwceAmount = Math.min(Math.max(0, btcAmount), Math.max(0, deferredVwceCzk))
  return { btcAmount: Math.max(0, btcAmount - vwceAmount), vwceAmount }
}

export function allocateDebtBudget(debts: IncomePlanDebt[], requestedBudget: number) {
  const result = new Map(debts.map((debt) => [debt.id, 0]))
  let pool = debts.filter((debt) => debt.priority > 0 && debt.balanceCzk > 0)
  let budget = Math.min(Math.max(0, requestedBudget), pool.reduce((sum, debt) => sum + debt.balanceCzk, 0))
  while (pool.length > 0 && budget > .005) {
    const weight = pool.reduce((sum, debt) => sum + debt.priority, 0)
    const capped = pool.filter((debt) => budget * debt.priority / weight >= debt.balanceCzk - (result.get(debt.id) ?? 0))
    if (capped.length === 0) {
      for (const debt of pool) result.set(debt.id, (result.get(debt.id) ?? 0) + budget * debt.priority / weight)
      break
    }
    for (const debt of capped) {
      const remaining = debt.balanceCzk - (result.get(debt.id) ?? 0)
      result.set(debt.id, debt.balanceCzk)
      budget -= remaining
    }
    const cappedIds = new Set(capped.map((debt) => debt.id))
    pool = pool.filter((debt) => !cappedIds.has(debt.id))
  }
  return result
}

export function calculateIncomeAllocation(
  capital: number,
  scheduledDebtPayment: number,
  deferredDebtPayment: number,
  btcPercent: number,
  debtPercent: number,
  cashPercent: number,
  hasDebts: boolean,
): IncomeAllocation {
  const scheduledApplied = scheduledDebtPayment > 0 && capital >= scheduledDebtPayment
    ? scheduledDebtPayment
    : 0
  const afterScheduled = Math.max(0, capital - scheduledApplied)
  const deferredApplied = hasDebts ? Math.min(afterScheduled, Math.max(0, deferredDebtPayment)) : 0
  const distributableCapital = afterScheduled - deferredApplied
  const rawDebtBudget = distributableCapital * debtPercent / 100
  const scheduledDebtOffset = Math.min(scheduledApplied, rawDebtBudget)
  const nonDebtPercent = btcPercent + cashPercent
  const btcAmount = distributableCapital * btcPercent / 100
    + (nonDebtPercent > 0 ? scheduledDebtOffset * btcPercent / nonDebtPercent : 0)
  const cashAmount = distributableCapital * cashPercent / 100
    + (nonDebtPercent > 0 ? scheduledDebtOffset * cashPercent / nonDebtPercent : 0)
  const freshDebtBudget = rawDebtBudget - scheduledDebtOffset
  return {
    scheduledApplied,
    deferredApplied,
    distributableCapital,
    btcAmount,
    freshDebtBudget,
    debtBudget: freshDebtBudget + deferredApplied,
    cashAmount,
  }
}
