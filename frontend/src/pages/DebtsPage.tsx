import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  Archive,
  Banknote,
  CalendarClock,
  Check,
  ChevronDown,
  CircleDollarSign,
  Home,
  Pencil,
  Plus,
  ReceiptText,
  ShieldCheck,
  Trash2,
  WalletCards,
  X,
} from "lucide-react";
import { antiforgeryToken, apiRequest } from "../lib/api";
import { createUuid } from "../lib/uuid";
import { formatCzechDate, parseCzechDate, todayIsoDate } from "../lib/date";
import { notifyDataChanged } from "../lib/dataRefresh";
import "./DebtsPage.css";
import "./DebtPaymentFixes.css";

const parseDebtAmount = (value: string) => Number(value.replace(/\s/g, "").replace(",", "."));
const debtAmountForApi = (value: string) => value.replace(/\s/g, "").replace(",", ".");

type DebtOverview = {
  totals: DebtTotals;
  debts: Debt[];
  recentEntries: DebtEntry[];
  scheduledPayments?: DebtEntry[];
};
type DebtTotals = {
  activeBalanceCzk: number;
  repayableBalanceCzk: number;
  mortgageBalanceCzk: number;
  activeCount: number;
  closedCount: number;
};
type Debt = {
  id: string;
  name: string;
  priority: number;
  isMortgage: boolean;
  openedAt: string;
  closedAt: string | null;
  note: string | null;
  balanceCzk: number;
  scheduledPaymentCzk: number;
  entryCount: number;
  latestActivityAt: string | null;
};
type DebtEntry = {
  id: string;
  debtId: string;
  debtName: string;
  type: string;
  amountCzk: number;
  effectiveAt: string;
  isScheduled?: boolean;
  isDue?: boolean;
  note: string | null;
};
type ConfirmedScheduledPayment = {
  debtId: string;
  debtName: string;
  amountCzk: number;
  effectiveAt: string;
  nextEffectiveAt: string;
  note: string | null;
};

