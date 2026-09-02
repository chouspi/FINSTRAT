import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import QRCode from "qrcode";
import {
  Banknote,
  Bitcoin,
  ArrowRight,
  CheckCircle2,
  CircleDollarSign,
  Landmark,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import { antiforgeryToken, apiRequest } from "../lib/api";
import {
  allocateDebtBudget,
  calculateIncomeAllocation,
  createCashPaymentPayload,
  formatCzkInput,
  parseCzkInput,
  redirectBtcToDeferredVwce,
} from "../lib/incomePlan";
import { dateToIsoTimestamp, todayIsoDate } from "../lib/date";
import { createUuid } from "../lib/uuid";
import { notifyDataChanged } from "../lib/dataRefresh";
import "./IncomePlanPage.css";

type Settings = {
  defaultCapitalCzk: number;
  withoutDebtBtcPercent: number;
  withoutDebtCashPercent: number;
  withDebtBtcPercent: number;
  withDebtDebtPercent: number;
  withDebtCashPercent: number;
  deferredDebtPaymentCzk: number;
};
type PlanDebt = {
  id: string;
  name: string;
  priority: number;
  balanceCzk: number;
};
type Overview = { settings: Settings; debts: PlanDebt[]; scheduledDebtPaymentCzk?: number; deferredVwceCzk?: number };
type CurrentUser = { isDefault: boolean };
type BitcoinAccount = { id: string; name: string; canManage: boolean };
type BitcoinOverview = { accounts: BitcoinAccount[] };
type BtcPrice = { priceCzk: number };
type VwceAccount = { id: string; name: string; isOwnedByCurrentUser: boolean };
type VwceOverview = { accounts: VwceAccount[] };
type VwcePrice = { priceCzk: number };

const czk = new Intl.NumberFormat("cs-CZ", {
  style: "currency",
  currency: "CZK",
  maximumFractionDigits: 0,
});
const apiDecimal = (value: string) => value.replace(/\s/g, "").replace(",", ".");

export function IncomePlanPage() {
  const navigate = useNavigate();
  const { dialog } = useSearch({ from: "/income-plan" });
  const overview = useQuery({
    queryKey: ["income-plan", "overview"],
    queryFn: () => apiRequest<Overview>("/api/income-plan/overview"),
    retry: false,
  });
  const identity = useQuery({
    queryKey: ["identity", "me"],
    queryFn: () => apiRequest<CurrentUser>("/api/identity/me"),
    retry: false,
  });
  if (overview.isPending)
    return (
      <section className="income-page">
        <div className="income-loading" />
      </section>
    );
  if (overview.isError)
    return (
      <section className="income-page income-state">
        <CircleDollarSign size={28} />
        <h2>Income plan se nepodařilo načíst</h2>
        <button type="button" onClick={() => overview.refetch()}>
          Zkusit znovu
        </button>
      </section>
    );
  return (
    <>
      <IncomePlanContent initial={overview.data} canManage={identity.data?.isDefault === false} />
      {dialog === "process" && identity.data?.isDefault === false && (
        <ProcessIncomeDialog
          initial={overview.data}
          onClose={() =>
            void navigate({
              to: "/income-plan",
              search: { dialog: undefined },
              replace: true,
            })
          }
        />
      )}
    </>
  );
}

function ProcessIncomeDialog({
  initial,
  onClose,
}: {
  initial: Overview;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [capital, setCapital] = useState(
    formatCzkInput(String(initial.settings.defaultCapitalCzk || "")),
  );
  const [showPurchase, setShowPurchase] = useState(false);
  const [showVwcePurchase, setShowVwcePurchase] = useState(false);
  const [btcSaved, setBtcSaved] = useState<number | null>(null);
  const [vwceSaved, setVwceSaved] = useState<number | null>(null);
  const [debtsDone, setDebtsDone] = useState(false);
  const [debtsDeferred, setDebtsDeferred] = useState(false);
  const [deferredBalance] = useState(() => initial.settings.deferredDebtPaymentCzk ?? 0);
  const paymentKeys = useRef(
    new Map(initial.debts.map((debt) => [debt.id, createUuid()])),
  );
  const accounts = useQuery({
    queryKey: ["bitcoin", "overview"],
    queryFn: () => apiRequest<BitcoinOverview>("/api/bitcoin/overview"),
    retry: false,
  });
  const price = useQuery({
    queryKey: ["market-data", "btc-price"],
    queryFn: () => apiRequest<BtcPrice>("/api/market-data/btc-price"),
    retry: false,
  });
  const vwceAccounts = useQuery({ queryKey: ["vwce", "overview"], queryFn: () => apiRequest<VwceOverview>("/api/vwce/overview"), retry: false });
  const vwcePrice = useQuery({ queryKey: ["market-data", "vwce-price"], queryFn: () => apiRequest<VwcePrice>("/api/market-data/vwce-price"), retry: false });
  const amount = parseCzkInput(capital);
  const validAmount = Number.isFinite(amount) && amount > 0;
  const hasDebts = initial.debts.length > 0;
  const btcPercent = hasDebts
    ? initial.settings.withDebtBtcPercent
    : initial.settings.withoutDebtBtcPercent;
  const debtPercent = hasDebts ? initial.settings.withDebtDebtPercent : 0;
  const cashPercent = hasDebts
    ? initial.settings.withDebtCashPercent
    : initial.settings.withoutDebtCashPercent;
  const allocation = calculateIncomeAllocation(
    validAmount ? amount : 0,
    initial.scheduledDebtPaymentCzk ?? 0,
    deferredBalance,
    btcPercent,
    debtPercent,
    cashPercent,
    hasDebts,
  );
  const { scheduledApplied, deferredApplied, distributableCapital, freshDebtBudget, debtBudget, cashAmount } = allocation;
  const vwceAmount = Math.min(allocation.btcAmount, initial.deferredVwceCzk ?? 0);
  const btcAmount = Math.max(0, allocation.btcAmount - vwceAmount);
  const debtAllocations = allocateDebtBudget(initial.debts, debtBudget);
  const freshDebtAllocations = allocateDebtBudget(initial.debts, freshDebtBudget);
  const deferAmount = [...freshDebtAllocations.values()].reduce((sum, value) => sum + value, 0);
  const canDeferPayment = deferredApplied > 0.005 || deferAmount > 0.005;
  const manageableAccounts =
    accounts.data?.accounts.filter((account) => account.canManage) ?? [];
  const ownedVwceAccounts = Array.isArray(vwceAccounts.data?.accounts) ? vwceAccounts.data.accounts.filter((account) => account.isOwnedByCurrentUser) : [];
  const debtPayments = initial.debts
    .map((debt) => ({
      debt,
      amount: Math.min(
        debt.balanceCzk,
        Math.round((debtAllocations.get(debt.id) ?? 0) * 100) / 100,
      ),
    }))
    .filter((item) => item.amount > 0);
  const paidTotal = debtPayments.reduce((sum, payment) => sum + payment.amount, 0);
  const deferredToConsume = Math.min(deferredApplied, paidTotal);
  const adjustDeferred = async (path: string, adjustedAmount: number) => {
    const token = await antiforgeryToken();
    return apiRequest<{ deferredDebtPaymentCzk: number }>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token },
      body: JSON.stringify({ amountCzk: adjustedAmount.toFixed(2), expectedDeferredDebtPaymentCzk: deferredBalance.toFixed(2) }),
    });
  };
  const payments = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken();
      for (const payment of debtPayments) {
        await apiRequest(`/api/debts/${payment.debt.id}/payments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-TOKEN": token,
            "Idempotency-Key": paymentKeys.current.get(payment.debt.id)!,
          },
          body: JSON.stringify({
            amountCzk: payment.amount.toFixed(2),
            effectiveAt: todayIsoDate(),
            note: "Income plán",
          }),
        });
      }
      if (deferredToConsume > 0.005)
        await adjustDeferred("/api/income-plan/deferred-debt-payment/consume", deferredToConsume);
    },
    onSuccess: async () => {
      setDebtsDone(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["debts"] }),
        queryClient.invalidateQueries({ queryKey: ["income-plan"] }),
      ]);
      notifyDataChanged();
    },
  });
  const deferPayment = useMutation({
    mutationFn: async () => deferAmount > 0.005
      ? adjustDeferred("/api/income-plan/deferred-debt-payment", deferAmount)
      : null,
    onSuccess: async () => {
      setDebtsDeferred(true);
      await queryClient.invalidateQueries({ queryKey: ["income-plan"] });
    },
  });
  const debtActionDone = debtsDone || debtsDeferred;
  return (
    <>
      <div
        className="dialog-backdrop process-income-backdrop"
        role="presentation"
        onMouseDown={(event) =>
          event.target === event.currentTarget && onClose()
        }
      >
        <section
          className="process-income-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Zpracovat příjem"
        >
          <header>
            <div className="process-income-header-main">
              <label className="process-capital">
                Částka příjmu (Kč)
                <input
                  autoFocus
                  inputMode="decimal"
                  value={capital}
                  onChange={(event) => setCapital(formatCzkInput(event.target.value))}
                />
              </label>
              <ArrowRight className="process-income-arrow" size={32} strokeWidth={1.8} aria-hidden="true" />
              {validAmount && (
                <div className="process-summary">
                   {vwceAmount > .01 && <div className="vwce"><span>VWCE místo BTC</span><strong>{czk.format(vwceAmount)}</strong></div>}
                   <div className="btc"><span>BTC{scheduledApplied <= 0 && vwceAmount <= .01 ? ` · ${btcPercent} %` : ''}</span><strong>{czk.format(btcAmount)}</strong></div>
                  {debtPercent > 0 && <div className="debt"><span>Dluhy{scheduledApplied <= 0 ? ` · ${debtPercent} % + odloženo` : ''}</span><strong>{czk.format(debtBudget)}</strong></div>}
                  <div className="cash"><span>Cash{scheduledApplied <= 0 ? ` · ${cashPercent} %` : ''}</span><strong>{czk.format(cashAmount)}</strong></div>
                </div>
              )}
            </div>
            <button
              type="button"
              aria-label="Zavřít zpracování příjmu"
              onClick={onClose}
            >
              <X size={17} />
            </button>
          </header>
          <div className="process-income-layout">
          <div className="process-income-content">
            {scheduledApplied > 0.01 && (
              <p className="process-deferred-note">
                Na účtu zůstane {czk.format(scheduledApplied)} na budoucí splátky.
                Zbývajících {czk.format(amount - scheduledApplied)} se rozdělí; běžná složka splátek je o rezervu snížena.
              </p>
            )}
            {validAmount && (initial.scheduledDebtPaymentCzk ?? 0) > amount && (
              <p className="process-deferred-note">
                Budoucí splátky {czk.format(initial.scheduledDebtPaymentCzk ?? 0)} převyšují příjem, proto se tentokrát ignorují.
              </p>
            )}
            {deferredApplied > 0.01 && (
              <p className="process-deferred-note">
                Nejdřív jde {czk.format(deferredApplied)} na dříve odložené splátky.
                Zbývajících {czk.format(distributableCapital)} se dělí procenty.
              </p>
            )}
            {vwceAmount > 0.01 && <section className={`process-step${vwceSaved !== null ? " done" : ""}`}><div className="process-step-icon vwce">{vwceSaved !== null ? <CheckCircle2 size={16} /> : <Landmark size={16} />}</div><div className="process-step-body"><strong>Nákup VWCE místo BTC</strong><span>{vwceSaved !== null ? `Pool snížen o ${czk.format(vwceSaved)}` : ownedVwceAccounts.length === 0 ? "Nejdřív vytvořte vlastní VWCE účet" : `Kup za ${czk.format(vwceAmount)}; potvrzením se o tuto částku sníží pool`}</span></div>{vwceSaved === null && <button className="process-action" type="button" disabled={!validAmount || ownedVwceAccounts.length === 0} onClick={() => setShowVwcePurchase(true)}>Zapsat nákup</button>}</section>}
            {btcAmount > 0.01 && (
              <section
                className={`process-step${btcSaved !== null ? " done" : ""}`}
              >
                <div className="process-step-icon">
                  {btcSaved !== null ? (
                    <CheckCircle2 size={16} />
                  ) : (
                    <Bitcoin size={16} />
                  )}
                </div>
                <div className="process-step-body">
                  <strong>Nákup BTC</strong>
                  <span>
                    {btcSaved !== null
                      ? `Zapsáno ${btcSaved.toFixed(8)} BTC`
                      : manageableAccounts.length === 0
                        ? "Nejdřív vytvořte BTC účet na stránce BTC Účty"
                        : validAmount
                          ? `Kup za ${czk.format(btcAmount)} a zapiš nákup`
                          : "Zadej částku příjmu"}
                  </span>
                </div>
                {btcSaved === null && (
                  <button
                    className="process-action"
                    type="button"
                    disabled={!validAmount || manageableAccounts.length === 0}
                    onClick={() => setShowPurchase(true)}
                  >
                    Zapsat nákup
                  </button>
                )}
              </section>
            )}
            {debtPayments.length > 0 && (
              <section className={`process-step${debtActionDone ? " done" : ""}`}>
                <div className="process-step-icon debt">
                  <>
                    {debtActionDone ? (
                      <CheckCircle2 size={16} />
                    ) : (
                      <Banknote size={16} />
                    )}
                  </>
                </div>
                <div className="process-step-body debt-copy">
                  <strong>Splátky dluhů</strong>
                  {debtsDeferred ? <span>{deferAmount > 0.005 ? `${czk.format(deferAmount)} bylo přičteno; celkem odloženo ${czk.format(deferredBalance + deferAmount)}` : `Odložená splátka ${czk.format(deferredBalance)} zůstává odložená`}</span> : debtPayments.map((payment) => (
                    <span className="process-debt" key={payment.debt.id}>
                      {payment.debt.name}
                      <b>{czk.format(payment.amount)}</b>
                    </span>
                  ))}
                </div>
                {!debtActionDone && (
                  <div className="process-debt-actions">
                    <button className="process-action" type="button" disabled={payments.isPending || deferPayment.isPending} onClick={() => payments.mutate()}>
                      {payments.isPending ? "Platím…" : `Zaplatit vše (${czk.format(paidTotal)})`}
                    </button>
                    <button className="process-action defer" type="button" disabled={!canDeferPayment || payments.isPending || deferPayment.isPending} onClick={() => deferPayment.mutate()}>
                      {deferPayment.isPending ? "Odkládám…" : `${deferredApplied > 0.005 ? "Odložit znovu" : "Odložit splátku"} (${czk.format(paidTotal)})`}
                    </button>
                  </div>
                )}
              </section>
            )}
            {(payments.error || deferPayment.error) && (
              <p className="form-error" role="alert">
                {payments.error?.message ?? deferPayment.error?.message}
              </p>
            )}
            <footer>
              <button className="process-close" type="button" onClick={onClose}>
                Zavřít
              </button>
              <button type="button" disabled={!validAmount} onClick={onClose}>
                Dokončit
              </button>
            </footer>
          </div>
          <CashPaymentQrPanel amountCzk={cashAmount} />
          </div>
        </section>
      </div>
      {showPurchase && (
        <IncomePurchaseDialog
          accounts={manageableAccounts}
          totalCzk={btcAmount}
          currentPriceCzk={price.data?.priceCzk}
          onClose={() => setShowPurchase(false)}
          onSaved={(quantity) => {
            setBtcSaved(quantity);
            setShowPurchase(false);
          }}
        />
      )}
      {showVwcePurchase && <IncomeVwcePurchaseDialog accounts={ownedVwceAccounts} totalCzk={vwceAmount} currentPriceCzk={vwcePrice.data?.priceCzk} onClose={() => setShowVwcePurchase(false)} onSaved={(consumed) => { setVwceSaved(consumed); setShowVwcePurchase(false) }} />}
    </>
  );
}

function CashPaymentQrPanel({ amountCzk }: { amountCzk: number }) {
  const [qr, setQr] = useState({ payload: '', url: '' })
  const payload = amountCzk > 0.005 ? createCashPaymentPayload(amountCzk, todayIsoDate()) : ''
  useEffect(() => {
    let active = true
    if (!payload) return () => { active = false }
    void QRCode.toString(payload, { type: 'svg', width: 260, margin: 1, errorCorrectionLevel: 'M' }).then((svg) => {
      if (active) setQr({ payload, url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` })
    })
    return () => { active = false }
  }, [payload])
  const qrUrl = qr.payload === payload ? qr.url : ''
  return <aside className="process-cash-qr" aria-label="QR platba do Cash rezervy"><strong className="process-cash-qr-title">Převod do Monety</strong>{qrUrl ? <img src={qrUrl} alt={`QR platba ${czk.format(amountCzk)}`} /> : <div className="cash-payment-loading" />}</aside>
}

