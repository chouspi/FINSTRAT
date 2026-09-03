import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import QRCode from "qrcode";
import {
  Banknote,
  Bitcoin,
  Check,
  CircleDollarSign,
  Landmark,
  Trash2,
  Wallet,
} from "lucide-react";
import { antiforgeryToken, apiRequest } from "../lib/api";
import { todayIsoDate } from "../lib/date";
import {
  allocateDebtBudget,
  calculateIncomeAllocation,
  createCashPaymentPayload,
  createCoinmatePaymentPayload,
  formatCzkInput,
  parseCzkInput,
  redirectBtcToDeferredVwce,
} from "../lib/incomePlan";
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
type CurrentUser = { isDefault: boolean };
type BalanceWatch = { watchId: string; currency: "czk"; initialBalance: number; expiresInSeconds: number };
type BalanceWatchResult = { changed: boolean; currency: "czk"; balance: number };
type WatchState = { watchId: string; phase: "idle" | "starting" | "ready" | "waiting" | "confirmed" | "error"; error: string };
type DebtPaymentPlan = { debt: PlanDebt; amount: number; freshAmount: number; deferredAmount: number };
type CoinmatePurchaseResult = { success: boolean; btcBought: number; status: string; pending: boolean };
type BitcoinPurchaseOverview = { accounts: { id: string; name: string; canManage: boolean }[] };

const czk = new Intl.NumberFormat("cs-CZ", {
  style: "currency",
  currency: "CZK",
  maximumFractionDigits: 0,
});

export function IncomePlanPage() {
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
  if (overview.isPending) return <section className="income-page"><div className="income-loading" /></section>;
  if (overview.isError) return <section className="income-page income-state"><CircleDollarSign size={28} /><h2>Income plan se nepodařilo načíst</h2><button type="button" onClick={() => overview.refetch()}>Zkusit znovu</button></section>;
  const canManage = identity.data?.isDefault === false;
  const processing = dialog === "process" && canManage;
  return <IncomePlanContent key={processing ? "processing" : "idle"} initial={overview.data} canManage={canManage} processing={processing} />;
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
      payloadError = error instanceof Error ? error.message : "Cash QR nelze vytvořit.";
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
        if (active) setQrError("Cash QR se nepodařilo vytvořit.");
      });
    return () => { active = false; };
  }, [payload]);

  const qrUrl = qr.payload === payload ? qr.url : "";
  return <div className="income-cash-processing">
    <strong>Převod do Cash rezervy</strong>
    <div className="income-cash-qr">
      {qrUrl ? <img src={qrUrl} alt={`Cash QR pro převod ${czk.format(amountCzk)}`} /> : <div className="income-cash-qr-state" role="status">{payloadError || qrError || "Cash QR není dostupné. Zkontrolujte IBAN v Nastavení."}</div>}
      <button type="button" onClick={onComplete}><Check size={14} />Dokončit</button>
    </div>
  </div>;
}

function useCoinmateBalanceWatch(active: boolean, waiting: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [watch, setWatch] = useState<WatchState>(() => active
    ? { watchId: "", phase: "starting", error: "" }
    : { watchId: "", phase: "idle", error: "" });

  useEffect(() => {
    if (!active) return;
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
  }, [active, attempt]);

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
    if (!active || !watch.watchId) return;
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
  }, [active, watch.watchId]);

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