const czk = new Intl.NumberFormat("cs-CZ", {
  style: "currency",
  currency: "CZK",
  maximumFractionDigits: 0,
});
const date = new Intl.DateTimeFormat("cs-CZ", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export function DebtsPage() {
  const navigate = useNavigate();
  const { dialog } = useSearch({ from: "/debts" });
  const [paymentDebt, setPaymentDebt] = useState<Debt | null>(null);
  const [drawdownDebt, setDrawdownDebt] = useState<Debt | null>(null);
  const [editingDebt, setEditingDebt] = useState<Debt | null>(null);
  const [renewalOffer, setRenewalOffer] = useState<
    ConfirmedScheduledPayment[] | null
  >(null);
  const overview = useQuery({
    queryKey: ["debts", "overview"],
    queryFn: () => apiRequest<DebtOverview>("/api/debts/overview"),
    retry: false,
  });
  const closeRouteDialog = () =>
    void navigate({
      to: "/debts",
      search: { dialog: undefined },
      replace: true,
    });
  if (overview.isPending)
    return (
      <section className="debts-page">
        <div className="debt-summary debt-summary--loading">
          {[0, 1, 2, 3].map((item) => (
            <div key={item} />
          ))}
        </div>
      </section>
    );
  if (overview.isError)
    return (
      <section className="debts-page debt-state">
        <WalletCards size={28} />
        <h2>Dluhy se nepodařilo načíst</h2>
        <button type="button" onClick={() => overview.refetch()}>
          Zkusit znovu
        </button>
      </section>
    );
  const data = overview.data;
  const active = data.debts.filter(
    (debt) => !debt.closedAt && debt.balanceCzk > 0,
  );
  const closed = data.debts.filter(
    (debt) => debt.closedAt || debt.balanceCzk === 0,
  );
  const scheduledPayments = data.scheduledPayments ?? [];
  const duePayments = scheduledPayments.filter((payment) => payment.isDue);
  return (
    <section className="debts-page">
      <div className="debt-summary" aria-label="Souhrn dluhů">
        <DebtMetric
          label="Celkový dluh"
          value={czk.format(data.totals.activeBalanceCzk)}
          strong
        />
        <DebtMetric
          label="Ke splacení"
          value={czk.format(data.totals.repayableBalanceCzk)}
          note="mimo hypotéku"
          tone={data.totals.repayableBalanceCzk > 0 ? "danger" : undefined}
        />
        <DebtMetric
          label="Hypotéky"
          value={czk.format(data.totals.mortgageBalanceCzk)}
          note="pravidelné splácení"
        />
        <DebtMetric
          label="Smlouvy"
          value={String(data.totals.activeCount)}
          note={`${data.totals.closedCount} splacených`}
        />
      </div>
      {duePayments.length > 0 && (
        <DuePaymentsBar payments={duePayments} onConfirmed={setRenewalOffer} />
      )}
      {active.length === 0 && closed.length === 0 ? (
        <div className="debt-empty">
          <div>
            <ShieldCheck size={25} />
          </div>
          <h2>Žádné evidované dluhy</h2>
          <p>
            Portfolio je bez závazků. Nový dluh můžete přidat tlačítkem vpravo
            nahoře.
          </p>
        </div>
      ) : (
        <>
          {active.length > 0 && (
            <>
              <div className="debt-section-title">AKTIVNÍ ZÁVAZKY</div>
              <div className="debt-list">
                {active.map((debt) => (
                  <DebtRow
                    key={debt.id}
                    debt={debt}
                    onPay={() => setPaymentDebt(debt)}
                    onDraw={() => setDrawdownDebt(debt)}
                    onEdit={() => setEditingDebt(debt)}
                  />
                ))}
              </div>
            </>
          )}
          {scheduledPayments.length > 0 && (
            <ScheduledPaymentsList
              payments={scheduledPayments}
              onConfirmed={setRenewalOffer}
            />
          )}
          {closed.length > 0 && (
            <>
              <div className="debt-section-title debt-closed-title">
                SPLACENO
              </div>
              <div className="debt-list debt-list--closed">
                {closed.map((debt) => (
                  <DebtRow
                    key={debt.id}
                    debt={debt}
                    onPay={() => setPaymentDebt(debt)}
                    onDraw={() => setDrawdownDebt(debt)}
                    onEdit={() => setEditingDebt(debt)}
                  />
                ))}
              </div>
            </>
          )}
          <div className="debt-section-title debt-history-title">
            POSLEDNÍ POHYBY
          </div>
          <DebtEntries entries={data.recentEntries} />
        </>
      )}
      {dialog === "debt" && <DebtFormDialog onClose={closeRouteDialog} />}
      {dialog === "payment" && (
        <PaymentDialog debts={active} onClose={closeRouteDialog} />
      )}
      {dialog === "manage" && (
        <DebtManagementDialog
          debts={data.debts}
          onClose={closeRouteDialog}
          onEdit={(debt) => {
            closeRouteDialog();
            setEditingDebt(debt);
          }}
        />
      )}
      {paymentDebt && (
        <PaymentDialog
          debts={active}
          initialDebt={paymentDebt}
          onClose={() => setPaymentDebt(null)}
        />
      )}
      {drawdownDebt && (
        <DrawdownDialog
          debt={drawdownDebt}
          onClose={() => setDrawdownDebt(null)}
        />
      )}
      {editingDebt && (
        <DebtFormDialog
          debt={editingDebt}
          onClose={() => setEditingDebt(null)}
        />
      )}
      {renewalOffer && (
        <RenewScheduledPaymentsDialog
          payments={renewalOffer}
          onClose={() => setRenewalOffer(null)}
        />
      )}
    </section>
  );
}

function ScheduledPaymentsList({
  payments,
  onConfirmed,
}: {
  payments: DebtEntry[];
  onConfirmed: (payments: ConfirmedScheduledPayment[]) => void;
}) {
  return (
    <>
      <div className="debt-section-title scheduled-payments-title">
        PLÁNOVANÉ SPLÁTKY
      </div>
      <div className="scheduled-payments-list">
        {payments.map((payment) => (
          <ScheduledPaymentRow
            payment={payment}
            onConfirmed={onConfirmed}
            key={payment.id}
          />
        ))}
      </div>
    </>
  );
}

function ScheduledPaymentRow({
  payment,
  onConfirmed,
}: {
  payment: DebtEntry;
  onConfirmed: (payments: ConfirmedScheduledPayment[]) => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const confirm = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken();
      return apiRequest<{ payments: ConfirmedScheduledPayment[] }>(
        `/api/debts/scheduled-payments/${payment.id}/confirm`,
        { method: "POST", headers: { "X-CSRF-TOKEN": token } },
      );
    },
    onSuccess: async (result) => {
      setConfirming(false);
      onConfirmed(result.payments);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["debts"] }),
        queryClient.invalidateQueries({ queryKey: ["income-plan"] }),
      ]);
      notifyDataChanged();
    },
  });
  const remove = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken();
      await apiRequest(`/api/debts/${payment.debtId}/payments/${payment.id}`, {
        method: "DELETE",
        headers: { "X-CSRF-TOKEN": token },
      });
    },
    onSuccess: async () => {
      setDeleteConfirming(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["debts"] }),
        queryClient.invalidateQueries({ queryKey: ["income-plan"] }),
      ]);
      notifyDataChanged();
    },
  });
  return (
    <div className={`scheduled-payment-row${payment.isDue ? " due" : ""}`}>
      <span>
        <CalendarClock size={16} />
      </span>
      <div>
        <strong>{payment.debtName}</strong>
        <small>
          {payment.isDue ? "Splatná" : "Splatnost"}{" "}
          {date.format(new Date(`${payment.effectiveAt}T12:00:00`))}
          {payment.note ? ` · ${payment.note}` : ""}
        </small>
      </div>
      <strong>{czk.format(payment.amountCzk)}</strong>
      <div className="scheduled-payment-actions">
        <button type="button" disabled={confirm.isPending || remove.isPending} onClick={() => setConfirming(true)}>Splatit</button>
        <button className="scheduled-payment-delete" type="button" aria-label={`Smazat plánovanou splátku ${payment.debtName}`} disabled={confirm.isPending || remove.isPending} onClick={() => setDeleteConfirming(true)}><Trash2 size={14} /></button>
      </div>
      {(confirm.error || remove.error) && (
        <p className="form-error" role="alert">
          {confirm.error?.message ?? remove.error?.message}
        </p>
      )}
      {confirming && <DebtDialog title="Potvrdit plánovanou splátku?" kicker="SKUTEČNÉ SNÍŽENÍ DLUHU" onClose={() => setConfirming(false)}><p>Potvrzením se {czk.format(payment.amountCzk)} odečte ze zůstatku dluhu {payment.debtName}.</p><div className="debt-dialog-actions"><button type="button" onClick={() => setConfirming(false)}>Zrušit</button><button className="pay" type="button" disabled={confirm.isPending} onClick={() => confirm.mutate()}>{confirm.isPending ? "Potvrzuji…" : "Ano, splatit"}</button></div></DebtDialog>}
      {deleteConfirming && <DebtDialog title="Smazat plánovanou splátku?" kicker="ZRUŠENÍ REZERVACE" onClose={() => setDeleteConfirming(false)}><p>Budoucí splátka {czk.format(payment.amountCzk)} se zruší a dluh se nezmění.</p><div className="debt-dialog-actions"><button type="button" onClick={() => setDeleteConfirming(false)}>Zpět</button><button className="account-delete-confirm" type="button" disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? "Mažu…" : "Smazat plánovanou splátku"}</button></div></DebtDialog>}
    </div>
  );
}

