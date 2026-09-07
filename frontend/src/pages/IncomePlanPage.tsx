import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import QRCode from "qrcode";
import {
  Banknote,
  Bitcoin,
  Check,
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
  createCoinmatePaymentPayload,
  formatCzkInput,
  parseCzkInput,
  redirectBtcToDeferredVwce,
} from "../lib/incomePlan";
import { todayIsoDate } from "../lib/date";
import { createUuid } from "../lib/uuid";
import "./IncomePlanPage.css";

type Settings = {
  defaultCapitalCzk: number;
  withoutDebtBtcPercent: number;
  withoutDebtCashPercent: number;
  withDebtBtcPercent: number;
  withDebtDebtPercent: number;
  withDebtCashPercent: number;
  deferredDebtPaymentCzk: number;
  cashAccountIban: string | null;
  coinmateIban: string | null;
  coinmateVariableSymbol: string | null;
  coinmateRecipientMessage: string | null;
};
type PlanDebt = { id: string; name: string; priority: number; balanceCzk: number };
type Overview = { settings: Settings; debts: PlanDebt[]; scheduledDebtPaymentCzk?: number; deferredVwceCzk?: number };
type CurrentUser = { id: string; householdId?: string; isDefault: boolean };
type BalanceWatch = { watchId: string; currency: "czk"; initialBalance: number; expiresInSeconds: number };
type BalanceWatchResult = { changed: boolean; currency: "czk"; balance: number };
type WatchState = { watchId: string; phase: "idle" | "starting" | "ready" | "waiting" | "confirmed" | "error"; error: string };
type DebtPaymentPlan = { debt: PlanDebt; amount: number; freshAmount: number; deferredAmount: number };
type CoinmatePurchaseResult = { success: boolean; btcBought: number; status: string; pending: boolean };
type BitcoinPurchaseOverview = { accounts: { id: string; name: string; canManage: boolean }[] };

type IncomeDraft = {
  version: 1;
  capital: string;
  processingOverview: Overview | null;
  btcSent: boolean;
  btcAmountToProcess: number;
  cashAmountToProcess: number | null;
  debtStep: "idle" | "active" | "complete";
  debtIndex: number;
  debtPayments: DebtPaymentPlan[];
  processedDebtIds: string[];
  cashStep: "idle" | "active" | "complete";
  localDeferredBalance: number;
  vwceDone: boolean;
  watch: WatchState | null;
  purchaseStarted: boolean;
  purchaseResult: CoinmatePurchaseResult | null;
  ledgerKey: string;
  paymentKeys: Record<string, string>;
  acquiredAt: string;
  effectiveAt: string;
};
function freshDraft(initial: Overview): IncomeDraft {
  return { version: 1, capital: formatCzkInput(String(initial.settings.defaultCapitalCzk || "")),
    processingOverview: null, btcSent: false, btcAmountToProcess: 0, cashAmountToProcess: null,
    debtStep: "idle", debtIndex: 0, debtPayments: [], processedDebtIds: [], cashStep: "idle",
    localDeferredBalance: initial.settings.deferredDebtPaymentCzk ?? 0, vwceDone: false,
    watch: null, purchaseStarted: false, purchaseResult: null, ledgerKey: createUuid(),
    paymentKeys: {}, acquiredAt: new Date().toISOString(), effectiveAt: todayIsoDate() };
}
function readDraft(key: string | null, initial: Overview): IncomeDraft {
  if (key) {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) {
        const value = JSON.parse(raw) as IncomeDraft;
        if (value && value.version === 1 && typeof value.capital === "string" && typeof value.ledgerKey === "string"
          && Array.isArray(value.debtPayments) && Array.isArray(value.processedDebtIds)
          && typeof value.btcSent === "boolean" && typeof value.vwceDone === "boolean"
          && typeof value.purchaseStarted === "boolean" && typeof value.acquiredAt === "string"
          && Number.isFinite(Date.parse(value.acquiredAt)) && /^\d{4}-\d{2}-\d{2}$/.test(value.effectiveAt)
          && Number.isFinite(value.btcAmountToProcess) && value.btcAmountToProcess >= 0
          && Number.isFinite(value.localDeferredBalance) && value.localDeferredBalance >= 0
          && Number.isInteger(value.debtIndex) && value.debtIndex >= 0
          && ["idle", "active", "complete"].includes(value.debtStep)
          && ["idle", "active", "complete"].includes(value.cashStep)
          && value.debtPayments.every((payment) => payment?.debt && typeof payment.debt.id === "string" && Number.isFinite(payment.amount) && Number.isFinite(payment.freshAmount) && Number.isFinite(payment.deferredAmount))
          && value.processedDebtIds.every((id) => typeof id === "string")
          && typeof value.paymentKeys === "object" && value.paymentKeys !== null
          && (!value.processingOverview || (value.processingOverview.settings && Array.isArray(value.processingOverview.debts)))) return value;
      }
    } catch { /* An unavailable or invalid draft must not prevent opening the plan. */ }
  }
  return freshDraft(initial);
}