function IncomeVwcePurchaseDialog({ accounts, totalCzk, currentPriceCzk, onClose, onSaved }: { accounts: VwceAccount[]; totalCzk: number; currentPriceCzk?: number; onClose: () => void; onSaved: (consumedCzk: number) => void }) {
  const queryClient = useQueryClient()
  const key = useRef(createUuid())
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [unitPriceCzk, setUnitPriceCzk] = useState(currentPriceCzk?.toFixed(2) ?? '')
  const [shares, setShares] = useState(currentPriceCzk && currentPriceCzk > 0 ? (totalCzk / currentPriceCzk).toFixed(8) : '')
  const price = Number(unitPriceCzk)
  const quantity = Number(shares)
  const actual = price * quantity
  const save = useMutation({ mutationFn: async () => { if (!(price > 0) || !(quantity > 0)) throw new Error('Zadejte platný počet podílů a cenu.'); const token = await antiforgeryToken(); return apiRequest<{ deferredVwceConsumedCzk: number }>(`/api/vwce/accounts/${accountId}/purchases`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token, 'Idempotency-Key': key.current }, body: JSON.stringify({ shares, unitPriceCzk: price.toFixed(2), acquiredAt: dateToIsoTimestamp(todayIsoDate()), note: 'Income plán · VWCE místo BTC', consumeDeferredVwce: true, deferredVwceAmountCzk: totalCzk.toFixed(2) }) }) }, onSuccess: async (result) => { await Promise.all([queryClient.invalidateQueries({ queryKey: ['vwce'] }), queryClient.invalidateQueries({ queryKey: ['taxes'] }), queryClient.invalidateQueries({ queryKey: ['strategy'] }), queryClient.invalidateQueries({ queryKey: ['income-plan'] })]); notifyDataChanged(); onSaved(result.deferredVwceConsumedCzk) } })
  return <div className="dialog-backdrop income-purchase-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="income-purchase-dialog" role="dialog" aria-modal="true" aria-labelledby="income-vwce-purchase-title"><header><strong id="income-vwce-purchase-title">Koupit VWCE místo BTC</strong><button type="button" aria-label="Zavřít nákup VWCE" onClick={onClose}><X size={17} /></button></header><form onSubmit={(event) => { event.preventDefault(); save.mutate() }}><label>Broker účet<select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></label><label>Počet podílů<input autoFocus inputMode="decimal" value={shares} onChange={(event) => setShares(event.target.value)} /></label><label>Cena za podíl (Kč)<input inputMode="decimal" value={unitPriceCzk} onChange={(event) => setUnitPriceCzk(event.target.value)} /></label><div className="income-purchase-total"><span>Evidovaná hodnota nákupu</span><strong>{Number.isFinite(actual) && actual > 0 ? czk.format(actual) : '—'}</strong></div><small>Potvrzením nákupu se Income pool sníží o plánovaných {czk.format(totalCzk)} bez ohledu na evidovanou hodnotu lotu.</small>{save.error && <p className="form-error" role="alert">{save.error.message}</p>}<footer><button type="button" onClick={onClose}>Zrušit</button><button className="primary" type="submit" disabled={save.isPending || !accountId || !(price > 0) || !(quantity > 0)}>Koupit VWCE</button></footer></form></section></div>
}