function DuePaymentsBar({
  payments,
  onConfirmed,
}: {
  payments: DebtEntry[];
  onConfirmed: (payments: ConfirmedScheduledPayment[]) => void;
}) {
  const queryClient = useQueryClient();
  const amount = payments.reduce((sum, payment) => sum + payment.amountCzk, 0);
  const confirm = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken();
      return apiRequest<{ payments: ConfirmedScheduledPayment[] }>(
        "/api/debts/scheduled-payments/due/confirm",
        { method: "POST", headers: { "X-CSRF-TOKEN": token } },
      );
    },
    onSuccess: async (result) => {
      onConfirmed(result.payments);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["debts"] }),
        queryClient.invalidateQueries({ queryKey: ["income-plan"] }),
      ]);
      notifyDataChanged();
    },
  });
  return (
    <div className="due-payments-bar">
      <div>
        <Banknote size={18} />
        <span>
          <strong>
            {payments.length === 1
              ? "Plánovaná splátka je splatná"
              : `${payments.length} plánované splátky jsou splatné`}
          </strong>
          <small>
            {payments.map((payment) => payment.debtName).join(", ")} ·{" "}
            {czk.format(amount)}
          </small>
        </span>
      </div>
      <button
        type="button"
        disabled={confirm.isPending}
        onClick={() => confirm.mutate()}
      >
        {confirm.isPending
          ? "Potvrzuji…"
          : `Splatit plánované splátky (${czk.format(amount)})`}
      </button>
      {confirm.error && (
        <p className="form-error" role="alert">
          {confirm.error.message}
        </p>
      )}
    </div>
  );
}

