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
export type IncomeAllocationLimits = {
  eligibleDebtBalanceCzk: number
  withoutDebtBtcPercent: number
  withoutDebtCashPercent: number
}
export function createCoinmatePaymentPayload(amountCzk: number, iban: string, variableSymbol: string, recipientMessage: string) {
  if (!Number.isFinite(amountCzk) || amountCzk <= 0) throw new Error('Částka QR platby musí být kladná.')
  const compactIban = iban.replace(/\s/g, '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compactIban)) throw new Error('IBAN pro Coinmate QR není platný.')
  const compactVariableSymbol = variableSymbol.trim()
  if (!/^\d{1,10}$/.test(compactVariableSymbol)) throw new Error('Variabilní symbol pro Coinmate QR není platný.')
  const message = recipientMessage.trim()
  if (!message || message.includes('*')) throw new Error('Zpráva pro Coinmate QR není platná.')
  const amount = (Math.round(amountCzk * 100) / 100).toFixed(2)
  return `SPD*1.0*ACC:${compactIban}*AM:${amount}*CC:CZK*X-VS:${compactVariableSymbol}*MSG:${message}*`
}

export function createCashPaymentPayload(amountCzk: number, iban: string) {
  if (!Number.isFinite(amountCzk) || amountCzk <= 0) throw new Error('Částka QR platby musí být kladná.')
  const compactIban = iban.replace(/\s/g, '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compactIban)) throw new Error('IBAN pro Cash QR není platný.')
  const amount = (Math.round(amountCzk * 100) / 100).toFixed(2)
  return `SPD*1.0*ACC:${compactIban}*AM:${amount}*CC:CZK*MSG:Cash rezerva*`
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
  limits?: IncomeAllocationLimits,
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
  let btcAmount = distributableCapital * btcPercent / 100
    + (nonDebtPercent > 0 ? scheduledDebtOffset * btcPercent / nonDebtPercent : 0)
  let cashAmount = distributableCapital * cashPercent / 100
    + (nonDebtPercent > 0 ? scheduledDebtOffset * cashPercent / nonDebtPercent : 0)
  let freshDebtBudget = rawDebtBudget - scheduledDebtOffset
  let debtBudget = freshDebtBudget + deferredApplied
  if (hasDebts && limits) {
    const earlyPaymentCapacity = Math.max(0, limits.eligibleDebtBalanceCzk - scheduledApplied)
    const cappedDebtBudget = Math.min(debtBudget, earlyPaymentCapacity)
    const excessDebtBudget = debtBudget - cappedDebtBudget
    const fallbackTotal = limits.withoutDebtBtcPercent + limits.withoutDebtCashPercent
    if (excessDebtBudget > 0 && fallbackTotal > 0) {
      btcAmount += excessDebtBudget * limits.withoutDebtBtcPercent / fallbackTotal
      cashAmount += excessDebtBudget * limits.withoutDebtCashPercent / fallbackTotal
    }
    debtBudget = cappedDebtBudget
    freshDebtBudget = Math.min(freshDebtBudget, Math.max(0, debtBudget - deferredApplied))
  }
  return {
    scheduledApplied,
    deferredApplied,
    distributableCapital,
    btcAmount,
    freshDebtBudget,
    debtBudget,
    cashAmount,
  }
}
