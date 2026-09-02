import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { TrendingUp, WalletCards } from "lucide-react";
import { apiRequest } from "../lib/api";
import { calculateWealthTrend, type WealthTrend } from "../lib/wealthTrend";
import "./WealthPage.css";
import "./WealthRentChart.css";

type WealthPoint = {
  date: string;
  snapshotAt: string;
  quality: "complete" | "estimated";
  btcQuantity: number;
  btcPriceCzk: number;
  btcValueCzk: number;
  btcCostBasisCzk: number;
  vwceShares: number;
  vwcePriceCzk: number;
  vwceValueCzk: number;
  vwceCostBasisCzk: number;
  consumerDebtCzk: number;
  mortgageDebtCzk: number;
  grossAssetsCzk: number;
  trackedNetWorthCzk: number;
};
type WealthHistory = { current: WealthPoint | null; points: WealthPoint[] };
type VwceOverview = { totals: { rentRatePercent: number } };
type DebtOverview = {
  debts: { id: string; isMortgage: boolean }[];
  scheduledPayments: { debtId: string; amountCzk: number; effectiveAt: string }[];
};

const czk = new Intl.NumberFormat("cs-CZ", {
  style: "currency",
  currency: "CZK",
  maximumFractionDigits: 0,
});
const compactCzk = new Intl.NumberFormat("cs-CZ", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const date = new Intl.DateTimeFormat("cs-CZ", {
  day: "numeric",
  month: "short",
});
const fullDate = new Intl.DateTimeFormat("cs-CZ", {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const ranges = [
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "1R", days: 365 },
  { label: "Vše", days: 3650 },
];
const signedCzk = (value: number) =>
  `${value >= 0 ? "+" : "−"}${czk.format(Math.abs(value))}`;

function createDateScale(
  points: { date: string }[],
  left: number,
  right: number,
) {
  const first = Date.parse(`${points[0].date}T00:00:00Z`);
  const last = Date.parse(`${points.at(-1)!.date}T00:00:00Z`);
  const span = last - first;
  return (index: number) =>
    span <= 0
      ? (left + right) / 2
      : left +
        ((Date.parse(`${points[index].date}T00:00:00Z`) - first) / span) *
          (right - left);
}

function nearestPointIndex(
  points: { date: string }[],
  x: (index: number) => number,
  pointerX: number,
) {
  return points.reduce(
    (nearest, _, index) =>
      Math.abs(x(index) - pointerX) < Math.abs(x(nearest) - pointerX)
        ? index
        : nearest,
    0,
  );
}

export function WealthPage() {
  const navigate = useNavigate();
  const { tab } = useSearch({ from: "/wealth" });
  const [days, setDays] = useState(365);
  const chartView: "portfolio" | "net" | "rent" | "trend" = tab ?? "portfolio";
  const setChartView = (next: "portfolio" | "net" | "rent" | "trend") =>
    void navigate({
      to: "/wealth",
      search: { tab: next === "portfolio" ? undefined : next },
      replace: true,
    });
  const [trendYears, setTrendYears] = useState<1 | 2 | 5>(1);
  const [trendTarget, setTrendTarget] = useState<"portfolio" | "net">(
    "portfolio",
  );
  const history = useQuery({
    queryKey: ["wealth", "history", days],
    queryFn: () =>
      apiRequest<WealthHistory>(`/api/wealth/history?days=${days}`),
    retry: false,
  });
  const fullHistory = useQuery({
    queryKey: ["wealth", "history", 3650],
    queryFn: () => apiRequest<WealthHistory>("/api/wealth/history?days=3650"),
    enabled: chartView === "trend",
    retry: false,
  });
  const vwce = useQuery({
    queryKey: ["vwce", "overview"],
    queryFn: () => apiRequest<VwceOverview>("/api/vwce/overview"),
    retry: false,
  });
  const debts = useQuery({
    queryKey: ["debts", "overview"],
    queryFn: () => apiRequest<DebtOverview>("/api/debts/overview"),
    enabled: chartView === "trend",
    retry: false,
  });
  if (history.isPending)
    return (
      <section className="wealth-page">
        <div className="wealth-loading" />
        <div className="wealth-chart-loading" />
      </section>
    );
  if (history.isError)
    return (
      <section className="wealth-page wealth-state">
        <WalletCards size={28} />
        <h2>Jmění se nepodařilo načíst</h2>
        <button type="button" onClick={() => history.refetch()}>
          Zkusit znovu
        </button>
      </section>
    );
  const points = Array.isArray(history.data.points) ? history.data.points : [];
  const current =
    history.data.current &&
    Number.isFinite(history.data.current.trackedNetWorthCzk)
      ? history.data.current
      : (points.at(-1) ?? null);
  const first = points[0];
  const currentValue = current?.grossAssetsCzk ?? 0;
  const firstValue = first?.grossAssetsCzk ?? 0;
  const change = current && first ? currentValue - firstValue : 0;
  const invested =
    (current?.btcCostBasisCzk ?? 0) + (current?.vwceCostBasisCzk ?? 0);
  const profit = (current?.grossAssetsCzk ?? 0) - invested;
  const btcProfit =
    (current?.btcValueCzk ?? 0) - (current?.btcCostBasisCzk ?? 0);
  const vwceProfit =
    (current?.vwceValueCzk ?? 0) - (current?.vwceCostBasisCzk ?? 0);
  const btcShare =
    current && current.grossAssetsCzk > 0
      ? current.btcValueCzk / current.grossAssetsCzk
      : 0;
  const vwceShare =
    current && current.grossAssetsCzk > 0
      ? current.vwceValueCzk / current.grossAssetsCzk
      : 0;
  const trend =
    chartView === "trend" && fullHistory.data
      ? calculateWealthTrend(
          Array.isArray(fullHistory.data.points) ? fullHistory.data.points : [],
          trendYears,
          (debts.data?.scheduledPayments ?? [])
            .filter(
              (payment) =>
                debts.data?.debts.find((debt) => debt.id === payment.debtId)
                  ?.isMortgage === false,
            )
            .map((payment) => ({
              effectiveAt: payment.effectiveAt,
              amountCzk: payment.amountCzk,
            })),
        )
      : null;
  const projectedValue = trend
    ? trendTarget === "portfolio"
      ? trend.projection.at(-1)?.portfolioCzk
      : trend.projection.at(-1)?.netWorthCzk
    : undefined;
  const rentRatePercent = vwce.data?.totals?.rentRatePercent ?? 0;
  const currentMonthlyRent =
    ((current?.vwceValueCzk ?? 0) * rentRatePercent) / 100 / 12;
  return (
    <section className="wealth-page">
      <div className="wealth-content">
        <div className="wealth-panel wealth-summary">
          <div className="wealth-primary">
            <span>HODNOTA PORTFOLIA BEZ HOTOVOSTI</span>
            <strong>{current ? czk.format(currentValue) : "—"}</strong>
          </div>
          <div className="wealth-summary-stats">
            <Stat
              label="Hodnota portfolia"
              value={czk.format(current?.grossAssetsCzk ?? 0)}
            />
            <Stat label="Investováno" value={czk.format(invested)} />
            <Stat
              label="Nerealizovaný výsledek držených aktiv"
              value={signedCzk(profit)}
              tone={profit >= 0 ? "positive" : "negative"}
              sub={
                invested > 0
                  ? `${profit >= 0 ? "+" : ""}${((profit / invested) * 100).toFixed(1)} %`
                  : undefined
              }
            />
            {current && current.consumerDebtCzk > 0 && (
              <Stat
                label="Dluhy"
                value={`− ${czk.format(current.consumerDebtCzk)}`}
                tone="negative"
              />
            )}
          </div>
        </div>
        {current && current.grossAssetsCzk > 0 && (
          <div className="wealth-panel wealth-allocation">
            <p>ALOKACE AKTIV</p>
            <div className="wealth-allocation-bar">
              <span className="btc" style={{ width: `${btcShare * 100}%` }} />
              <span className="vwce" style={{ width: `${vwceShare * 100}%` }} />
            </div>
            <div className="wealth-allocation-legend">
              <span>
                <i className="btc" />
                <b>BTC</b>
                {Math.round(btcShare * 100)} %
                <small>· {czk.format(current.btcValueCzk)}</small>
              </span>
              <span>
                <i className="vwce" />
                <b>VWCE</b>
                {Math.round(vwceShare * 100)} %
                <small>· {czk.format(current.vwceValueCzk)}</small>
              </span>
            </div>
          </div>
        )}
        <div className="wealth-panel wealth-chart-section">
          <header>
            <div>
              <p>
                {chartView === "portfolio"
                  ? "VÝVOJ PORTFOLIA ZA OBDOBÍ"
                  : chartView === "net"
                    ? "VÝVOJ ČISTÉHO JMĚNÍ"
                    : chartView === "rent"
                      ? "VÝVOJ MĚSÍČNÍ RENTY"
                    : `ODHAD ${trendTarget === "portfolio" ? "PORTFOLIA" : "ČISTÉHO JMĚNÍ"} ZA ${trendYears} ${trendYears === 1 ? "ROK" : trendYears === 2 ? "ROKY" : "LET"}`}
              </p>
              <strong
                className={
                  chartView === "portfolio"
                    ? change >= 0
                      ? "positive"
                      : "negative"
                    : chartView === "net"
                      ? (current?.trackedNetWorthCzk ?? 0) >= 0
                        ? "positive"
                        : "negative"
                      : chartView === "rent"
                        ? "positive"
                      : (projectedValue ?? 0) >=
                          (trendTarget === "portfolio"
                            ? currentValue
                            : (current?.trackedNetWorthCzk ?? 0))
                        ? "positive"
                        : "negative"
                }
              >
                {chartView === "portfolio"
                  ? points.length > 1
                    ? signedCzk(change)
                    : "—"
                  : chartView === "net"
                    ? current
                      ? czk.format(current.trackedNetWorthCzk)
                      : "—"
                    : chartView === "rent"
                      ? vwce.isPending || vwce.isError
                        ? "—"
                        : czk.format(currentMonthlyRent)
                    : projectedValue === undefined
                      ? "—"
                      : czk.format(projectedValue)}
              </strong>
            </div>
            <div className="wealth-chart-controls">
              <div
                className="wealth-view-tabs"
                role="tablist"
                aria-label="Pohled na graf jmění"
              >
                <button
                  className={chartView === "portfolio" ? "active" : ""}
                  role="tab"
                  aria-selected={chartView === "portfolio"}
                  type="button"
                  onClick={() => setChartView("portfolio")}
                >
                  Portfolio value
                </button>
                <button
                  className={chartView === "net" ? "active" : ""}
                  role="tab"
                  aria-selected={chartView === "net"}
                  type="button"
                  onClick={() => setChartView("net")}
                >
                  Čisté jmění
                </button>
                <button
                  className={chartView === "rent" ? "active" : ""}
                  role="tab"
                  aria-selected={chartView === "rent"}
                  type="button"
                  onClick={() => setChartView("rent")}
                >
                  Renta
                </button>
                <button
                  className={chartView === "trend" ? "active" : ""}
                  role="tab"
                  aria-selected={chartView === "trend"}
                  type="button"
                  onClick={() => setChartView("trend")}
                >
                  Trend
                </button>
              </div>
              {chartView === "trend" ? (
                <>
                  <div className="wealth-ranges" aria-label="Veličina trendu">
                    <button
                      className={trendTarget === "portfolio" ? "active" : ""}
                      type="button"
                      onClick={() => setTrendTarget("portfolio")}
                    >
                      Portfolio
                    </button>
                    <button
                      className={trendTarget === "net" ? "active" : ""}
                      type="button"
                      onClick={() => setTrendTarget("net")}
                    >
                      Čisté jmění
                    </button>
                  </div>
                  <div
                    className="wealth-ranges wealth-trend-ranges"
                    aria-label="Horizont trendu"
                  >
                    {([1, 2, 5] as const).map((years) => (
                      <button
                        className={trendYears === years ? "active" : ""}
                        type="button"
                        onClick={() => setTrendYears(years)}
                        key={years}
                      >
                        {years}R
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div className="wealth-ranges">
                  {ranges.map((range) => (
                    <button
                      className={days === range.days ? "active" : ""}
                      type="button"
                      onClick={() => setDays(range.days)}
                      key={range.days}
                    >
                      {range.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </header>
          {chartView === "portfolio" ? (
            <WealthChart points={points} />
          ) : chartView === "net" ? (
            <NetWorthChart points={points} />
          ) : chartView === "rent" ? (
            vwce.isError ? (
              <div className="wealth-empty-chart">
                Sazbu renty se nepodařilo načíst.
              </div>
            ) : (
              <MonthlyRentChart points={points} rentRatePercent={rentRatePercent} />
            )
          ) : fullHistory.isPending ? (
            <div className="wealth-empty-chart">
              Načítám historii pro trend…
            </div>
          ) : (
            <TrendChart trend={trend} target={trendTarget} />
          )}
          {chartView === "portfolio" ? (
            <div className="wealth-legend">
              <span>
                <i
                  className={
                    change >= 0 ? "portfolio trend-up" : "portfolio trend-down"
                  }
                />
                Hodnota portfolia
              </span>
              <span>
                <i className="invested" />
                Investováno
              </span>
              {current?.quality === "estimated" && <b>Odhadovaná cena</b>}
            </div>
          ) : chartView === "net" ? (
            <div className="wealth-legend">
              <span>
                <i className="net-positive" />
                Kladné čisté jmění
              </span>
              <span>
                <i className="net-negative" />
                Záporné čisté jmění
              </span>
            </div>
          ) : chartView === "rent" ? (
            !vwce.isError && (
              <div className="wealth-legend">
                <span>
                  <i className="rent" />
                  Hypotetická měsíční renta při sazbě {rentRatePercent.toLocaleString("cs-CZ", { maximumFractionDigits: 2 })} % p.a. podle aktuálního nastavení
                </span>
              </div>
            )
          ) : (
            trend && (
              <div className="wealth-trend-footer">
                <div className="wealth-legend">
                  <span>
                    <i
                      className={
                        (
                          trendTarget === "portfolio"
                            ? trend.projection.at(-1)!.portfolioCzk >=
                              trend.projection[0].portfolioCzk
                            : trend.projection.at(-1)!.netWorthCzk >=
                              trend.projection[0].netWorthCzk
                        )
                          ? "trend-up"
                          : "trend-down"
                      }
                    />
                    {trendTarget === "portfolio" ? "Portfolio" : "Čisté jmění"}
                  </span>
                  <span>
                    <i className="invested" />
                    {trendTarget === "portfolio" ? "Investováno" : "Dluhy"}
                  </span>
                  <span className="trend-projected-key">
                    světlejší = předpověď
                  </span>
                </div>
                {trendTarget === "portfolio" ? (
                  <p>
                    {trend.hasReliableHistory ? (
                      <>
                        Průměrný čistý přítok{" "}
                        <strong>
                          {czk.format(trend.annualContributionCzk)} / rok
                        </strong>{" "}
                        · relativní růst{" "}
                        <strong
                          className={
                            trend.annualGrowthPercent >= 0
                              ? "positive"
                              : "negative"
                          }
                        >
                          {trend.annualGrowthPercent >= 0 ? "+" : ""}
                          {trend.annualGrowthPercent.toFixed(1)} % p.a.
                        </strong>
                      </>
                    ) : (
                      <>
                        Neutrální odhad · pro výpočet tempa je potřeba alespoň{" "}
                        <strong>30 dní historie</strong> (nyní {trend.observationDays})
                      </>
                    )}
                  </p>
                ) : (
                  <p>
                    Odhad dluhu na konci období{" "}
                    <strong>
                      {czk.format(trend.projection.at(-1)!.debtCzk)}
                    </strong>{" "}
                    · započítány jsou naplánované splátky · hypotéka není
                    zahrnuta
                  </p>
                )}
              </div>
            )
          )}
        </div>
        <div className="wealth-panel wealth-breakdown">
          <div className="wealth-breakdown-head">
            <span>Položka</span>
            <span>Hodnota</span>
            <span>Investováno</span>
            <span>Zisk / Ztráta</span>
          </div>
          <BreakdownRow
            label="BTC"
            tone="btc"
            detail={
              current?.btcQuantity
                ? `${current.btcQuantity.toFixed(6)} BTC`
                : undefined
            }
            value={current?.btcValueCzk ?? 0}
            invested={current?.btcCostBasisCzk ?? 0}
            profit={btcProfit}
          />
          <BreakdownRow
            label="VWCE"
            tone="vwce"
            detail={
              current?.vwceShares
                ? `${current.vwceShares.toFixed(4)} ks`
                : undefined
            }
            value={current?.vwceValueCzk ?? 0}
            invested={current?.vwceCostBasisCzk ?? 0}
            profit={vwceProfit}
          />
          <BreakdownRow
            label="Portfolio"
            className="subtotal"
            value={current?.grossAssetsCzk ?? 0}
            invested={invested}
            profit={profit}
          />
          {current && current.consumerDebtCzk > 0 && (
            <BreakdownRow
              label="Dluhy"
              className="debt"
              value={-current.consumerDebtCzk}
            />
          )}
          <BreakdownRow
            label="Čisté jmění"
            className="total"
            value={current?.trackedNetWorthCzk ?? 0}
          />
          {current && current.mortgageDebtCzk > 0 && (
            <p className="wealth-mortgage-note">
              Hypotéka {czk.format(current.mortgageDebtCzk)} je evidovaná
              samostatně a není součástí čistého jmění.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function MonthlyRentChart({
  points,
  rentRatePercent,
}: {
  points: WealthPoint[];
  rentRatePercent: number;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  if (points.length === 0)
    return (
      <div className="wealth-empty-chart">
        <TrendingUp size={26} />
        <strong>První snapshot zatím není dostupný</strong>
        <span>Vývoj renty se zobrazí po vytvoření snapshotu jmění.</span>
      </div>
    );
  const values = points.map(
    (point) => (point.vwceValueCzk * rentRatePercent) / 100 / 12,
  );
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const spread = Math.max(rawMax - rawMin, rawMax * 0.1, 1);
  const min = Math.max(0, rawMin - spread * 0.12);
  const max = rawMax + spread * 0.12;
  const left = 72;
  const right = 974;
  const top = 24;
  const bottom = 214;
  const x = createDateScale(points, left, right);
  const y = (value: number) =>
    bottom - ((value - min) / Math.max(max - min, 1)) * (bottom - top);
  const line = values
    .map((value, index) => `${index === 0 ? "M" : "L"} ${x(index)} ${y(value)}`)
    .join(" ");
  const area = `${line} L ${x(points.length - 1)} ${bottom} L ${x(0)} ${bottom} Z`;
  const active = hovered === null ? null : points[hovered];
  return (
    <div
      className="wealth-rent-chart"
      onPointerLeave={() => setHovered(null)}
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = Math.min(
          1,
          Math.max(0, (event.clientX - rect.left) / Math.max(rect.width, 1)),
        );
        setHovered(nearestPointIndex(points, x, ratio * 1000));
      }}
    >
      <svg
        viewBox="0 0 1000 250"
        role="img"
        aria-label="Graf vývoje měsíční renty z VWCE"
      >
        {[0, 1, 2].map((step) => {
          const gridY = top + (step / 2) * (bottom - top);
          const value = max - (step / 2) * (max - min);
          return (
            <g key={step}>
              <line
                className="wealth-grid"
                x1={left}
                x2={right}
                y1={gridY}
                y2={gridY}
              />
              <text className="wealth-axis-value" x={left - 12} y={gridY + 4}>
                {compactCzk.format(value)}
              </text>
            </g>
          );
        })}
        <path className="wealth-rent-area" d={area} />
        <path className="wealth-rent-line" d={line} />
        {points.length === 1 && (
          <circle
            className="wealth-rent-point"
            cx={x(0)}
            cy={y(values[0])}
            r="5"
          />
        )}
        {hovered !== null && active && (
          <>
            <line
              className="wealth-cursor"
              x1={x(hovered)}
              x2={x(hovered)}
              y1={top}
              y2={bottom}
            />
            <circle
              className="wealth-rent-point active"
              cx={x(hovered)}
              cy={y(values[hovered])}
              r="5"
            />
          </>
        )}
        <text className="wealth-axis-date" x={left} y="242">
          {date.format(new Date(`${points[0].date}T12:00:00`))}
        </text>
        {points.length > 1 && (
          <text className="wealth-axis-date end" x={right} y="242">
            {date.format(new Date(`${points.at(-1)!.date}T12:00:00`))}
          </text>
        )}
      </svg>
      {hovered !== null && active && (
        <div
          className="wealth-tooltip"
          style={{
            left: `${x(hovered) / 10}%`,
            top: `${Math.max(6, y(values[hovered]) / 2.5 - 18)}%`,
          }}
        >
          <span>{date.format(new Date(`${active.date}T12:00:00`))}</span>
          <strong>Měsíční renta {czk.format(values[hovered])}</strong>
          <small>Hodnota VWCE {czk.format(active.vwceValueCzk)}</small>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone?: string;
  sub?: string;
}) {
  return (
    <div className="wealth-stat">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
      {sub && <small className={tone}>{sub}</small>}
    </div>
  );
}

function BreakdownRow({
  label,
  detail,
  tone,
  value,
  invested,
  profit,
  className = "",
}: {
  label: string;
  detail?: string;
  tone?: string;
  value: number;
  invested?: number;
  profit?: number;
  className?: string;
}) {
  return (
    <div className={`wealth-breakdown-row ${className}`}>
      <span>
        {tone && <i className={tone} />}
        <b>{label}</b>
        {detail && <small>· {detail}</small>}
      </span>
      <strong className={value < 0 ? "negative" : ""}>
        {value < 0 ? signedCzk(value) : czk.format(value)}
      </strong>
      <span>
        {invested === undefined
          ? ""
          : invested > 0
            ? czk.format(invested)
            : "—"}
      </span>
      <span
        className={
          profit === undefined ? "" : profit >= 0 ? "positive" : "negative"
        }
      >
        {profit === undefined ? "" : signedCzk(profit)}
      </span>
    </div>
  );
}

function WealthChart({ points }: { points: WealthPoint[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  if (points.length === 0)
    return (
      <div className="wealth-empty-chart">
        <TrendingUp size={26} />
        <strong>První snapshot zatím není dostupný</strong>
        <span>Server jej vytvoří, jakmile získá potřebné tržní ceny.</span>
      </div>
    );
  const valueOf = (point: WealthPoint) => point.grossAssetsCzk;
  const investedOf = (point: WealthPoint) =>
    point.btcCostBasisCzk + point.vwceCostBasisCzk;
  const values = points.map(valueOf);
  const investedValues = points.map(investedOf);
  const rawMin = Math.min(...values, ...investedValues);
  const rawMax = Math.max(...values, ...investedValues);
  const spread = Math.max(rawMax - rawMin, Math.abs(rawMax) * 0.1, 1);
  const min = rawMin - spread * 0.12;
  const max = rawMax + spread * 0.12;
  const left = 72;
  const right = 974;
  const top = 24;
  const bottom = 284;
  const x = createDateScale(points, left, right);
  const y = (value: number) =>
    bottom - ((value - min) / (max - min)) * (bottom - top);
  const line = points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"} ${x(index)} ${y(valueOf(point))}`,
    )
    .join(" ");
  const investedLine = points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"} ${x(index)} ${y(investedOf(point))}`,
    )
    .join(" ");
  const area = `${line} L ${x(points.length - 1)} ${bottom} L ${x(0)} ${bottom} Z`;
  const rising = values.at(-1)! >= values[0];
  const trendColor = rising ? "#22c55e" : "#ef4444";
  const trendClass = rising ? "trend-up" : "trend-down";
  const active = hovered === null ? null : points[hovered];
  return (
    <div
      className="wealth-chart"
      onPointerLeave={() => setHovered(null)}
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = Math.min(
          1,
          Math.max(0, (event.clientX - rect.left) / rect.width),
        );
        setHovered(nearestPointIndex(points, x, ratio * 1000));
      }}
    >
      <svg
        viewBox="0 0 1000 320"
        role="img"
        aria-label="Graf vývoje hodnoty portfolia a investovaných částek"
      >
        <defs>
          <linearGradient id="wealth-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={trendColor} stopOpacity=".2" />
            <stop offset="1" stopColor={trendColor} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3].map((step) => {
          const gridY = top + (step / 3) * (bottom - top);
          const value = max - (step / 3) * (max - min);
          return (
            <g key={step}>
              <line
                className="wealth-grid"
                x1={left}
                x2={right}
                y1={gridY}
                y2={gridY}
              />
              <text className="wealth-axis-value" x={left - 12} y={gridY + 4}>
                {compactCzk.format(value)}
              </text>
            </g>
          );
        })}
        <path className="wealth-area" d={area} />
        <path className={`wealth-line ${trendClass}`} d={line} />
        <path className="wealth-invested-line" d={investedLine} />
        {points.length === 1 && (
          <circle
            className={`wealth-point ${trendClass}`}
            cx={x(0)}
            cy={y(valueOf(points[0]))}
            r="5"
          />
        )}
        {hovered !== null && active && (
          <>
            <line
              className="wealth-cursor"
              x1={x(hovered)}
              x2={x(hovered)}
              y1={top}
              y2={bottom}
            />
            <circle
              className={`wealth-point active ${trendClass}`}
              cx={x(hovered)}
              cy={y(valueOf(active))}
              r="5"
            />
          </>
        )}
        <text className="wealth-axis-date" x={left} y="310">
          {date.format(new Date(`${points[0].date}T12:00:00`))}
        </text>
        {points.length > 1 && (
          <text className="wealth-axis-date end" x={right} y="310">
            {date.format(new Date(`${points.at(-1)!.date}T12:00:00`))}
          </text>
        )}
      </svg>
      {hovered !== null && active && (
        <div
          className="wealth-tooltip"
          style={{
            left: `${x(hovered) / 10}%`,
            top: `${Math.max(6, y(valueOf(active)) / 3.2 - 18)}%`,
          }}
        >
          <span>{date.format(new Date(`${active.date}T12:00:00`))}</span>
          <strong>Hodnota {czk.format(valueOf(active))}</strong>
          <small>Investováno {czk.format(investedOf(active))}</small>
        </div>
      )}
    </div>
  );
}

function NetWorthChart({ points }: { points: WealthPoint[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  if (points.length === 0)
    return (
      <div className="wealth-empty-chart">
        <TrendingUp size={26} />
        <strong>První snapshot zatím není dostupný</strong>
        <span>Server jej vytvoří, jakmile získá potřebné tržní ceny.</span>
      </div>
    );
  const values = points.map((point) => point.trackedNetWorthCzk);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const spread = Math.max(rawMax - rawMin, Math.abs(rawMax) * 0.1, 1);
  const min = rawMin - spread * 0.12;
  const max = rawMax + spread * 0.12;
  const left = 72;
  const right = 974;
  const top = 24;
  const bottom = 284;
  const x = createDateScale(points, left, right);
  const y = (value: number) =>
    bottom - ((value - min) / (max - min)) * (bottom - top);
  const active = hovered === null ? null : points[hovered];
  const segments = points.slice(0, -1).flatMap((point, index) => {
    const startValue = point.trackedNetWorthCzk;
    const endValue = points[index + 1].trackedNetWorthCzk;
    const startX = x(index);
    const endX = x(index + 1);
    if (startValue >= 0 === endValue >= 0) {
      return [
        <line
          className={
            startValue >= 0 ? "net-line-positive" : "net-line-negative"
          }
          x1={startX}
          y1={y(startValue)}
          x2={endX}
          y2={y(endValue)}
          key={`${index}-full`}
        />,
      ];
    }
    const crossingRatio = (0 - startValue) / (endValue - startValue);
    const crossingX = startX + (endX - startX) * crossingRatio;
    return [
      <line
        className={startValue >= 0 ? "net-line-positive" : "net-line-negative"}
        x1={startX}
        y1={y(startValue)}
        x2={crossingX}
        y2={y(0)}
        key={`${index}-start`}
      />,
      <line
        className={endValue >= 0 ? "net-line-positive" : "net-line-negative"}
        x1={crossingX}
        y1={y(0)}
        x2={endX}
        y2={y(endValue)}
        key={`${index}-end`}
      />,
    ];
  });
  return (
    <div
      className="wealth-chart"
      onPointerLeave={() => setHovered(null)}
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = Math.min(
          1,
          Math.max(0, (event.clientX - rect.left) / rect.width),
        );
        setHovered(nearestPointIndex(points, x, ratio * 1000));
      }}
    >
      <svg
        viewBox="0 0 1000 320"
        role="img"
        aria-label="Graf vývoje čistého jmění"
      >
        {[0, 1, 2, 3].map((step) => {
          const gridY = top + (step / 3) * (bottom - top);
          const value = max - (step / 3) * (max - min);
          return (
            <g key={step}>
              <line
                className="wealth-grid"
                x1={left}
                x2={right}
                y1={gridY}
                y2={gridY}
              />
              <text className="wealth-axis-value" x={left - 12} y={gridY + 4}>
                {compactCzk.format(value)}
              </text>
            </g>
          );
        })}
        {min < 0 && max > 0 && (
          <line
            className="net-zero-line"
            x1={left}
            x2={right}
            y1={y(0)}
            y2={y(0)}
          />
        )}
        <g className="net-worth-line">{segments}</g>
        {points.length === 1 && (
          <circle
            className={
              values[0] >= 0 ? "net-point-positive" : "net-point-negative"
            }
            cx={x(0)}
            cy={y(values[0])}
            r="5"
          />
        )}
        {hovered !== null && active && (
          <>
            <line
              className="wealth-cursor"
              x1={x(hovered)}
              x2={x(hovered)}
              y1={top}
              y2={bottom}
            />
            <circle
              className={
                active.trackedNetWorthCzk >= 0
                  ? "net-point-positive active"
                  : "net-point-negative active"
              }
              cx={x(hovered)}
              cy={y(active.trackedNetWorthCzk)}
              r="5"
            />
          </>
        )}
        <text className="wealth-axis-date" x={left} y="310">
          {date.format(new Date(`${points[0].date}T12:00:00`))}
        </text>
        {points.length > 1 && (
          <text className="wealth-axis-date end" x={right} y="310">
            {date.format(new Date(`${points.at(-1)!.date}T12:00:00`))}
          </text>
        )}
      </svg>
      {hovered !== null && active && (
        <div
          className="wealth-tooltip"
          style={{
            left: `${x(hovered) / 10}%`,
            top: `${Math.max(6, y(active.trackedNetWorthCzk) / 3.2 - 18)}%`,
          }}
        >
          <span>{date.format(new Date(`${active.date}T12:00:00`))}</span>
          <strong
            className={active.trackedNetWorthCzk >= 0 ? "positive" : "negative"}
          >
            {czk.format(active.trackedNetWorthCzk)}
          </strong>
        </div>
      )}
    </div>
  );
}

function TrendChart({
  trend,
  target,
}: {
  trend: WealthTrend | null;
  target: "portfolio" | "net";
}) {
  const [hovered, setHovered] = useState<{
    point: WealthTrend["history"][number];
    x: number;
    projected: boolean;
  } | null>(null);
  if (!trend)
    return (
      <div className="wealth-empty-chart">
        <TrendingUp size={26} />
        <strong>Pro trend zatím není dost historie</strong>
        <span>Predikce potřebuje alespoň dva denní snapshoty.</span>
      </div>
    );
  const { history, projection } = trend;
  const left = 72;
  const right = 950;
  const top = 32;
  const bottom = 284;
  const valueOf = (point: WealthTrend["history"][number]) =>
    target === "portfolio" ? point.portfolioCzk : point.netWorthCzk;
  const comparisonOf = (point: WealthTrend["history"][number]) =>
    target === "portfolio" ? point.investedCzk : point.debtCzk;
  const allValues = [
    ...history.flatMap((point) => [valueOf(point), comparisonOf(point)]),
    ...projection.flatMap((point) => [valueOf(point), comparisonOf(point)]),
  ];
  const rawMin = Math.min(...allValues);
  const rawMax = Math.max(...allValues);
  const spread = Math.max(rawMax - rawMin, Math.abs(rawMax) * 0.1, 1);
  const min = rawMin - spread * 0.1;
  const max = rawMax + spread * 0.1;
  const y = (value: number) =>
    bottom - ((value - min) / (max - min)) * (bottom - top);
  const startTime = Date.parse(`${history[0].date}T00:00:00Z`);
  const endTime = Date.parse(`${projection.at(-1)!.date}T00:00:00Z`);
  const fullSpan = Math.max(1, endTime - startTime);
  const pointX = (point: WealthTrend["history"][number]) =>
    left +
    ((Date.parse(`${point.date}T00:00:00Z`) - startTime) / fullSpan) *
      (right - left);
  const historyEnd = pointX(history.at(-1)!);
  const path = (
    items: WealthTrend["history"],
    x: (point: WealthTrend["history"][number]) => number,
    value: (point: WealthTrend["history"][number]) => number,
  ) =>
    items
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"} ${x(point)} ${y(value(point))}`,
      )
      .join(" ");
  const historyPortfolio = path(history, pointX, valueOf);
  const historyInvested = path(history, pointX, comparisonOf);
  const projectionPortfolio = path(projection, pointX, valueOf);
  const projectionInvested = path(projection, pointX, comparisonOf);
  const rising = valueOf(history.at(-1)!) >= valueOf(history[0]);
  const trendClass = rising ? "trend-up" : "trend-down";
  const interactivePoints = [
    ...history.map((point) => ({
      point,
      x: pointX(point),
      projected: false,
    })),
    ...projection
      .slice(1)
      .map((point) => ({ point, x: pointX(point), projected: true })),
  ];
  const selectNearestPoint = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerX =
      ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 1000;
    setHovered(
      interactivePoints.reduce((nearest, candidate) =>
        Math.abs(candidate.x - pointerX) < Math.abs(nearest.x - pointerX)
          ? candidate
          : nearest,
      ),
    );
  };
  return (
    <div
      className="wealth-chart wealth-trend-chart"
      onPointerLeave={() => setHovered(null)}
      onPointerMove={selectNearestPoint}
    >
      <svg
        viewBox="0 0 1000 320"
        role="img"
        aria-label={`Graf historie a předpovědi trendu ${target === "portfolio" ? "portfolia" : "čistého jmění"}`}
      >
        <defs>
          <marker
            id="trend-portfolio-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path
              className={`trend-arrow ${trendClass}`}
              d="M 0 0 L 10 5 L 0 10 z"
            />
          </marker>
          <marker
            id="trend-invested-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path className="trend-arrow invested" d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>
        {[0, 1, 2, 3].map((step) => {
          const gridY = top + (step / 3) * (bottom - top);
          const value = max - (step / 3) * (max - min);
          return (
            <g key={step}>
              <line
                className="wealth-grid"
                x1={left}
                x2={right}
                y1={gridY}
                y2={gridY}
              />
              <text className="wealth-axis-value" x={left - 12} y={gridY + 4}>
                {compactCzk.format(value)}
              </text>
            </g>
          );
        })}
        <rect
          className="trend-forecast-zone"
          x={historyEnd}
          y={top}
          width={right - historyEnd}
          height={bottom - top}
        />
        <line
          className="trend-divider"
          x1={historyEnd}
          x2={historyEnd}
          y1={top}
          y2={bottom}
        />
        <text className="trend-zone-label" x={left} y="18">
          HISTORIE
        </text>
        <text className="trend-zone-label forecast" x={historyEnd + 12} y="18">
          PŘEDPOVĚĎ
        </text>
        <path
          className={`trend-history-portfolio ${trendClass}`}
          d={historyPortfolio}
        />
        <path className="trend-history-invested" d={historyInvested} />
        <path
          className={`trend-projection-portfolio ${trendClass}`}
          d={projectionPortfolio}
          markerEnd="url(#trend-portfolio-arrow)"
        />
        <path
          className="trend-projection-invested"
          d={projectionInvested}
          markerEnd="url(#trend-invested-arrow)"
        />
        <circle
          className={`wealth-point active ${trendClass}`}
          cx={historyEnd}
          cy={y(valueOf(history.at(-1)!))}
          r="4"
        />
        {hovered && (
          <>
            <line
              className="wealth-cursor"
              x1={hovered.x}
              x2={hovered.x}
              y1={top}
              y2={bottom}
            />
            <circle
              className={`wealth-point active ${valueOf(hovered.point) >= 0 ? "trend-up" : "trend-down"}`}
              cx={hovered.x}
              cy={y(valueOf(hovered.point))}
              r="5"
            />
          </>
        )}
        <text className="wealth-axis-date" x={left} y="310">
          {fullDate.format(new Date(`${history[0].date}T12:00:00`))}
        </text>
        <text
          className="wealth-axis-date trend-junction-date"
          x={historyEnd}
          y="310"
        >
          {fullDate.format(new Date(`${history.at(-1)!.date}T12:00:00`))}
        </text>
        <text className="wealth-axis-date end" x={right} y="310">
          {fullDate.format(new Date(`${projection.at(-1)!.date}T12:00:00`))}
        </text>
      </svg>
      {hovered && (
        <div
          className="wealth-tooltip trend-tooltip"
          style={{
            left: `${hovered.x / 10}%`,
            top: `${Math.max(6, y(valueOf(hovered.point)) / 3.2 - 18)}%`,
          }}
        >
          <span>
            {hovered.projected ? "Předpověď" : "Historie"} ·{" "}
            {fullDate.format(new Date(`${hovered.point.date}T12:00:00`))}
          </span>
          <strong>
            {target === "portfolio" ? "Hodnota" : "Čisté jmění"}{" "}
            {czk.format(valueOf(hovered.point))}
          </strong>
          <small>
            {target === "portfolio" ? "Investováno" : "Dluhy"}{" "}
            {czk.format(comparisonOf(hovered.point))}
          </small>
        </div>
      )}
    </div>
  );
}