function RenewScheduledPaymentsDialog({
  payments,
  onClose,
}: {
  payments: ConfirmedScheduledPayment[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const schedule = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken();
      for (const payment of payments) {
        await apiRequest(`/api/debts/${payment.debtId}/payments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-TOKEN": token,
            "Idempotency-Key": createUuid(),
          },
          body: JSON.stringify({
            amountCzk: payment.amountCzk.toFixed(2),
            effectiveAt: payment.nextEffectiveAt,
            note: payment.note,
          }),
        });
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["debts"] }),
        queryClient.invalidateQueries({ queryKey: ["income-plan"] }),
      ]);
      notifyDataChanged();
      onClose();
    },
  });
  const total = payments.reduce((sum, payment) => sum + payment.amountCzk, 0);
  return (
    <DebtDialog
      title="Naplánovat další splátku?"
      kicker="OPAKOVÁNÍ SPLÁTKY"
      onClose={onClose}
    >
      <div className="renew-payment-copy">
        <p>Aktuální splátka už byla potvrzena. Chcete vytvořit další plánovanou splátku se stejnou částkou?</p>
        {payments.map((payment) => (
          <div key={`${payment.debtId}-${payment.effectiveAt}`}>
            <span>{payment.debtName}</span>
            <strong>{czk.format(payment.amountCzk)}</strong>
            <small>
              {date.format(new Date(`${payment.nextEffectiveAt}T12:00:00`))}
            </small>
          </div>
        ))}
        {payments.length > 1 && <b>Celkem {czk.format(total)}</b>}
        {schedule.error && (
          <p className="form-error" role="alert">
            {schedule.error.message}
          </p>
        )}
        <div className="debt-dialog-actions">
          <button type="button" disabled={schedule.isPending} onClick={onClose}>
            Neplánovat další
          </button>
          <button
            className="pay"
            type="button"
            disabled={schedule.isPending}
            onClick={() => schedule.mutate()}
          >
            {schedule.isPending ? "Plánuji…" : "Ano, naplánovat"}
          </button>
        </div>
      </div>
    </DebtDialog>
  );
}

function DebtManagementDialog({
  debts,
  onClose,
  onEdit,
}: {
  debts: Debt[];
  onClose: () => void;
  onEdit: (debt: Debt) => void;
}) {
  return (
    <DebtDialog
      title="Správa dluhů"
      kicker="NASTAVENÍ ZÁVAZKŮ"
      onClose={onClose}
    >
      <div className="debt-management">
        <div className="debt-management-head">
          <span>Dluh</span>
          <span>Priorita splácení</span>
          <span>Akce</span>
        </div>
        {debts.map((debt) => (
          <DebtManagementRow
            debt={debt}
            onEdit={() => onEdit(debt)}
            key={debt.id}
          />
        ))}
        {debts.length === 0 && <p>Nejsou evidované žádné dluhy.</p>}
        <small>
          Priorita 0 vyřadí dluh z Income plánu, priorita 5 mu dává nejvyšší
          váhu.
        </small>
      </div>
    </DebtDialog>
  );
}

function DebtManagementRow({
  debt,
  onEdit,
}: {
  debt: Debt;
  onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const closed = Boolean(debt.closedAt) || debt.balanceCzk === 0;
  const updatePriority = useMutation({
    mutationFn: async (priority: number) => {
      const token = await antiforgeryToken();
      await apiRequest(`/api/debts/${debt.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token },
        body: JSON.stringify({
          name: debt.name,
          priority,
          isMortgage: debt.isMortgage,
          note: debt.note,
        }),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["debts"] }),
        queryClient.invalidateQueries({ queryKey: ["income-plan"] }),
      ]);
      notifyDataChanged();
    },
  });
  const archive = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken();
      await apiRequest(`/api/debts/${debt.id}/archive`, {
        method: "POST",
        headers: { "X-CSRF-TOKEN": token },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["debts"] });
      notifyDataChanged();
    },
  });
  return (
    <div className="debt-management-row">
      <div>
        <strong>{debt.name}</strong>
        <span>
          {closed ? "Splaceno" : czk.format(debt.balanceCzk)}
          {debt.isMortgage ? " · hypotéka" : ""}
        </span>
      </div>
      {debt.isMortgage ? (
        <span className="debt-management-excluded">Mimo Income plán</span>
      ) : (
        <div
          className="debt-management-priority"
          aria-label={`Priorita ${debt.name}`}
        >
          {[0, 1, 2, 3, 4, 5].map((priority) => (
            <button
              className={debt.priority === priority ? "selected" : ""}
              type="button"
              aria-label={`Nastavit prioritu ${priority} pro ${debt.name}`}
              disabled={closed || updatePriority.isPending}
              onClick={() => updatePriority.mutate(priority)}
              key={priority}
            >
              {priority}
            </button>
          ))}
        </div>
      )}
      <div className="debt-management-actions">
        <button
          type="button"
          aria-label={`Upravit ${debt.name}`}
          onClick={onEdit}
        >
          <Pencil size={14} />
        </button>
        {closed && (
          <button
            type="button"
            aria-label={`Archivovat ${debt.name}`}
            disabled={archive.isPending}
            onClick={() => archive.mutate()}
          >
            <Archive size={14} />
          </button>
        )}
      </div>
      {(updatePriority.error || archive.error) && (
        <p className="form-error" role="alert">
          {updatePriority.error?.message ?? archive.error?.message}
        </p>
      )}
    </div>
  );
}