function IncomePlanContent({ initial, canManage, processing }: { initial: Overview; canManage: boolean; processing: boolean }) {
  const queryClient = useQueryClient();
  const [btcStep, setBtcStep] = useState<"idle" | "qr" | "closing" | "waiting">(processing ? "qr" : "idle");
  const [btcSent, setBtcSent] = useState(false);
  const [btcAmountToProcess, setBtcAmountToProcess] = useState(0);
  const [cashAmountToProcess, setCashAmountToProcess] = useState<number | null>(null);
  const [debtStep, setDebtStep] = useState<"idle" | "active" | "complete">("idle");
  const [debtIndex, setDebtIndex] = useState(0);
  const [debtPayments, setDebtPayments] = useState<DebtPaymentPlan[]>([]);
  const [processedDebtIds, setProcessedDebtIds] = useState<string[]>([]);
  const [cashStep, setCashStep] = useState<"idle" | "active" | "complete">("idle");
  const [localDeferredBalance, setLocalDeferredBalance] = useState(initial.settings.deferredDebtPaymentCzk ?? 0);
  const [capital, setCapital] = useState(formatCzkInput(String(initial.settings.defaultCapitalCzk || "")));
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
    { key: "cash", label: "Cash", note: "likvidní rezerva", percent: validAmount && amount > 0 ? Math.round((cashAmountToProcess ?? allocation.cashAmount) / amount * 1000) / 10 : percentages.cash, amount: cashAmountToProcess ?? allocation.cashAmount, icon: Wallet, tone: "green" },
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
  const balanceWatch = useCoinmateBalanceWatch(processing && directBtcAmount > .005, btcSent);
  const paymentKeys = useRef(new Map<string, string>());
  const coinmateLedgerKey = useRef(createUuid());
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
          acquiredAt: new Date().toISOString(),
          txid: null,
          note: "Automatický nákup z Income plánu",
        }),
      });
      return { ...trade, unitPriceCzk };
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["bitcoin"] });
    },
  });
  const startBtcPurchase = btcPurchase.mutate;
  const recordDebtPayment = useMutation({
    mutationFn: async ({ debtId, amountCzk, deferredAmount, expectedDeferred }: { debtId: string; amountCzk: number; deferredAmount: number; expectedDeferred: number }) => {
      const token = await antiforgeryToken();
      let key = paymentKeys.current.get(debtId);
      if (!key) {
        key = createUuid();
        paymentKeys.current.set(debtId, key);
      }
      await apiRequest(`/api/debts/${debtId}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token, "Idempotency-Key": key },
        body: JSON.stringify({ amountCzk: amountCzk.toFixed(2), effectiveAt: todayIsoDate(), note: "Income plán · předčasná splátka" }),
      });
      const deferredToConsume = Math.min(expectedDeferred, deferredAmount);
      if (deferredToConsume > .005) {
        await apiRequest("/api/income-plan/deferred-debt-payment/consume", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token },
          body: JSON.stringify({ amountCzk: deferredToConsume.toFixed(2), expectedDeferredDebtPaymentCzk: expectedDeferred.toFixed(2) }),
        });
      }
      return { deferredConsumed: deferredToConsume, expectedDeferred };
    },
    onSuccess: async ({ deferredConsumed, expectedDeferred }, { debtId }) => {
      const nextDeferred = Math.max(0, expectedDeferred - deferredConsumed);
      const nextProcessedDebtIds = [...processedDebtIds, debtId];
      setLocalDeferredBalance(nextDeferred);
      setProcessedDebtIds(nextProcessedDebtIds);
      const remainingIndices = debtPayments
        .map((payment, index) => nextProcessedDebtIds.includes(payment.debt.id) ? -1 : index)
        .filter((index) => index >= 0);
      if (remainingIndices.length === 0) {
        setDebtStep("complete");
        setCashStep("active");
      } else {
        setDebtIndex(remainingIndices.find((index) => index > debtIndex) ?? remainingIndices[0]);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["debts"] }),
        queryClient.invalidateQueries({ queryKey: ["income-plan"] }),
      ]);
    },
  });
  const deferRemainingDebts = useMutation({
    mutationFn: async ({ amountCzk, expectedDeferred }: { amountCzk: number; expectedDeferred: number }) => {
      const token = await antiforgeryToken();
      await apiRequest("/api/income-plan/deferred-debt-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token },
        body: JSON.stringify({ amountCzk: amountCzk.toFixed(2), expectedDeferredDebtPaymentCzk: expectedDeferred.toFixed(2) }),
      });
      return expectedDeferred + amountCzk;
    },
    onSuccess: async (nextDeferred) => {
      setLocalDeferredBalance(nextDeferred);
      setDebtIndex(debtPayments.length);
      setDebtStep("complete");
      setCashStep("active");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["debts"] }),
        queryClient.invalidateQueries({ queryKey: ["income-plan"] }),
      ]);
    },
  });
  const compactRowHeight = Math.max(96, (330 - (rows.length - 1) * 10) / rows.length);
  const currentDebtPayment = debtPayments[debtIndex];
  const remainingFreshDebtAmount = debtPayments
    .filter((payment) => !processedDebtIds.includes(payment.debt.id))
    .reduce((sum, payment) => sum + payment.freshAmount, 0);
  const debtPending = recordDebtPayment.isPending || deferRemainingDebts.isPending;
  const startAfterBtcSent = () => {
    setBtcAmountToProcess(directBtcAmount);
    setCashAmountToProcess(allocation.cashAmount);
    setBtcSent(true);
    setBtcStep("closing");
    if (candidateDebtPayments.length > 0) {
      setDebtPayments(candidateDebtPayments);
      setProcessedDebtIds([]);
      setDebtIndex(0);
      setDebtStep("active");
    } else {
      setDebtStep("complete");
      setCashStep("active");
    }
  };
  const deferRemaining = () => {
    if (debtPending) return;
    if (remainingFreshDebtAmount <= .005) {
      setDebtIndex(debtPayments.length);
      setDebtStep("complete");
      setCashStep("active");
      return;
    }
    deferRemainingDebts.mutate({ amountCzk: remainingFreshDebtAmount, expectedDeferred: localDeferredBalance });
  };

  useEffect(() => {
    if (balanceWatch.watch.phase !== "confirmed" || btcAmountToProcess <= .005 || btcPurchaseStarted.current) return;
    btcPurchaseStarted.current = true;
    startBtcPurchase({ amountCzk: btcAmountToProcess });
  }, [balanceWatch.watch.phase, btcAmountToProcess, startBtcPurchase]);

  const btcStatusPhase = btcPurchase.isError
    ? "error"
    : btcPurchase.isSuccess
      ? "confirmed"
      : btcPurchase.isPending
        ? "waiting"
        : balanceWatch.watch.phase;
  const btcStatusText = btcPurchase.isError
    ? "Nákup BTC se nepodařilo dokončit"
    : btcPurchase.isSuccess
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

  return <section className={`income-page${processing ? " income-page--processing" : ""}`}>
    <div className="income-hero">
      <div className="income-capital">
        <div className="income-capital-main"><p>VOLNÝ KAPITÁL</p><label><input aria-label="Volný kapitál" inputMode="decimal" value={capital} placeholder="0" onChange={(event) => setCapital(formatCzkInput(event.target.value))} onBlur={() => validAmount && saveCapital.mutate()} /><span>Kč</span></label></div>
        {deferredBalance > 0.01 && <div className="income-deferred-balance"><span>Odložené splátky</span><strong>{czk.format(deferredBalance)}</strong>{canManage && <button type="button" aria-label="Smazat odložené splátky" disabled={deleteDeferred.isPending} onClick={() => deleteDeferred.mutate()}><Trash2 size={13} /></button>}</div>}
      </div>
      <div className="income-distribution" style={{ "--income-compact-row-height": `${compactRowHeight}px` } as CSSProperties} aria-label="Rozdělení příjmu">
        <span className="income-vault-feed" aria-hidden="true" />
        {rows.map((row, index) => {
          const btcHasVisibleStatus = btcSent && btcStatusPhase !== "idle" && btcStatusPhase !== "ready";
          const expanded = ((btcStep === "qr" || btcStep === "closing" || btcHasVisibleStatus) && row.key === "btc") || (debtStep === "active" && row.key === "debt") || (cashStep === "active" && row.key === "cash");
          return <div className={`income-distribution-row${index === 0 ? " first" : ""}${index === rows.length - 1 ? " last" : ""}${expanded ? " income-distribution-row--expanded" : ""}`} key={row.key}>
            <div className="income-vault-branch income-vault-branches" aria-hidden="true"><b>{row.percent} %</b></div>
            <article className={`income-flow-row income-flow-row--${row.tone}${expanded ? " income-flow-row--expanded" : ""}`} data-expanded={expanded ? "true" : "false"}>
              <div className="income-flow-icon"><row.icon size={17} /></div>
              <div className="income-envelope-copy"><strong>{row.label}</strong>{row.key === "debt" && scheduledDebtPayment > 0 ? <div className="income-debt-split"><span><em>Pravidelné splátky</em><b>{validAmount ? czk.format(scheduledApplied) : "—"}</b></span><span><em>Předčasné splátky</em><b>{validAmount ? czk.format(debtBudget) : "—"}</b></span></div> : <span>{row.note}</span>}</div>
              <div className="income-envelope-value"><output>{validAmount ? czk.format(row.amount) : "—"}</output><b>{row.percent} %</b></div>
              {row.key === "btc" && (btcStep === "qr" || btcStep === "closing") && <CoinmatePaymentQr amountCzk={row.amount} settings={settings} closing={btcStep === "closing"} watchStarting={balanceWatch.watch.phase === "starting"} onSent={startAfterBtcSent} onClosed={() => setBtcStep("waiting")} />}
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
                <div className="income-debt-workflow-actions"><button className="income-debt-processed" type="button" disabled={debtPending} onClick={() => recordDebtPayment.mutate({ debtId: currentDebtPayment.debt.id, amountCzk: currentDebtPayment.amount, deferredAmount: currentDebtPayment.deferredAmount, expectedDeferred: localDeferredBalance })}>{recordDebtPayment.isPending ? "Zapisuji…" : "Zpracovat"}</button><button className="income-debt-defer" type="button" disabled={debtPending} onClick={deferRemaining}>{deferRemainingDebts.isPending ? "Odkládám…" : "Odložit zbývající splátky"}</button></div>
                  {(recordDebtPayment.error || deferRemainingDebts.error) && <p className="income-workflow-error" role="alert">{recordDebtPayment.error?.message ?? deferRemainingDebts.error?.message}</p>}
              </div>}
              {row.key === "cash" && cashStep === "active" && <CashPaymentQr amountCzk={row.amount} iban={settings.cashAccountIban} onComplete={() => setCashStep("complete")} />}
            </article>
          </div>;
        })}
      </div>
    </div>

    {hasDebts && <section className="income-debts" aria-labelledby="income-debts-title">
      <div className="income-debt-panel">
        <header className="income-section-heading">
          <div className="income-debt-heading-copy"><span className="income-debt-heading-icon"><Landmark size={18} /></span><div><p>PLÁN SPLÁTEK</p><h2 id="income-debts-title">Rozdělení podle priorit</h2><span>Volný kapitál míří nejdřív na nejvýše hodnocené závazky.</span></div></div>
          <div className="income-debt-budget"><span>PŘEDČASNĚ</span><strong>{czk.format(debtBudget)}</strong><small>{eligibleDebtCount} {eligibleDebtCount === 1 ? "aktivní dluh" : eligibleDebtCount < 5 ? "aktivní dluhy" : "aktivních dluhů"}</small></div>
        </header>
        <div className="income-debt-list">{initial.debts.map((debt) => {
          const payment = allocations.get(debt.id) ?? 0;
          const coverage = debt.balanceCzk > 0 ? Math.min(100, payment / debt.balanceCzk * 100) : 0;
          return <article className={`income-debt-row${debt.priority === 0 ? " income-debt-row--excluded" : ""}`} key={debt.id}>
            <div className="income-debt-priority" aria-label={debt.priority === 0 ? "Mimo automatický plán" : `Priorita ${debt.priority} z 5`}><b>{debt.priority || "—"}</b><span>{debt.priority === 0 ? "MIMO" : "PRIORITA"}</span></div>
            <div className="income-debt-row-copy"><strong>{debt.name}</strong>{debt.priority === 0 && <em>Mimo automatický plán</em>}<span>Zůstatek {czk.format(debt.balanceCzk)}</span></div>
            <div className="income-debt-coverage"><div><span>Pokrytí plánem</span><b>{payment > .005 ? `${Math.round(coverage)} %` : "—"}</b></div><div className="income-debt-bar" aria-hidden="true"><span style={{ width: `${coverage}%` }} /></div></div>
            <div className="income-debt-row-value"><span>PLÁNOVÁNO</span><output>{payment > .005 ? czk.format(payment) : "—"}</output></div>
          </article>;
        })}</div>
        {debtBudget > allocatedDebt + 0.01 && <p className="income-remainder"><CircleDollarSign size={15} /><span>Po doplacení způsobilých dluhů zůstává k přerozdělení</span><strong>{czk.format(debtBudget - allocatedDebt)}</strong></p>}
      </div>
    </section>}
    {(saveCapital.error || deleteDeferred.error) && <p className="income-error" role="alert">{saveCapital.error?.message ?? deleteDeferred.error?.message}</p>}
    <div className="income-footnote"><Banknote size={14} /><span>Hypotéky a dluhy s prioritou 0 jsou mimo plán předčasného splácení.</span></div>
  </section>;
}