function IncomePurchaseDialog({
  accounts,
  totalCzk,
  currentPriceCzk,
  onClose,
  onSaved,
}: {
  accounts: BitcoinAccount[];
  totalCzk: number;
  currentPriceCzk?: number;
  onClose: () => void;
  onSaved: (quantity: number) => void;
}) {
  const queryClient = useQueryClient();
  const key = useRef(createUuid());
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [quantityBtc, setQuantityBtc] = useState("");
  const [unitPriceCzk, setUnitPriceCzk] = useState("");
  const quantity = parseCzkInput(quantityBtc);
  const unitPrice = parseCzkInput(unitPriceCzk);
  const save = useMutation({
    mutationFn: async () => {
      if (!(quantity > 0) || !(unitPrice > 0))
        throw new Error("Zadejte platné množství a cenu.");
      const token = await antiforgeryToken();
      return apiRequest("/api/bitcoin/purchases", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": token,
          "Idempotency-Key": key.current,
        },
        body: JSON.stringify({
          accountId,
          quantityBtc: apiDecimal(quantityBtc),
          unitPriceCzk: unitPrice.toFixed(2),
          acquiredAt: dateToIsoTimestamp(todayIsoDate()),
          txid: null,
          note: "Income plán",
        }),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["bitcoin"] });
      notifyDataChanged();
      onSaved(quantity);
    },
  });
  const useCurrentPrice = () => {
    if (!currentPriceCzk) return;
    setUnitPriceCzk(currentPriceCzk.toFixed(2));
    setQuantityBtc((totalCzk / currentPriceCzk).toFixed(8));
  };
  return (
    <div
      className="dialog-backdrop income-purchase-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="income-purchase-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="income-purchase-title"
      >
        <header>
          <strong id="income-purchase-title">Přidat nákup</strong>
          <button type="button" aria-label="Zavřít nákup" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <label>
            Účet
            <select
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Množství BTC
            <input
              autoFocus
              inputMode="decimal"
              value={quantityBtc}
              onChange={(event) => setQuantityBtc(event.target.value)}
            />
          </label>
          <label>
            Cena za BTC (Kč)
            <div className="process-price">
              <input
                inputMode="decimal"
                value={unitPriceCzk}
                onChange={(event) => setUnitPriceCzk(event.target.value)}
              />
              {currentPriceCzk && (
                <button type="button" onClick={useCurrentPrice}>
                  Aktuální
                </button>
              )}
            </div>
          </label>
          <div className="income-purchase-total">
            <span>Celkem</span>
            <strong>{czk.format(totalCzk)}</strong>
          </div>
          {save.error && (
            <p className="form-error" role="alert">
              {save.error.message}
            </p>
          )}
          <footer>
            <button type="button" onClick={onClose}>
              Zrušit
            </button>
            <button
              className="primary"
              type="submit"
              disabled={
                save.isPending ||
                !accountId ||
                !(quantity > 0) ||
                !(unitPrice > 0)
              }
            >
              Přidat nákup
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function IncomePlanContent({ initial, canManage }: { initial: Overview; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [capital, setCapital] = useState(
    formatCzkInput(String(initial.settings.defaultCapitalCzk || "")),
  );
  const settings = initial.settings;
  const hasDebts = initial.debts.length > 0;
  const amount = parseCzkInput(capital);
  const validAmount = Number.isFinite(amount) && amount >= 0;
  const percentages = hasDebts
    ? {
        btc: settings.withDebtBtcPercent,
        debt: settings.withDebtDebtPercent,
        cash: settings.withDebtCashPercent,
      }
    : {
        btc: settings.withoutDebtBtcPercent,
        debt: 0,
        cash: settings.withoutDebtCashPercent,
      };
  const deferredBalance = settings.deferredDebtPaymentCzk ?? 0;
  const scheduledDebtPayment = initial.scheduledDebtPaymentCzk ?? 0;
  const allocation = calculateIncomeAllocation(
    validAmount ? amount : 0,
    scheduledDebtPayment,
    deferredBalance,
    percentages.btc,
    percentages.debt,
    percentages.cash,
    hasDebts,
  );
  const { scheduledApplied, deferredApplied, debtBudget } = allocation;
  const { btcAmount: directBtcAmount, vwceAmount } = redirectBtcToDeferredVwce(allocation.btcAmount, initial.deferredVwceCzk ?? 0)
  const rows = [
    ...(vwceAmount > .005 ? [{ key: "vwce", label: "VWCE místo BTC", note: `zbývá v poolu ${czk.format(initial.deferredVwceCzk ?? 0)}`, percent: validAmount && amount > 0 ? vwceAmount / amount * 100 : 0, amount: vwceAmount, icon: Landmark, tone: "blue" }] : []),
    ...(directBtcAmount > .005 || vwceAmount <= .005 ? [{
      key: "btc",
      label: "Bitcoin",
      note: "dlouhodobý kapitál",
      percent: vwceAmount > .005 && validAmount && amount > 0 ? directBtcAmount / amount * 100 : percentages.btc,
      amount: directBtcAmount,
      icon: Bitcoin,
      tone: "copper",
    }] : []),
    ...(hasDebts
      ? [
          {
            key: "debt",
            label: "Dluhy",
            note: deferredApplied > 0 ? `předčasné splátky · včetně ${czk.format(deferredApplied)} odložených` : "předčasné splátky",
            percent: percentages.debt,
            amount: debtBudget + scheduledApplied,
            icon: Landmark,
            tone: "red",
          },
        ]
      : []),
    {
      key: "cash",
      label: "Cash",
      note: "likvidní rezerva",
      percent: percentages.cash,
      amount: allocation.cashAmount,
      icon: Wallet,
      tone: "green",
    },
  ];
  const allocations = allocateDebtBudget(initial.debts, debtBudget);
  const allocatedDebt = [...allocations.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  const saveCapital = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken();
      return apiRequest<Settings>("/api/income-plan/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token },
        body: JSON.stringify({
          ...settings,
          defaultCapitalCzk: String(amount),
        }),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["income-plan"] });
    },
  });
  const deleteDeferred = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken();
      return apiRequest(`/api/income-plan/deferred-debt-payment?expectedDeferredDebtPaymentCzk=${encodeURIComponent(deferredBalance.toFixed(2))}`, {
        method: "DELETE",
        headers: { "X-CSRF-TOKEN": token },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["income-plan"] });
    },
  });

  return (
    <section className="income-page">
      <div className="income-hero">
        <div className="income-capital">
          <p>VOLNÝ KAPITÁL</p>
          <label>
            <input
              aria-label="Volný kapitál"
              inputMode="decimal"
              value={capital}
              placeholder="0"
              onChange={(event) =>
                setCapital(formatCzkInput(event.target.value))
              }
              onBlur={() => validAmount && saveCapital.mutate()}
            />
            <span>Kč</span>
          </label>
          {deferredBalance > 0.01 && (
            <div className="income-deferred-balance"><span>Odložené splátky</span><strong>{czk.format(deferredBalance)}</strong>{canManage && <button type="button" aria-label="Smazat odložené splátky" disabled={deleteDeferred.isPending} onClick={() => deleteDeferred.mutate()}><Trash2 size={13} /></button>}</div>
          )}
        </div>
        <div className="income-flow" aria-label="Rozdělení příjmu">
          {rows.map((row) => (
            <div
              className={`income-flow-row income-flow-row--${row.tone}`}
              key={row.key}
            >
              <div className="income-flow-icon">
                <row.icon size={17} />
              </div>
              <div>
                <strong>{row.label}</strong>
                {row.key === "debt" && scheduledDebtPayment > 0 ? (
                  <div className="income-debt-split">
                    <span><em>Pravidelné splátky</em><b>{validAmount ? czk.format(scheduledApplied) : "—"}</b></span>
                    <span><em>Předčasné splátky</em><b>{validAmount ? czk.format(debtBudget) : "—"}</b></span>
                  </div>
                ) : <span>{row.note}</span>}
              </div>
              <b>{row.percent} %</b>
              <output>
                {validAmount ? czk.format(row.amount) : "—"}
              </output>
            </div>
          ))}
        </div>
      </div>

      {hasDebts && (
        <div className="income-debts">
          <div className="income-section-heading">
            <div>
              <p>PLÁN SPLÁTEK</p>
              <h2>Rozdělení podle priorit</h2>
            </div>
            <div>
              <span>Budget</span>
              <strong>{czk.format(debtBudget)}</strong>
            </div>
          </div>
          <div className="income-debt-list">
            {initial.debts.map((debt) => {
              const payment = allocations.get(debt.id) ?? 0;
              return (
                <div className="income-debt-row" key={debt.id}>
                  <div>
                    <strong>{debt.name}</strong>
                    <span>
                      {debt.priority === 0
                        ? "Mimo automatický plán"
                        : `Priorita ${debt.priority}/5`}
                    </span>
                  </div>
                  <div className="income-debt-bar">
                    <span
                      style={{
                        width: `${debt.balanceCzk > 0 ? Math.min(100, (payment / debt.balanceCzk) * 100) : 0}%`,
                      }}
                    />
                  </div>
                  <small>Zůstatek {czk.format(debt.balanceCzk)}</small>
                  <output>{payment > 0 ? czk.format(payment) : "—"}</output>
                </div>
              );
            })}
          </div>
          {debtBudget > allocatedDebt + 0.01 && (
            <p className="income-remainder">
              Po doplacení způsobilých dluhů zbývá nerozděleno{" "}
              {czk.format(debtBudget - allocatedDebt)}.
            </p>
          )}
        </div>
      )}

      {(saveCapital.error || deleteDeferred.error) && (
        <p className="income-error" role="alert">
          {saveCapital.error?.message ?? deleteDeferred.error?.message}
        </p>
      )}
      <div className="income-footnote">
        <Banknote size={14} />
        <span>
          Hypotéky a dluhy s prioritou 0 jsou mimo plán předčasného splácení.
        </span>
      </div>
    </section>
  );
}