function DebtMetric({
  label,
  value,
  note,
  strong,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  strong?: boolean;
  tone?: "danger";
}) {
  return (
    <div className={`debt-metric${strong ? " debt-metric--strong" : ""}`}>
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

function DebtRow({
  debt,
  onPay,
  onDraw,
  onEdit,
}: {
  debt: Debt;
  onPay: () => void;
  onDraw: () => void;
  onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const closed = Boolean(debt.closedAt) || debt.balanceCzk === 0;
  const archive = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken();
      await apiRequest(`/api/debts/${debt.id}/archive`, {
        method: "POST",
        headers: { "X-CSRF-TOKEN": token },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["debts"] });
      notifyDataChanged();
    },
  });
  return (
    <details className={`debt-row${closed ? " debt-row--closed" : ""}`}>
      <summary>
        <div className="debt-name">
          <div className="debt-icon">
            {closed ? (
              <Check size={16} />
            ) : debt.isMortgage ? (
              <Home size={16} />
            ) : (
              <ReceiptText size={16} />
            )}
          </div>
          <div>
            <h3>{debt.name}</h3>
            <p>
              {debt.isMortgage
                ? "Hypotéka"
                : debt.priority === 0
                  ? "Mimo plán splácení"
                  : `Priorita ${debt.priority}/5`}
              {(debt.scheduledPaymentCzk ?? 0) > 0
                ? ` · naplánováno ${czk.format(debt.scheduledPaymentCzk)}`
                : ""}
              {debt.note ? ` · ${debt.note}` : ""}
            </p>
          </div>
        </div>
        <div className="debt-balance">
          <span>{closed ? "Splaceno" : "Zůstatek"}</span>
          <strong>{czk.format(debt.balanceCzk)}</strong>
        </div>
        <ChevronDown className="debt-chevron" size={18} />
      </summary>
      <div className="debt-toolbar">
        <div>
          <span>
            Otevřeno{" "}
            <strong>
              {date.format(new Date(`${debt.openedAt}T12:00:00`))}
            </strong>
          </span>
          {debt.closedAt && (
            <span>
              Doplaceno{" "}
              <strong>
                {date.format(new Date(`${debt.closedAt}T12:00:00`))}
              </strong>
            </span>
          )}
          <span>{debt.entryCount} pohybů</span>
        </div>
        <div className="debt-actions">
          {!closed && (
            <>
              <button className="debt-increase" type="button" onClick={onDraw}>
                <Plus size={14} /> Navýšit
              </button>
              <button className="debt-pay" type="button" onClick={onPay}>
                <Banknote size={14} /> Zapsat splátku
              </button>
            </>
          )}
          <button
            type="button"
            aria-label={`Upravit ${debt.name}`}
            onClick={onEdit}
          >
            <Pencil size={15} />
          </button>
          {closed && (
            <button
              type="button"
              aria-label={`Archivovat ${debt.name}`}
              disabled={archive.isPending}
              onClick={() => archive.mutate()}
            >
              <Archive size={15} />
            </button>
          )}
        </div>
      </div>
      <DebtHistory debtId={debt.id} />
    </details>
  );
}

function DebtHistory({ debtId }: { debtId: string }) {
  const entries = useQuery({
    queryKey: ["debts", debtId, "entries"],
    queryFn: () => apiRequest<DebtEntry[]>(`/api/debts/${debtId}/entries`),
    retry: false,
  });
  return (
    <div className="debt-account-history">
      <div>HISTORIE ZÁVAZKU</div>
      {entries.isPending ? (
        <p>Načítám historii…</p>
      ) : entries.isError ? (
        <p>Historii se nepodařilo načíst.</p>
      ) : (
        <DebtEntries
          entries={Array.isArray(entries.data) ? entries.data : []}
        />
      )}
    </div>
  );
}