const czk = new Intl.NumberFormat("cs-CZ", {
  style: "currency",
  currency: "CZK",
  maximumFractionDigits: 0,
});

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
  if (overview.isPending || identity.isPending) return <section className="income-page"><div className="income-loading" /></section>;
  if (overview.isError) return <section className="income-page income-state"><CircleDollarSign size={28} /><h2>Income plan se nepodařilo načíst</h2><button type="button" onClick={() => overview.refetch()}>Zkusit znovu</button></section>;
  const canManage = identity.data?.isDefault === false;
  const processing = dialog === "process" && canManage;
  const storageKey = processing && identity.data?.id ? `finstrat:income-draft:${identity.data.householdId ?? ""}:${identity.data.id}` : null;
  const resetRun = () => {
    if (storageKey) sessionStorage.removeItem(storageKey);
    void navigate({ to: "/income-plan", search: { dialog: undefined } });
    void overview.refetch();
  };
  return <IncomePlanContent key={`${identity.data?.id}:${processing}`} initial={overview.data} canManage={canManage} processing={processing} storageKey={storageKey} onNewRun={resetRun} onCancel={resetRun} />;
}

function CoinmatePaymentQr({ amountCzk, settings, closing, watchStarting, onSent, onClosed }: { amountCzk: number; settings: Settings; closing: boolean; watchStarting: boolean; onSent: () => void; onClosed: () => void }) {
  const shellRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [qr, setQr] = useState({ payload: "", url: "" });
  const [qrError, setQrError] = useState("");
  let payload = "";
  let payloadError = "";
  if (settings.coinmateIban && settings.coinmateVariableSymbol && settings.coinmateRecipientMessage && amountCzk > 0.005) {
    try {
      payload = createCoinmatePaymentPayload(amountCzk, settings.coinmateIban, settings.coinmateVariableSymbol, settings.coinmateRecipientMessage);
    } catch (error) {
      payloadError = error instanceof Error ? error.message : "Coinmate QR nelze vytvořit.";
    }
  }

  useEffect(() => {
    let active = true;
    if (!payload) return () => { active = false; };
    void QRCode.toString(payload, { type: "svg", width: 260, margin: 1, errorCorrectionLevel: "M" })
      .then((svg) => {
        if (active) setQr({ payload, url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
      })
      .catch(() => {
        if (active) setQrError("Coinmate QR se nepodařilo vytvořit.");
      });
    return () => { active = false; };
  }, [payload]);

  useEffect(() => {
    if (!closing) return;
    const fallback = window.setTimeout(onClosed, 560);
    return () => window.clearTimeout(fallback);
  }, [closing, onClosed]);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    const content = contentRef.current;
    if (!shell || !content) return;
    const contentHeight = content.scrollHeight;
    shell.style.height = closing ? `${contentHeight}px` : "0px";
    shell.style.opacity = closing ? "1" : "0";
    void shell.offsetHeight;
    const frame = window.requestAnimationFrame(() => {
      shell.style.height = closing ? "0px" : `${contentHeight}px`;
      shell.style.opacity = closing ? "0" : "1";
    });
    return () => window.cancelAnimationFrame(frame);
  }, [closing]);

  const qrUrl = qr.payload === payload ? qr.url : "";
  return <div ref={shellRef} className={`income-btc-processing-shell${closing ? " closing" : ""}`} onTransitionEnd={(event) => { if (closing && event.target === event.currentTarget && event.propertyName === "height") onClosed(); }}>
    <div ref={contentRef} className="income-btc-processing-clip">
      <div className="income-btc-processing">
        <div className="income-coinmate-copy"><strong>Vklad na Coinmate</strong></div>
        <div className="income-coinmate-qr">
          {qrUrl ? <img src={qrUrl} alt={`Coinmate QR pro vklad ${czk.format(amountCzk)}`} /> : <div className="income-coinmate-qr-state" role="status">{payloadError || qrError || "Coinmate QR není dostupné. Zkontrolujte platební údaje v Nastavení."}</div>}
          <button className="income-coinmate-sent" type="button" disabled={closing || watchStarting} onClick={onSent}><Check size={14} />{watchStarting ? "Připravuji sledování…" : "Odesláno"}</button>
        </div>
      </div>
    </div>
  </div>;
}

function CashPaymentQr({ amountCzk, iban, onComplete }: { amountCzk: number; iban: string | null; onComplete: () => void }) {
  const [qr, setQr] = useState({ payload: "", url: "" });
  const [qrError, setQrError] = useState("");
  let payload = "";
  let payloadError = "";
  if (iban && amountCzk > .005) {
    try {
      payload = createCashPaymentPayload(amountCzk, iban);
    } catch (error) {
      payloadError = error instanceof Error ? error.message : "Spending QR nelze vytvořit.";
    }
  }

  useEffect(() => {
    let active = true;
    if (!payload) return () => { active = false; };
    void QRCode.toString(payload, { type: "svg", width: 260, margin: 1, errorCorrectionLevel: "M" })
      .then((svg) => {
        if (active) setQr({ payload, url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
      })
      .catch(() => {
        if (active) setQrError("Spending QR se nepodařilo vytvořit.");
      });
    return () => { active = false; };
  }, [payload]);

  const qrUrl = qr.payload === payload ? qr.url : "";
  return <div className="income-cash-processing">
    <strong>Převod na Spending účet</strong>
    <div className="income-cash-qr">
      {qrUrl ? <img src={qrUrl} alt={`Spending QR pro převod ${czk.format(amountCzk)}`} /> : <div className="income-cash-qr-state" role="status">{payloadError || qrError || "Spending QR není dostupné. Zkontrolujte IBAN v Nastavení."}</div>}
      <button type="button" onClick={onComplete}><Check size={14} />Potvrdit odeslání</button>
    </div>
  </div>;
}

function useCoinmateBalanceWatch(active: boolean, waiting: boolean, restored: WatchState | null, onChange: (watch: WatchState) => void) {
  const [attempt, setAttempt] = useState(0);
  const [watch, setWatch] = useState<WatchState>(() => restored ?? (active
    ? { watchId: "", phase: "starting", error: "" }
    : { watchId: "", phase: "idle", error: "" }));

  useEffect(() => {
    if (!active || (attempt === 0 && restored && restored.phase !== "starting" && restored.phase !== "idle")) return;
    let current = true;
    void (async () => {
      try {
        const token = await antiforgeryToken();
        const created = await apiRequest<BalanceWatch>("/api/income-plan/coinmate-balance-watch", {
          method: "POST",
          headers: { "X-CSRF-TOKEN": token },
        });
        if (current) setWatch({ watchId: created.watchId, phase: "ready", error: "" });
      } catch (error) {
        if (current) setWatch({ watchId: "", phase: "error", error: error instanceof Error ? error.message : "Sledování zůstatku se nepodařilo spustit." });
      }
    })();
    return () => { current = false; };
  }, [active, attempt, restored]);

  useEffect(() => {
    if (!active || !watch.watchId || watch.phase === "confirmed" || watch.phase === "error") return;
    const heartbeat = window.setInterval(() => {
      void (async () => {
        try {
          const token = await antiforgeryToken();
          await apiRequest(`/api/income-plan/coinmate-balance-watch/${watch.watchId}/ping`, { method: "POST", headers: { "X-CSRF-TOKEN": token } });
        } catch { /* The waiting request owns the terminal watcher result. */ }
      })();
    }, 10_000);
    return () => window.clearInterval(heartbeat);
  }, [active, watch.watchId, watch.phase]);

  useEffect(() => {
    if (!active || !watch.watchId || watch.phase === "confirmed" || watch.phase === "error") return;
    const controller = new AbortController();
    let current = true;
    void (async () => {
      try {
        const result = await apiRequest<BalanceWatchResult>(`/api/income-plan/coinmate-balance-watch/${watch.watchId}`, { signal: controller.signal });
        if (!result.changed) throw new Error("Sledování připsání CZK vypršelo.");
        if (current) setWatch((value) => ({ ...value, phase: "confirmed", error: "" }));
      } catch (error) {
        if (current) setWatch({ watchId: "", phase: "error", error: error instanceof Error ? error.message : "Připsání CZK se nepodařilo ověřit." });
      }
    })();
    return () => { current = false; controller.abort(); };
  }, [active, watch.watchId, watch.phase]);

  useEffect(() => { if (active) onChange(watch); }, [active, watch, onChange]);

  const visibleWatch = !active
    ? { watchId: "", phase: "idle", error: "" } as WatchState
    : waiting && watch.phase === "ready"
      ? { ...watch, phase: "waiting" as const }
      : watch;

  return {
    watch: visibleWatch,
    retry: () => {
      setWatch({ watchId: "", phase: "starting", error: "" });
      setAttempt((value) => value + 1);
    },
  };
}

function IncomePlanContent({ initial: latestOverview, canManage, processing, storageKey, onNewRun, onCancel }: { initial: Overview; canManage: boolean; processing: boolean; storageKey: string | null; onNewRun: () => void; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => readDraft(storageKey, latestOverview));
  const draftRef = useRef(draft);
  const [storageError, setStorageError] = useState("");
  const updateDraft = useCallback((patch: Partial<IncomeDraft>) => {
    const next = { ...draftRef.current, ...patch };
    if (storageKey) {
      try { sessionStorage.setItem(storageKey, JSON.stringify(next)); }
      catch { setStorageError("Průběh nelze uložit v prohlížeči. Povolte úložiště a zkuste akci znovu."); return false; }
    }
    draftRef.current = next;
    setDraft(next);
    setStorageError("");
    return true;
  }, [storageKey]);
  const { processingOverview, btcSent, btcAmountToProcess, cashAmountToProcess, debtStep, debtIndex,
    debtPayments, processedDebtIds, cashStep, localDeferredBalance, capital, vwceDone } = draft;
  const initial = processingOverview ?? latestOverview;
  const [btcStep, setBtcStep] = useState<"idle" | "qr" | "closing" | "waiting">(btcSent ? "waiting" : processing ? "qr" : "idle");
  const [restoredWatch] = useState(draft.watch);
  const saveWatch = useCallback((watch: WatchState) => { updateDraft({ watch }); }, [updateDraft]);
  const settings = initial.settings;
  const hasDebts = initial.debts.length > 0;
  const amount = parseCzkInput(capital);
  const validAmount = Number.isFinite(amount) && amount >= 0;
  const percentages = hasDebts
    ? { btc: settings.withDebtBtcPercent, debt: settings.withDebtDebtPercent, cash: settings.withDebtCashPercent }
    : { btc: settings.withoutDebtBtcPercent, debt: 0, cash: settings.withoutDebtCashPercent };
  const deferredBalance = settings.deferredDebtPaymentCzk ?? 0;
  const scheduledDebtPayment = initial.scheduledDebtPaymentCzk ?? 0;
  const eligibleDebtBalance = initial.debts.filter((debt) => debt.priority > 0).reduce((sum, debt) => sum + debt.balanceCzk, 0);
  const allocation = calculateIncomeAllocation(validAmount ? amount : 0, scheduledDebtPayment, deferredBalance, percentages.btc, percentages.debt, percentages.cash, hasDebts, {
    eligibleDebtBalanceCzk: eligibleDebtBalance,
    withoutDebtBtcPercent: settings.withoutDebtBtcPercent,
    withoutDebtCashPercent: settings.withoutDebtCashPercent,
  });
  const { scheduledApplied, deferredApplied, debtBudget } = allocation;
  const { btcAmount: directBtcAmount, vwceAmount } = redirectBtcToDeferredVwce(allocation.btcAmount, initial.deferredVwceCzk ?? 0);
  const rows = [
    ...(vwceAmount > .005 ? [{ key: "vwce", label: "VWCE místo BTC", note: `zbývá v poolu ${czk.format(initial.deferredVwceCzk ?? 0)}`, percent: validAmount && amount > 0 ? vwceAmount / amount * 100 : 0, amount: vwceAmount, icon: Landmark, tone: "blue" }] : []),
    ...(directBtcAmount > .005 || vwceAmount <= .005 ? [{ key: "btc", label: "Bitcoin", note: "dlouhodobý kapitál", percent: validAmount && amount > 0 ? Math.round(directBtcAmount / amount * 1000) / 10 : percentages.btc, amount: directBtcAmount, icon: Bitcoin, tone: "copper" }] : []),
    ...(hasDebts ? [{ key: "debt", label: "Dluhy", note: deferredApplied > 0 ? `předčasné splátky · včetně ${czk.format(deferredApplied)} odložených` : "předčasné splátky", percent: validAmount && amount > 0 ? Math.round((debtBudget + scheduledApplied) / amount * 1000) / 10 : percentages.debt, amount: debtBudget + scheduledApplied, icon: Landmark, tone: "red" }] : []),
    { key: "cash", label: "Spending účet", note: "běžné výdaje", percent: validAmount && amount > 0 ? Math.round((cashAmountToProcess ?? allocation.cashAmount) / amount * 1000) / 10 : percentages.cash, amount: cashAmountToProcess ?? allocation.cashAmount, icon: Wallet, tone: "green" },
  ];
  const allocations = allocateDebtBudget(initial.debts, debtBudget);
  const freshAllocations = allocateDebtBudget(initial.debts, Math.max(0, debtBudget - deferredApplied));
  const candidateDebtPayments = initial.debts
    .map((debt) => {
      const paymentAmount = allocations.get(debt.id) ?? 0;
      const freshAmount = freshAllocations.get(debt.id) ?? 0;
      return { debt, amount: paymentAmount, freshAmount, deferredAmount: Math.max(0, paymentAmount - freshAmount) };
    })
    .filter((payment) => payment.amount > .005);
  const eligibleDebtCount = initial.debts.filter((debt) => debt.priority > 0).length;
  const allocatedDebt = [...allocations.values()].reduce((sum, value) => sum + value, 0);
  const balanceWatch = useCoinmateBalanceWatch(processing && directBtcAmount > .005 && !draft.purchaseStarted && !draft.purchaseResult, btcSent, restoredWatch, saveWatch);
  const coinmateLedgerKey = useRef(draft.ledgerKey);
  const btcPurchaseStarted = useRef(false);
  const saveCapital = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken();
      return apiRequest<Settings>("/api/income-plan/settings", { method: "PUT", headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token }, body: JSON.stringify({ ...settings, defaultCapitalCzk: String(amount) }) });
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["income-plan"] }); },
  });
  const deleteDeferred = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken();
      return apiRequest(`/api/income-plan/deferred-debt-payment?expectedDeferredDebtPaymentCzk=${encodeURIComponent(deferredBalance.toFixed(2))}`, { method: "DELETE", headers: { "X-CSRF-TOKEN": token } });
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["income-plan"] }); },
  });
  const btcPurchase = useMutation({
    mutationFn: async ({ amountCzk }: { amountCzk: number }) => {
      if (!updateDraft({ purchaseStarted: true })) throw new Error("Průběh nákupu nelze uložit.");
      const csrf = await antiforgeryToken();
      let trade = await apiRequest<CoinmatePurchaseResult>("/api/income-plan/coinmate-bitcoin-purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrf, "Idempotency-Key": coinmateLedgerKey.current },
        body: JSON.stringify({ amountCzk: amountCzk.toFixed(2) }),
      });
      while (trade.pending) {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        trade = await apiRequest<CoinmatePurchaseResult>(`/api/income-plan/coinmate-bitcoin-purchase/${coinmateLedgerKey.current}`);
      }
      if (!trade.success || trade.btcBought <= 0) throw new Error(`Coinmate nákup skončil stavem ${trade.status}.`);

      const bitcoin = await apiRequest<BitcoinPurchaseOverview>("/api/bitcoin/overview");
      const coinmateAccount = bitcoin.accounts.find((account) => account.canManage && account.name.trim().toLocaleLowerCase("cs-CZ") === "coinmate");
      if (!coinmateAccount) throw new Error("BTC účet Coinmate nebyl nalezen.");
      const unitPriceCzk = amountCzk / trade.btcBought;
      const token = await antiforgeryToken();
      await apiRequest("/api/bitcoin/purchases", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token, "Idempotency-Key": coinmateLedgerKey.current },
        body: JSON.stringify({
          accountId: coinmateAccount.id,
          quantityBtc: trade.btcBought.toFixed(8),
          unitPriceCzk: unitPriceCzk.toFixed(2),
          acquiredAt: draftRef.current.acquiredAt,
          txid: null,
          note: "Automatický nákup z Income plánu",
        }),
      });
      return { ...trade, unitPriceCzk };
    },
    onSuccess: async (result) => {
      updateDraft({ purchaseResult: result });
      await queryClient.invalidateQueries({ queryKey: ["bitcoin"] });
    },
  });
  const startBtcPurchase = btcPurchase.mutate;
  const adjustmentKey = (operation: string) => {
    const saved = draftRef.current.paymentKeys[operation];
    if (saved) return saved;
    const key = createUuid();
    if (!updateDraft({ paymentKeys: { ...draftRef.current.paymentKeys, [operation]: key } })) throw new Error("Průběh splátky nelze uložit.");
    return key;
  };
  const recordDebtPayment = useMutation({
    mutationFn: async ({ debtId, amountCzk, deferredAmount, expectedDeferred }: { debtId: string; amountCzk: number; deferredAmount: number; expectedDeferred: number }) => {
      const token = await antiforgeryToken();
      let key = draftRef.current.paymentKeys[debtId];
      if (!key) {
        key = createUuid();
        if (!updateDraft({ paymentKeys: { ...draftRef.current.paymentKeys, [debtId]: key } })) throw new Error("Průběh splátky nelze uložit.");
      }
      await apiRequest(`/api/debts/${debtId}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token, "Idempotency-Key": key },
        body: JSON.stringify({ amountCzk: amountCzk.toFixed(2), effectiveAt: draftRef.current.effectiveAt, note: "Income plán · předčasná splátka" }),
      });
      const deferredToConsume = Math.min(expectedDeferred, deferredAmount);
      if (deferredToConsume > .005) {
        await apiRequest("/api/income-plan/deferred-debt-payment/consume", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token, "Idempotency-Key": adjustmentKey(`consume:${debtId}`) },
          body: JSON.stringify({ amountCzk: deferredToConsume.toFixed(2), expectedDeferredDebtPaymentCzk: expectedDeferred.toFixed(2) }),
        });
      }
      return { deferredConsumed: deferredToConsume, expectedDeferred };
    },
    onSuccess: async ({ deferredConsumed, expectedDeferred }, { debtId }) => {
      const nextDeferred = Math.max(0, expectedDeferred - deferredConsumed);
      const nextProcessedDebtIds = [...processedDebtIds, debtId];
      updateDraft({ localDeferredBalance: nextDeferred, processedDebtIds: nextProcessedDebtIds });
      const remainingIndices = debtPayments
        .map((payment, index) => nextProcessedDebtIds.includes(payment.debt.id) ? -1 : index)
        .filter((index) => index >= 0);
      if (remainingIndices.length === 0) {
        updateDraft({ debtStep: "complete", cashStep: allocation.cashAmount > .005 ? "active" : "complete" });
      } else {
        updateDraft({ debtIndex: remainingIndices.find((index) => index > debtIndex) ?? remainingIndices[0] });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["debts"] }),
        queryClient.invalidateQueries({ queryKey: ["income-plan"], refetchType: "none" }),
      ]);
    },
  });
  const deferRemainingDebts = useMutation({
    mutationFn: async ({ amountCzk, expectedDeferred }: { amountCzk: number; expectedDeferred: number }) => {
      const token = await antiforgeryToken();
      await apiRequest("/api/income-plan/deferred-debt-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token, "Idempotency-Key": adjustmentKey("defer") },
        body: JSON.stringify({ amountCzk: amountCzk.toFixed(2), expectedDeferredDebtPaymentCzk: expectedDeferred.toFixed(2) }),
      });
      return expectedDeferred + amountCzk;
    },
    onSuccess: async (nextDeferred) => {
      updateDraft({ localDeferredBalance: nextDeferred, debtIndex: debtPayments.length, debtStep: "complete", cashStep: allocation.cashAmount > .005 ? "active" : "complete" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["debts"] }),
        queryClient.invalidateQueries({ queryKey: ["income-plan"], refetchType: "none" }),
      ]);
    },
  });
  const currentDebtPayment = debtPayments[debtIndex];
  const remainingFreshDebtAmount = debtPayments
    .filter((payment) => !processedDebtIds.includes(payment.debt.id))
    .reduce((sum, payment) => sum + payment.freshAmount, 0);
  const debtPending = recordDebtPayment.isPending || deferRemainingDebts.isPending;
  const startAfterBtcSent = () => {
    if (draftRef.current.btcSent) return;
    if (!updateDraft({ processingOverview: initial, btcAmountToProcess: directBtcAmount,
      cashAmountToProcess: allocation.cashAmount, btcSent: true, debtPayments: candidateDebtPayments,
      processedDebtIds: [], debtIndex: 0, debtStep: candidateDebtPayments.length > 0 ? "active" : "complete",
      cashStep: candidateDebtPayments.length > 0 ? "idle" : allocation.cashAmount > .005 ? "active" : "complete" })) return;
    setBtcStep(directBtcAmount > .005 ? "closing" : "idle");
  };
  const startWithoutBtc = useEffectEvent(startAfterBtcSent);
  useEffect(() => {
    // Starting this run writes a durable snapshot, including the automatically skipped steps.
    // oxlint-disable-next-line react/set-state-in-effect
    if (processing && validAmount && amount > .005 && directBtcAmount <= .005 && (vwceAmount <= .005 || vwceDone) && !btcSent && !storageError) startWithoutBtc();
  }, [processing, validAmount, amount, directBtcAmount, vwceAmount, vwceDone, btcSent, storageError]);
  const deferRemaining = () => {
    if (debtPending) return;
    if (remainingFreshDebtAmount <= .005) {
      updateDraft({ debtIndex: debtPayments.length, debtStep: "complete", cashStep: allocation.cashAmount > .005 ? "active" : "complete" });
      return;
    }
    deferRemainingDebts.mutate({ amountCzk: remainingFreshDebtAmount, expectedDeferred: localDeferredBalance });
  };

  useEffect(() => {
    if ((balanceWatch.watch.phase !== "confirmed" && !draft.purchaseStarted) || btcAmountToProcess <= .005 || btcPurchaseStarted.current || draft.purchaseResult) return;
    btcPurchaseStarted.current = true;
    startBtcPurchase({ amountCzk: btcAmountToProcess });
  }, [balanceWatch.watch.phase, btcAmountToProcess, startBtcPurchase, draft.purchaseStarted, draft.purchaseResult]);

  const btcStatusPhase = btcPurchase.isError
    ? "error"
    : (btcPurchase.isSuccess || !!draft.purchaseResult)
      ? "confirmed"
      : btcPurchase.isPending
        ? "waiting"
        : balanceWatch.watch.phase;
  const btcStatusText = btcPurchase.isError
    ? "Nákup BTC se nepodařilo dokončit"
    : (btcPurchase.isSuccess || !!draft.purchaseResult)
      ? "BTC nakoupeno a zapsáno"
      : btcPurchase.isPending
        ? "Nakupuji BTC na Coinmate"
        : balanceWatch.watch.phase === "starting"
          ? "Připravuji sledování připsání CZK"
          : balanceWatch.watch.phase === "waiting"
            ? "Čekám na připsání CZK"
            : balanceWatch.watch.phase === "confirmed"
              ? "Připsání CZK potvrzeno"
              : "Kontrola připsání CZK selhala";

  const workflowSteps = [
    ...(vwceAmount > .005 ? [{ label: "VWCE", state: vwceDone ? "Vyčleněno" : "Vyčlenit částku", done: vwceDone }] : []),
    ...(directBtcAmount > .005 ? [{ label: "Bitcoin", state: (btcPurchase.isSuccess || !!draft.purchaseResult) ? "Hotovo" : btcStatusPhase === "error" ? "Vyžaduje pozornost" : btcPurchase.isPending ? "Probíhá nákup" : btcSent ? "Vklad odeslán" : "Odeslat vklad", done: (btcPurchase.isSuccess || !!draft.purchaseResult) }] : []),
    ...(candidateDebtPayments.length > 0 || debtPayments.length > 0 ? [{ label: "Splátky", state: debtStep === "complete" ? (processedDebtIds.length < debtPayments.length ? "Odloženo" : "Zapsáno") : debtStep === "active" ? `${processedDebtIds.length} / ${debtPayments.length} zapsáno` : "Čeká", done: debtStep === "complete" }] : []),
    ...(allocation.cashAmount > .005 ? [{ label: "Spending", state: cashStep === "complete" ? "Odeslání potvrzeno" : cashStep === "active" ? "Odeslat převod" : "Čeká", done: cashStep === "complete" }] : []),
  ];

  return <section className={`income-page${processing ? " income-page--processing" : ""}`}>
    {processing && <div className="income-workflow-header"><ol className="income-workflow-progress" aria-label="Průběh zpracování příjmu">{workflowSteps.map((step, index) => <li key={step.label} className={step.done ? "is-complete" : ""}><span className="income-workflow-number" aria-hidden="true">{step.done ? <Check size={16} /> : index + 1}</span><div><strong>{step.label}</strong><span>{step.state}</span></div></li>)}</ol><button className="income-cancel-processing" type="button" onClick={onCancel}><X size={15} />Zrušit zpracování</button></div>}
    {processing && btcSent && (vwceAmount <= .005 || vwceDone) && cashStep === "complete" && <div className="income-completion" role="status"><Check size={18} /><span>{directBtcAmount > .005 && !(btcPurchase.isSuccess || !!draft.purchaseResult) ? "Převody potvrzeny. Stav nákupu BTC sledujte v kartě Bitcoin." : "Zpracování příjmu dokončeno."}</span></div>}
    {processing && btcSent && cashStep === "complete" && (vwceAmount <= .005 || vwceDone) && <section className="income-run-summary" aria-label="Souhrn příjmu">
      <h2>Souhrn příjmu</h2><dl>
        {directBtcAmount > .005 && <div><dt>Bitcoin · {draft.purchaseResult ? "nakoupeno" : "čeká na dokončení"}</dt><dd>{czk.format(btcAmountToProcess)}</dd></div>}
        {vwceAmount > .005 && <div><dt>Vyčleněno na VWCE</dt><dd>{czk.format(vwceAmount)}</dd></div>}
        {debtPayments.some((payment) => processedDebtIds.includes(payment.debt.id)) && <div><dt>Zapsané splátky</dt><dd>{czk.format(debtPayments.filter((payment) => processedDebtIds.includes(payment.debt.id)).reduce((sum, payment) => sum + payment.amount, 0))}</dd></div>}
        {debtPayments.some((payment) => !processedDebtIds.includes(payment.debt.id)) && <div><dt>Odložené splátky</dt><dd>{czk.format(debtPayments.filter((payment) => !processedDebtIds.includes(payment.debt.id)).reduce((sum, payment) => sum + payment.amount, 0))}</dd></div>}
        {scheduledApplied > .005 && <div><dt>Ponecháno na pravidelné splátky</dt><dd>{czk.format(scheduledApplied)}</dd></div>}
        {allocation.cashAmount > .005 && <div><dt>Spending · odeslání potvrzeno</dt><dd>{czk.format(cashAmountToProcess ?? allocation.cashAmount)}</dd></div>}
      </dl><button className="income-debt-processed" type="button" disabled={directBtcAmount > .005 && !draft.purchaseResult} onClick={onNewRun}>Nový příjem</button>
    </section>}
    <div className="income-hero">
      <div className="income-capital">
        <div className="income-capital-main"><p>VOLNÝ KAPITÁL</p><label><input aria-label="Volný kapitál" inputMode="decimal" readOnly={btcSent || vwceDone} value={capital} placeholder="0" onChange={(event) => { if (!btcSent && !vwceDone) updateDraft({ capital: formatCzkInput(event.target.value) }); }} onBlur={() => !btcSent && !vwceDone && validAmount && saveCapital.mutate()} /><span>Kč</span></label></div>
        {deferredBalance > 0.01 && <div className="income-deferred-balance"><span>Odložené splátky</span><strong>{czk.format(deferredBalance)}</strong>{canManage && <button type="button" aria-label="Smazat odložené splátky" disabled={btcSent || vwceDone || deleteDeferred.isPending} onClick={() => deleteDeferred.mutate()}><Trash2 size={13} /></button>}</div>}
      </div>
      <div className="income-distribution" aria-label="Rozdělení příjmu">
        <span className="income-vault-feed" aria-hidden="true" />
        {rows.map((row, index) => {
          const btcHasVisibleStatus = btcSent && btcStatusPhase !== "idle" && btcStatusPhase !== "ready";
          const expanded = (processing && row.key === "vwce" && !vwceDone) || ((directBtcAmount > .005 && (vwceAmount <= .005 || vwceDone)) && (btcStep === "qr" || btcStep === "closing" || btcHasVisibleStatus) && row.key === "btc") || (debtStep === "active" && row.key === "debt") || (cashStep === "active" && row.key === "cash");
          return <div className={`income-distribution-row${index === 0 ? " first" : ""}${index === rows.length - 1 ? " last" : ""}${expanded ? " income-distribution-row--expanded" : ""}`} key={row.key}>
            <div className="income-vault-branch income-vault-branches" aria-hidden="true"><b>{row.percent} %</b></div>
            <article className={`income-flow-row income-flow-row--${row.tone}${expanded ? " income-flow-row--expanded" : ""}`} data-expanded={expanded ? "true" : "false"}>
              <div className="income-flow-icon"><row.icon size={17} /></div>
              <div className="income-envelope-copy"><strong>{row.label}</strong>{row.key === "debt" && scheduledDebtPayment > 0 ? <div className="income-debt-split"><span><em>Pravidelné splátky</em><b>{validAmount ? czk.format(scheduledApplied) : "—"}</b></span><span><em>Předčasné splátky</em><b>{validAmount ? czk.format(debtBudget) : "—"}</b></span></div> : <span>{row.note}</span>}</div>
              <div className="income-envelope-value"><output>{validAmount ? czk.format(row.amount) : "—"}</output><b>{row.percent} %</b></div>
              {row.key === "btc" && directBtcAmount > .005 && (vwceAmount <= .005 || vwceDone) && (btcStep === "qr" || btcStep === "closing") && <CoinmatePaymentQr amountCzk={row.amount} settings={settings} closing={btcStep === "closing"} watchStarting={balanceWatch.watch.phase === "starting"} onSent={startAfterBtcSent} onClosed={() => setBtcStep("waiting")} />}
              {row.key === "btc" && processing && btcSent && directBtcAmount > .005 && btcStatusPhase !== "idle" && btcStatusPhase !== "ready" && <div className={`income-btc-watch income-btc-watch--${btcStatusPhase}`} role="status">
                <span>{btcStatusText}</span>
                {balanceWatch.watch.phase === "error" && <button type="button" onClick={balanceWatch.retry}>Zkusit znovu</button>}
                {btcPurchase.isError && <button type="button" onClick={() => btcPurchase.mutate({ amountCzk: btcAmountToProcess })}>Zkusit znovu</button>}
              </div>}
              {row.key === "debt" && debtStep === "active" && currentDebtPayment && <div className="income-debt-workflow">
                <div className="income-debt-current">
                  <strong>{currentDebtPayment.debt.name}</strong><output><b>{czk.format(currentDebtPayment.amount)}</b><span>/ {czk.format(currentDebtPayment.debt.balanceCzk)}</span></output>
                </div>
                <b className="income-debt-progress">{debtIndex + 1}/{debtPayments.length}</b>
                <div className="income-debt-workflow-actions"><button className="income-debt-processed" type="button" disabled={debtPending} onClick={() => recordDebtPayment.mutate({ debtId: currentDebtPayment.debt.id, amountCzk: currentDebtPayment.amount, deferredAmount: currentDebtPayment.deferredAmount, expectedDeferred: localDeferredBalance })}>{recordDebtPayment.isPending ? "Zapisuji…" : "Zapsat uhrazenou splátku"}</button><button className="income-debt-defer" type="button" disabled={debtPending} onClick={deferRemaining}>{deferRemainingDebts.isPending ? "Odkládám…" : "Odložit zbývající splátky"}</button></div>
                  {(recordDebtPayment.error || deferRemainingDebts.error) && <p className="income-workflow-error" role="alert">{recordDebtPayment.error?.message ?? deferRemainingDebts.error?.message}</p>}
              </div>}
              {row.key === "vwce" && processing && !vwceDone && <div className="income-cash-processing"><strong>Vyčlenit na nákup VWCE</strong><button className="income-debt-processed" type="button" onClick={() => updateDraft({ processingOverview: initial, vwceDone: true })}>Částka vyčleněna</button><span>Nákup a čerpání poolu zapište v tabu VWCE.</span></div>}
              {row.key === "cash" && allocation.cashAmount > .005 && cashStep === "active" && <CashPaymentQr amountCzk={row.amount} iban={settings.cashAccountIban} onComplete={() => updateDraft({ cashStep: "complete" })} />}
            </article>
          </div>;
        })}
      </div>
    </div>

    {hasDebts && <section className="income-debts" aria-labelledby="income-debts-title">
      <div className="income-debt-panel">
        <header className="income-section-heading">
          <div className="income-debt-heading-copy"><span className="income-debt-heading-icon"><Landmark size={18} /></span><div><p>PLÁN SPLÁTEK</p><h2 id="income-debts-title">Rozdělení podle priorit</h2><span>Splátky se rozdělují poměrně podle priorit.</span></div></div>
          <div className="income-debt-budget"><span>PŘEDČASNĚ</span><strong>{czk.format(debtBudget)}</strong><small>{eligibleDebtCount} {eligibleDebtCount === 1 ? "aktivní dluh" : eligibleDebtCount < 5 ? "aktivní dluhy" : "aktivních dluhů"}</small></div>
        </header>
        <div className="income-debt-list">{initial.debts.map((debt) => {
          const payment = allocations.get(debt.id) ?? 0;
          const coverage = debt.balanceCzk > 0 ? Math.min(100, payment / debt.balanceCzk * 100) : 0;
          return <article className={`income-debt-row${debt.priority === 0 ? " income-debt-row--excluded" : ""}`} key={debt.id}>
            <div className="income-debt-priority" aria-label={debt.priority === 0 ? "Mimo automatický plán" : `Priorita ${debt.priority} z 5`}><b>{debt.priority || "—"}</b><span>{debt.priority === 0 ? "MIMO" : "PRIORITA"}</span></div>
            <div className="income-debt-row-copy"><strong>{debt.name}</strong>{debt.priority === 0 && <em>Mimo automatický plán</em>}<span>Zůstatek {czk.format(debt.balanceCzk)}</span></div>
            <div className="income-debt-coverage"><div><span>Zůstatek po splátce</span><b>{czk.format(Math.max(0, debt.balanceCzk - payment))}</b></div><div className="income-debt-bar" aria-hidden="true"><span style={{ width: `${coverage}%` }} /></div></div>
            <div className="income-debt-row-value"><span>Nyní splatit</span><output>{payment > .005 ? czk.format(payment) : "—"}</output></div>
          </article>;
        })}</div>
        {debtBudget > allocatedDebt + 0.01 && <p className="income-remainder"><CircleDollarSign size={15} /><span>Po doplacení způsobilých dluhů zůstává k přerozdělení</span><strong>{czk.format(debtBudget - allocatedDebt)}</strong></p>}
      </div>
    </section>}
    {storageError && <p className="income-error" role="alert">{storageError}</p>}
    {(saveCapital.error || deleteDeferred.error) && <p className="income-error" role="alert">{saveCapital.error?.message ?? deleteDeferred.error?.message}</p>}
    <div className="income-footnote"><Banknote size={14} /><span>Hypotéky a dluhy s prioritou 0 jsou mimo plán předčasného splácení.</span></div>
  </section>;
}