function DebtEntries({ entries }: { entries: DebtEntry[] }) {
  if (entries.length === 0)
    return (
      <p className="debt-no-entries">Zatím nejsou evidované žádné pohyby.</p>
    );
  return (
    <div className="debt-entries">
      {entries.map((entry) => (
        <DebtEntryRow entry={entry} key={entry.id} />
      ))}
    </div>
  );
}

function DebtEntryRow({ entry }: { entry: DebtEntry }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const outgoing =
    entry.type === "payment" ||
    entry.type === "scheduled_payment" ||
    entry.type === "adjustment_down";
  const remove = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken();
      await apiRequest(`/api/debts/${entry.debtId}/payments/${entry.id}`, {
        method: "DELETE",
        headers: { "X-CSRF-TOKEN": token },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["debts"] });
      notifyDataChanged();
    },
  });
  return (
    <div className="debt-entry">
      <span
        className={outgoing ? "debt-entry--payment" : "debt-entry--increase"}
      >
        {outgoing ? <Banknote size={15} /> : <CircleDollarSign size={15} />}
      </span>
      <div>
        <strong>
          {entry.isScheduled
            ? entry.isDue
              ? "Splatná plánovaná splátka"
              : "Naplánovaná splátka"
            : entryLabel(entry.type)}
        </strong>
        <small>
          {entry.debtName}
          {entry.note ? ` · ${entry.note}` : ""}
        </small>
      </div>
      <time>{date.format(new Date(`${entry.effectiveAt}T12:00:00`))}</time>
      <strong
        className={outgoing ? "debt-amount--payment" : "debt-amount--increase"}
      >
        {outgoing ? "−" : "+"}
        {czk.format(entry.amountCzk)}
      </strong>
      {(entry.type === "payment" || entry.type === "scheduled_payment") && (
        <button
          className={
            confirming ? "debt-entry-delete confirming" : "debt-entry-delete"
          }
          type="button"
          disabled={remove.isPending}
          aria-label={
            confirming
              ? `Potvrdit smazání splátky ${entry.debtName}`
              : `Smazat splátku ${entry.debtName}`
          }
          onClick={() => (confirming ? remove.mutate() : setConfirming(true))}
          onBlur={() => setConfirming(false)}
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

function DebtFormDialog({
  debt,
  onClose,
}: {
  debt?: Debt;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(debt?.name ?? "");
  const [amount, setAmount] = useState("");
  const [priority, setPriority] = useState(debt?.priority ?? 3);
  const [mortgage, setMortgage] = useState(debt?.isMortgage ?? false);
  const [openedAt, setOpenedAt] = useState(() =>
    formatCzechDate(debt?.openedAt ?? todayIsoDate()),
  );
  const [note, setNote] = useState(debt?.note ?? "");
  const mutation = useMutation({
    mutationFn: async () => {
      const token = await antiforgeryToken();
      if (debt)
        return apiRequest(`/api/debts/${debt.id}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-TOKEN": token,
          },
          body: JSON.stringify({
            name,
            priority,
            isMortgage: mortgage,
            note: note || null,
          }),
        });
      const dateValue = parseCzechDate(openedAt);
      if (!dateValue) throw new Error("Datum musí být ve formátu DD.MM.RRRR.");
      return apiRequest("/api/debts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token },
        body: JSON.stringify({
          name,
          openingBalanceCzk: amount,
          priority,
          isMortgage: mortgage,
          openedAt: dateValue,
          note: note || null,
        }),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["debts"] });
      notifyDataChanged();
      onClose();
    },
  });
  return (
    <DebtDialog
      title={debt ? "Upravit dluh" : "Přidat dluh"}
      kicker="EVIDENCE ZÁVAZKU"
      onClose={onClose}
    >
      <form
        className="debt-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <label>
          Název
          <input
            autoFocus
            value={name}
            maxLength={100}
            placeholder="Spotřebitelský úvěr"
            onChange={(event) => setName(event.target.value)}
            required
          />
        </label>
        {!debt && (
          <label>
            Počáteční zůstatek (Kč)
            <input
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
            />
          </label>
        )}
        <label className="debt-check">
          <input
            type="checkbox"
            checked={mortgage}
            onChange={(event) => setMortgage(event.target.checked)}
          />
          <span>Hypotéka</span>
        </label>
        {!mortgage && (
          <fieldset>
            <legend>Priorita splácení</legend>
            <div className="priority-picker">
              {[0, 1, 2, 3, 4, 5].map((value) => (
                <button
                  className={priority === value ? "selected" : ""}
                  type="button"
                  key={value}
                  onClick={() => setPriority(value)}
                >
                  {value}
                </button>
              ))}
            </div>
            <small>0 = mimo plán, 5 = nejvyšší priorita</small>
          </fieldset>
        )}
        {!debt && (
          <label>
            Datum otevření
            <input
              inputMode="numeric"
              pattern="\d{1,2}\.\d{1,2}\.\d{4}"
              value={openedAt}
              onChange={(event) => setOpenedAt(event.target.value)}
              required
            />
          </label>
        )}
        <label>
          Poznámka
          <input
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        {mutation.error && (
          <p className="form-error" role="alert">
            {mutation.error.message}
          </p>
        )}
        <div className="debt-dialog-actions">
          <button type="button" onClick={onClose}>
            Zrušit
          </button>
          <button
            className="primary"
            type="submit"
            disabled={mutation.isPending || !name.trim()}
          >
            <Plus size={15} /> {debt ? "Uložit změny" : "Přidat dluh"}
          </button>
        </div>
      </form>
    </DebtDialog>
  );
}

function PaymentDialog({
  debts,
  initialDebt,
  onClose,
}: {
  debts: Debt[];
  initialDebt?: Debt;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const key = useRef(createUuid());
  const [debtId, setDebtId] = useState(initialDebt?.id ?? debts[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [effectiveAt, setEffectiveAt] = useState(() =>
    formatCzechDate(todayIsoDate()),
  );
  const [note, setNote] = useState("");
  const selected = debts.find((debt) => debt.id === debtId);
  const mutation = useMutation({
    mutationFn: async () => {
      const parsed = parseCzechDate(effectiveAt);
      if (!parsed) throw new Error("Datum musí být ve formátu DD.MM.RRRR.");
      const token = await antiforgeryToken();
      await apiRequest(`/api/debts/${debtId}/payments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": token,
          "Idempotency-Key": key.current,
        },
        body: JSON.stringify({
          amountCzk: debtAmountForApi(amount),
          effectiveAt: parsed,
          note: note || null,
        }),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["debts"] });
      notifyDataChanged();
      onClose();
    },
  });
  const payment = parseDebtAmount(amount);
  const parsedEffectiveAt = parseCzechDate(effectiveAt);
  const isScheduled = Boolean(
    parsedEffectiveAt && parsedEffectiveAt > todayIsoDate(),
  );
  const availableBalance = selected
    ? selected.balanceCzk - (selected.scheduledPaymentCzk ?? 0)
    : 0;
  return (
    <DebtDialog
      title={isScheduled ? "Naplánovat splátku" : "Zapsat splátku"}
      kicker={isScheduled ? "BUDOUCÍ PLATBA" : "SNÍŽENÍ ZÁVAZKU"}
      onClose={onClose}
    >
      <form
        className="debt-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        {debts.length > 1 && (
          <label>
            Dluh
            <select
              value={debtId}
              onChange={(event) => setDebtId(event.target.value)}
            >
              {debts.map((debt) => (
                <option value={debt.id} key={debt.id}>
                  {debt.name} · {czk.format(debt.balanceCzk)}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="debt-amount-field">
          <label>
            Částka splátky (Kč)
            <input
              autoFocus
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
            />
          </label>
          {availableBalance > 0 && <button type="button" onClick={() => setAmount(availableBalance.toFixed(2))}>Celá částka</button>}
        </div>
        {selected && (
          <div className="payment-preview">
            <span>
              Aktuální zůstatek{" "}
              <strong>{czk.format(selected.balanceCzk)}</strong>
            </span>
            {(selected.scheduledPaymentCzk ?? 0) > 0 && (
              <span>
                Již naplánováno{" "}
                <strong>{czk.format(selected.scheduledPaymentCzk)}</strong>
              </span>
            )}
            <span>
              {isScheduled ? "Po plánovaných splátkách" : "Po splátce"}{" "}
              <strong>
                {Number.isFinite(payment) && payment > 0
                  ? czk.format(Math.max(0, availableBalance - payment))
                  : "—"}
              </strong>
            </span>
            {payment === availableBalance && <b>Dluh bude plně pokrytý</b>}
            {payment > availableBalance && (
              <b className="error">
                Splátka překračuje nezarezervovaný zůstatek
              </b>
            )}
          </div>
        )}
        <label>
          Datum splátky
          <input
            inputMode="numeric"
            pattern="\d{1,2}\.\d{1,2}\.\d{4}"
            value={effectiveAt}
            onChange={(event) => setEffectiveAt(event.target.value)}
            required
          />
        </label>
        {isScheduled && (
          <small>
            Budoucí splátka se rezervuje v Income plánu a zůstatek sníží až v
            den splatnosti.
          </small>
        )}
        <label>
          Poznámka
          <input
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        {debts.length === 0 && (
          <p className="form-error">Není evidovaný žádný aktivní dluh.</p>
        )}
        {mutation.error && (
          <p className="form-error" role="alert">
            {mutation.error.message}
          </p>
        )}
        <div className="debt-dialog-actions">
          <button type="button" onClick={onClose}>
            Zrušit
          </button>
          <button
            className="pay"
            type="submit"
            disabled={
              mutation.isPending ||
              !debtId ||
              !(payment > 0) ||
              Boolean(selected && payment > availableBalance)
            }
          >
            <Banknote size={15} />{" "}
            {isScheduled ? "Naplánovat splátku" : "Potvrdit splátku"}
          </button>
        </div>
      </form>
    </DebtDialog>
  );
}

function DrawdownDialog({
  debt,
  onClose,
}: {
  debt: Debt;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const key = useRef(createUuid());
  const [amount, setAmount] = useState("");
  const [effectiveAt, setEffectiveAt] = useState(() =>
    formatCzechDate(todayIsoDate()),
  );
  const [note, setNote] = useState("");
  const increase = Number(amount);
  const mutation = useMutation({
    mutationFn: async () => {
      const parsed = parseCzechDate(effectiveAt);
      if (!parsed) throw new Error("Datum musí být ve formátu DD.MM.RRRR.");
      const token = await antiforgeryToken();
      await apiRequest(`/api/debts/${debt.id}/drawdowns`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": token,
          "Idempotency-Key": key.current,
        },
        body: JSON.stringify({
          amountCzk: amount,
          effectiveAt: parsed,
          note: note || null,
        }),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["debts"] }),
        queryClient.invalidateQueries({ queryKey: ["income-plan"] }),
      ]);
      notifyDataChanged();
      onClose();
    },
  });
  return (
    <DebtDialog title="Navýšit půjčku" kicker="NOVÉ ČERPÁNÍ" onClose={onClose}>
      <form
        className="debt-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <label>
          Půjčka
          <input value={debt.name} disabled />
        </label>
        <label>
          Částka navýšení (Kč)
          <input
            autoFocus
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            required
          />
        </label>
        <div className="payment-preview">
          <span>
            Aktuální zůstatek <strong>{czk.format(debt.balanceCzk)}</strong>
          </span>
          <span>
            Po navýšení{" "}
            <strong>
              {Number.isFinite(increase) && increase > 0
                ? czk.format(debt.balanceCzk + increase)
                : "—"}
            </strong>
          </span>
        </div>
        <label>
          Datum navýšení
          <input
            inputMode="numeric"
            pattern="\d{1,2}\.\d{1,2}\.\d{4}"
            value={effectiveAt}
            onChange={(event) => setEffectiveAt(event.target.value)}
            required
          />
        </label>
        <label>
          Poznámka
          <input
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        {mutation.error && (
          <p className="form-error" role="alert">
            {mutation.error.message}
          </p>
        )}
        <div className="debt-dialog-actions">
          <button type="button" onClick={onClose}>
            Zrušit
          </button>
          <button
            className="primary"
            type="submit"
            disabled={
              mutation.isPending || !Number.isFinite(increase) || increase <= 0
            }
          >
            <Plus size={15} />{" "}
            {mutation.isPending ? "Zapisuji…" : "Navýšit půjčku"}
          </button>
        </div>
      </form>
    </DebtDialog>
  );
}

function DebtDialog({
  title,
  kicker,
  onClose,
  children,
}: {
  title: string;
  kicker: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="debt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="debt-dialog-title"
      >
        <button
          className="dialog-close"
          type="button"
          aria-label="Zavřít"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <p>{kicker}</p>
        <h2 id="debt-dialog-title">{title}</h2>
        {children}
      </section>
    </div>
  );
}
function entryLabel(type: string) {
  return (
    (
      {
        opening_balance: "Počáteční zůstatek",
        drawdown: "Čerpání",
        payment: "Splátka",
        interest: "Úrok",
        fee: "Poplatek",
        adjustment_up: "Navýšení",
        adjustment_down: "Snížení",
      } as Record<string, string>
    )[type] ?? type
  );
}
