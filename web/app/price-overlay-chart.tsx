"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  alignToSessions,
  crosshairStops,
  indexTo100,
  layoutOverlay,
  linePath,
  nearestStop,
  niceTicks,
  toSessions,
  type ClusterSpan,
  type LaneTrade,
  type OverlayLayout,
  type Session,
  type Source,
} from "@/lib/price-overlay";
import type { PriceSeries } from "@/lib/prices";
import { dayNumber, isoFromDay } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import { TIP_SURFACE } from "./charts";
import { ScrollX } from "./scroll-area";

/**
 * The price overlay's interactive half: daily closes fetched from
 * `/api/prices/<SYMBOL>` and drawn on the same calendar axis as the trade
 * lanes the server prepared (app/price-overlay.tsx). SVG, no chart library.
 *
 * - Price panel: the close as a 2px dark-grey line (not the ink, which
 *   means "bought"); "vs SPY" rebases both lines to 100 on one axis (never
 *   a second scale) and draws SPY in the mid grey, dashed.
 * - One lane per population, each with its own label: buys (ink) above the
 *   lane's centre line, sells (silver) below, "bought" / "sold" printed at
 *   the lane's start. Never pooled.
 * - Shaded spans: windows where the cluster rule for that population held,
 *   washed over the price panel and marked as a bar over their own lane. A
 *   buying cluster is a flat grey wash and a solid bar; a selling cluster a
 *   diagonal hatch and a dashed bar — texture, not tone, plus the words in
 *   the legend and the readout.
 * - The crosshair stops at every session and at every trade date that is not
 *   one; the readout gives the date, the close (or why there is none) and the
 *   trades of that date. Arrow keys walk the same stops.
 *
 * Two layouts, like the trade timeline: a wide one from `sm` (scrolls a
 * little on a narrow tablet) and a compressed phone one that fits 390px.
 */

export type OverlayLane = { source: Source; label: string; trades: LaneTrade[] };

type Props = {
  symbol: string;
  /** False when the symbol cannot be priced at all (shape): no request is made. */
  priceable: boolean;
  fromYear: number;
  lo: string;
  hi: string;
  lanes: OverlayLane[];
  spans: ClusterSpan[];
};

type Load = { state: "loading" } | { state: "done"; series: PriceSeries };

const LAYOUTS = [
  { key: "wide", width: 1040, priceHeight: 200, laneHalf: 46, className: "hidden sm:block w-full min-w-[820px]" },
  { key: "phone", width: 352, priceHeight: 150, laneHalf: 36, className: "sm:hidden w-full" },
] as const;

const BENCH = "SPY";

function usePrices(symbol: string, fromYear: number, enabled: boolean): Load | null {
  const [load, setLoad] = useState<Load | null>(enabled ? { state: "loading" } : null);
  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    setLoad({ state: "loading" });
    fetch(`/api/prices/${encodeURIComponent(symbol)}?from=${fromYear}`, { signal: ctl.signal })
      .then(async (r) => {
        const body = (await r.json().catch(() => null)) as PriceSeries | null;
        setLoad({
          state: "done",
          series: body && Array.isArray(body.closes) ? body : { symbol, source: null, status: "unavailable", closes: [] },
        });
      })
      .catch((err) => {
        if ((err as Error).name === "AbortError") return;
        setLoad({ state: "done", series: { symbol, source: null, status: "unavailable", closes: [] } });
      });
    return () => ctl.abort();
  }, [symbol, fromYear, enabled]);
  return load;
}

export function PriceOverlayChart({ symbol, priceable, fromYear, lo, hi, lanes, spans }: Props) {
  const [mode, setMode] = useState<"price" | "relative">("price");
  const main = usePrices(symbol, fromYear, priceable);
  const bench = usePrices(BENCH, fromYear, priceable && mode === "relative" && symbol !== BENCH);
  const [active, setActive] = useState<number | null>(null);
  const [tipAt, setTipAt] = useState<{ left: number; top: number } | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const svgs = useRef<Record<string, SVGSVGElement | null>>({});

  const loDay = dayNumber(lo)!;
  const hiDay = dayNumber(hi)!;
  const sessions = useMemo(
    () => (main?.state === "done" ? toSessions(main.series.closes) : []),
    [main]
  );
  const benchSessions = useMemo(
    () => (bench?.state === "done" ? toSessions(bench.series.closes) : []),
    [bench]
  );

  // The plotted series: closes, or both rebased to 100 at the first session
  // both have inside the chart.
  const relative = mode === "relative" && sessions.length > 0 && benchSessions.length > 0;
  const plotted = useMemo(() => {
    const inView = (s: Session[]) => s.filter((x) => x.day >= loDay && x.day <= hiDay);
    if (!relative) return { main: inView(sessions), bench: [] as Session[] };
    const firstMain = inView(sessions)[0]?.day;
    const firstBench = inView(benchSessions)[0]?.day;
    if (firstMain == null || firstBench == null) return { main: inView(sessions), bench: [] as Session[] };
    const base = Math.max(firstMain, firstBench);
    return { main: inView(indexTo100(sessions, base)), bench: inView(indexTo100(benchSessions, base)) };
  }, [relative, sessions, benchSessions, loDay, hiDay]);

  const layouts = useMemo(
    () =>
      LAYOUTS.map((l) => ({
        ...l,
        layout: layoutOverlay({ width: l.width, priceHeight: l.priceHeight, laneHalf: l.laneHalf, lo, hi, lanes }),
      })),
    [lo, hi, lanes]
  );

  const tradesByDay = useMemo(() => {
    const m = new Map<number, { lane: OverlayLane; trade: LaneTrade }[]>();
    for (const lane of lanes)
      for (const trade of lane.trades) {
        const d = dayNumber(trade.date);
        if (d == null || d < loDay || d > hiDay) continue;
        const list = m.get(d) ?? [];
        list.push({ lane, trade });
        m.set(d, list);
      }
    return m;
  }, [lanes, loDay, hiDay]);

  const stops = useMemo(
    () => crosshairStops(sessions, [...tradesByDay.keys()], loDay, hiDay),
    [sessions, tradesByDay, loDay, hiDay]
  );

  const yRange = useMemo(() => {
    const vals = [...plotted.main, ...plotted.bench].map((s) => s.close);
    if (!vals.length) return null;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const ticks = niceTicks(min, max, 4);
    return { min: Math.min(min, ticks[0] ?? min), max: Math.max(max, ticks[ticks.length - 1] ?? max), ticks };
  }, [plotted]);

  const tradeDays = useMemo(() => [...tradesByDay.keys()].sort((a, b) => a - b), [tradesByDay]);

  const visibleSvg = (): { svg: SVGSVGElement; layout: OverlayLayout } | null => {
    for (const l of layouts) {
      const svg = svgs.current[l.key];
      if (svg && svg.getBoundingClientRect().width > 0) return { svg, layout: l.layout };
    }
    return null;
  };

  const place = (day: number, from?: { svg: SVGSVGElement; layout: OverlayLayout }) => {
    const v = from ?? visibleSvg();
    const box = wrap.current;
    if (!v || !box) return;
    const r = v.svg.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const scale = r.width / v.layout.width;
    setTipAt({ left: r.left - b.left + v.layout.x(day) * scale, top: r.top - b.top + v.layout.priceTop * scale });
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>, layout: OverlayLayout) => {
    const svg = e.currentTarget;
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) * layout.width) / r.width;
    if (px < layout.plotLeft - 8 || px > layout.plotRight + 8) return;
    const i = nearestStop(stops, layout.dayAt(px));
    if (i == null) return;
    setActive(stops[i]);
    place(stops[i], { svg, layout });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!stops.length) return;
    const cur = active == null ? -1 : stops.indexOf(active);
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const dir = e.key === "ArrowRight" ? 1 : -1;
      if (e.shiftKey) {
        // Jump to the next date that has trades.
        const from = active ?? (dir > 0 ? loDay - 1 : hiDay + 1);
        const cand = dir > 0 ? tradeDays.find((d) => d > from) : [...tradeDays].reverse().find((d) => d < from);
        next = cand ?? null;
      } else {
        const idx = cur < 0 ? (dir > 0 ? 0 : stops.length - 1) : Math.min(Math.max(cur + dir, 0), stops.length - 1);
        next = stops[idx];
      }
    } else if (e.key === "Home") next = stops[0];
    else if (e.key === "End") next = stops[stops.length - 1];
    else if (e.key === "Escape") {
      setActive(null);
      setTipAt(null);
      return;
    } else return;
    e.preventDefault();
    if (next != null) {
      setActive(next);
      place(next);
    }
  };

  const readout = active != null ? buildReadout(active, symbol, relative, plotted, sessions, tradesByDay, spans) : null;
  const status = priceStatus(symbol, priceable, main);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-[12px] text-muted-foreground">
        {status ? null : (
          <LineKey color="var(--viz-price)" label={relative ? `${symbol}, first session = 100` : `${symbol} daily close`} />
        )}
        {relative ? <LineKey color="var(--viz-bench)" dashed label={`${BENCH}, first session = 100`} /> : null}
        {(["buy", "sell"] as const)
          .filter((side) => spans.some((s) => s.side === side))
          .map((side) => (
            <span key={side} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="h-2.5 w-3.5 rounded-[2px] ring-1 ring-inset ring-border" style={WASH_KEY[side]} />
              shaded: {side === "buy" ? "buying" : "selling"} cluster
            </span>
          ))}
        <span title="Mark area grows with the bracket floor (members) or with shares × reported price (insiders), on a log scale — never a midpoint or a guessed amount.">
          size ={" "}
          {lanes
            .map((l) => (l.source === "congress" ? "bracket floor (members)" : "shares × reported price (insiders)"))
            .join(" · ")}
        </span>
        {priceable && symbol !== BENCH && !(main?.state === "done" && status) ? (
          <div role="group" aria-label="Price scale" className="inline-flex rounded-control p-0.5 ring-1 ring-inset ring-border sm:ml-auto">
            {(["price", "relative"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  "rounded-chip px-2 py-0.5 text-[12px] font-medium",
                  mode === m ? "bg-foreground text-background" : "text-ink-2 hover:bg-secondary hover:text-foreground"
                )}
              >
                {m === "price" ? "Price" : `vs ${BENCH}`}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div ref={wrap} className="relative">
        <ScrollX>
          {layouts.map((l) => (
            <svg
              key={l.key}
              ref={(el) => {
                svgs.current[l.key] = el;
              }}
              viewBox={`0 0 ${l.layout.width} ${l.layout.height}`}
              className={cn("po-plot h-auto select-none", l.className)}
              role="group"
              tabIndex={0}
              aria-label={`${symbol}: daily closes with ${lanes.map((x) => x.label).join(" and ")} trades by trade date. Arrow keys move between dates; Shift+arrow jumps to the next date with trades.`}
              aria-describedby={`po-live-${symbol}`}
              onPointerMove={(e) => onMove(e, l.layout)}
              onPointerDown={(e) => onMove(e, l.layout)}
              onPointerLeave={() => {
                setActive(null);
                setTipAt(null);
              }}
              onKeyDown={onKey}
              onBlur={() => {
                setActive(null);
                setTipAt(null);
              }}
            >
              <OverlaySvg
                layout={l.layout}
                compact={l.key === "phone"}
                plotted={plotted}
                yRange={yRange}
                relative={relative}
                status={status}
                lanes={lanes}
                spans={spans}
                active={active}
                sessions={sessions}
              />
            </svg>
          ))}
        </ScrollX>
        {readout && tipAt ? <Tooltip readout={readout} at={tipAt} width={wrap.current?.clientWidth ?? 0} /> : null}
        <div id={`po-live-${symbol}`} className="sr-only" aria-live="polite">
          {readout ? [readout.title, readout.value, ...readout.lines.map((l) => l.text)].join(". ") : ""}
        </div>
      </div>
      {main?.state === "done" && main.series.source === "stored" ? (
        <p className="mt-2 px-1 text-[12px] text-muted-foreground">
          The price source did not answer; the line shows only the closes the pipeline already stored for this symbol.
        </p>
      ) : null}
    </div>
  );
}

function LineKey({ color, label, dashed = false }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="h-0.5 w-4 rounded-full"
        style={{ background: dashed ? `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)` : color }}
      />
      <span className="text-ink-2">{label}</span>
    </span>
  );
}

/** The legend swatches for the two cluster washes: flat (buying), hatched (selling). */
const WASH_KEY: Record<"buy" | "sell", React.CSSProperties> = {
  buy: { background: "color-mix(in oklab, var(--viz-buy) 10%, transparent)" },
  sell: { backgroundImage: "repeating-linear-gradient(135deg, var(--viz-axis) 0 1px, transparent 1px 4px)" },
};

/* --------------------------------------------------------------- the svg */

function priceStatus(symbol: string, priceable: boolean, load: Load | null): string | null {
  if (!priceable) return `No price series: ${symbol} is not a symbol the price source lists.`;
  if (!load || load.state === "loading") return "Loading daily closes…";
  const s = load.series;
  if (s.status === "ok" && s.closes.length) return null;
  if (s.status === "unavailable") return "The price source did not answer — trades are shown without a price line.";
  return `No price series for ${symbol} from the source (unknown, delisted, or not listed there).`;
}

function OverlaySvg({
  layout,
  compact,
  plotted,
  yRange,
  relative,
  status,
  lanes,
  spans,
  active,
  sessions,
}: {
  layout: OverlayLayout;
  compact: boolean;
  plotted: { main: Session[]; bench: Session[] };
  yRange: { min: number; max: number; ticks: number[] } | null;
  relative: boolean;
  status: string | null;
  lanes: OverlayLane[];
  spans: ClusterSpan[];
  active: number | null;
  sessions: Session[];
}) {
  const { x, plotLeft, plotRight, priceTop, priceBottom, axisY } = layout;
  const y = (v: number) =>
    yRange ? priceBottom - ((v - yRange.min) / (yRange.max - yRange.min || 1)) * (priceBottom - priceTop - 6) - 3 : priceBottom;
  const spanX = (s: ClusterSpan) => {
    const a = Math.max(dayNumber(s.start)!, layout.lo);
    const b = Math.min(dayNumber(s.end)!, layout.hi);
    const x0 = x(a);
    const x1 = Math.max(x(b), x0 + 3);
    return { x0, w: x1 - x0 };
  };
  const at = active != null ? alignToSessions(active, sessions) : null;
  const activeClose = (list: Session[]) => (active == null ? null : list.find((s) => s.day === active) ?? null);
  // Two SVGs (wide and phone) render at once, so the hatch needs its own id.
  const hatch = `po-hatch-${useId().replace(/:/g, "")}`;

  return (
    <>
      <defs>
        <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" className="po-hatch-line" />
        </pattern>
      </defs>
      {/* Cluster washes over the price panel, under everything else: a
          buying cluster flat, a selling cluster hatched. */}
      {spans.map((s, i) => {
        const { x0, w } = spanX(s);
        return s.side === "buy" ? (
          <rect key={`w${i}`} x={x0} y={priceTop} width={w} height={priceBottom - priceTop} className="po-wash-buy" />
        ) : (
          <rect key={`w${i}`} x={x0} y={priceTop} width={w} height={priceBottom - priceTop} fill={`url(#${hatch})`} />
        );
      })}

      {/* Month gridlines across every panel; labels under the axis. */}
      {layout.ticks.map((t) => (
        <g key={t.x}>
          <line x1={t.x} x2={t.x} y1={priceTop} y2={axisY} stroke="var(--viz-grid)" strokeWidth="1" />
          {t.x + 26 <= layout.width ? (
            <>
              <text x={t.x + 3} y={axisY + 15} className="tl-tick" style={{ fontSize: 12 }}>
                {t.label}
              </text>
              {t.year ? (
                <text x={t.x + 3} y={axisY + 28} className="tl-tick tl-tick-sub" style={{ fontSize: 11 }}>
                  {t.year}
                </text>
              ) : null}
            </>
          ) : null}
        </g>
      ))}
      <line x1={plotLeft} x2={plotRight} y1={axisY} y2={axisY} stroke="var(--viz-axis)" strokeWidth="1" />

      {/* Price panel: hairline value grid, the line(s), or why there is none. */}
      {yRange && !status
        ? yRange.ticks.map((v) => (
            <g key={v}>
              <line x1={plotLeft} x2={plotRight} y1={y(v)} y2={y(v)} stroke="var(--viz-grid)" strokeWidth="1" />
              <text x={plotLeft - 6} y={y(v) + 4} textAnchor="end" className="tl-tick" style={{ fontSize: 12 }}>
                {relative ? fmtIndex(v) : fmtAxisPrice(v, yRange.ticks)}
              </text>
            </g>
          ))
        : null}
      <line x1={plotLeft} x2={plotRight} y1={priceBottom} y2={priceBottom} stroke="var(--viz-grid)" strokeWidth="1" />
      {status ? (
        <text x={(plotLeft + plotRight) / 2} y={(priceTop + priceBottom) / 2} textAnchor="middle" className="po-note">
          {compact ? wrapText(status, 44).map((line, i) => (
            <tspan key={i} x={(plotLeft + plotRight) / 2} dy={i ? 16 : 0}>
              {line}
            </tspan>
          )) : status}
        </text>
      ) : (
        <>
          {plotted.bench.length ? (
            <path d={linePath(plotted.bench, x, y, layout.lo, layout.hi)} fill="none" stroke="var(--viz-bench)" strokeWidth="2" strokeDasharray="5 4" strokeLinejoin="round" />
          ) : null}
          <path d={linePath(plotted.main, x, y, layout.lo, layout.hi)} fill="none" stroke="var(--viz-price)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        </>
      )}

      {/* Lanes: label, cluster bars, centre line, marks. */}
      {layout.lanes.map((lane, li) => {
        const meta = lanes[li];
        const laneSpans = spans.filter((s) => s.source === lane.source);
        return (
          <g key={lane.source}>
            {laneSpans.map((s, i) => {
              const { x0, w } = spanX(s);
              return s.side === "buy" ? (
                <rect key={i} x={x0} y={lane.top - 7} width={w} height={3} rx={1.5} className="po-span-buy" />
              ) : (
                <line key={i} x1={x0} x2={x0 + w} y1={lane.top - 1.5} y2={lane.top - 1.5} className="po-span-sell" />
              );
            })}
            <text x={plotLeft} y={lane.top - 10} className="po-lane-label">
              {meta.label}
            </text>
            <line x1={plotLeft} x2={plotRight} y1={lane.mid} y2={lane.mid} stroke="var(--viz-axis)" strokeWidth="1" />
            <text x={plotLeft - 6} y={lane.mid - 6} textAnchor="end" className="tl-tick" style={{ fontSize: 11 }}>
              bought
            </text>
            <text x={plotLeft - 6} y={lane.mid + 14} textAnchor="end" className="tl-tick" style={{ fontSize: 11 }}>
              sold
            </text>
            {lane.marks.map((m) =>
              m.trade.hollow ? (
                <g key={m.trade.id}>
                  <circle className="tl-dot tl-blank" cx={m.x} cy={m.y} r={m.r} />
                  <circle className={`tl-hollow tl-${m.trade.side}`} cx={m.x} cy={m.y} r={m.r} />
                </g>
              ) : (
                <circle key={m.trade.id} className={`tl-dot tl-${m.trade.side}`} cx={m.x} cy={m.y} r={m.r} />
              )
            )}
            {lane.overflow.map((o) => (
              <text
                key={`${o.side}${o.x}`}
                x={Math.min(Math.max(o.x, plotLeft + 10), plotRight - 10)}
                y={o.side === "buy" ? lane.top + 10 : lane.bottom - 2}
                textAnchor="middle"
                className="tl-more"
                style={{ fontSize: 11 }}
              >
                +{o.count}
              </text>
            ))}
          </g>
        );
      })}

      {/* Crosshair and the close it rests on. */}
      {active != null ? (
        <g pointerEvents="none">
          <line x1={x(active)} x2={x(active)} y1={priceTop} y2={axisY} stroke="var(--foreground)" strokeOpacity="0.45" strokeWidth="1" />
          {!status && at?.at != null
            ? [
                { s: activeClose(plotted.bench), c: "var(--viz-bench)" },
                { s: activeClose(plotted.main), c: "var(--viz-price)" },
              ].map(({ s, c }, i) =>
                s ? <circle key={i} cx={x(s.day)} cy={y(s.close)} r={4} fill={c} stroke="var(--card-solid)" strokeWidth={2} /> : null
              )
            : null}
        </g>
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------------- readout */

type Readout = { title: string; value: string; sub: string | null; lines: { text: string; side?: string; head?: boolean }[] };

const LANE_LIMIT = 5;

function buildReadout(
  day: number,
  symbol: string,
  relative: boolean,
  plotted: { main: Session[]; bench: Session[] },
  sessions: Session[],
  tradesByDay: Map<number, { lane: OverlayLane; trade: LaneTrade }[]>,
  spans: ClusterSpan[]
): Readout {
  const title = longDate(day);
  let value: string;
  let sub: string | null = null;
  const at = alignToSessions(day, sessions);
  if (!sessions.length) {
    value = "No price series";
  } else if (at.at != null) {
    if (relative) {
      const m = plotted.main.find((s) => s.day === day);
      const b = plotted.bench.find((s) => s.day === day);
      value = m ? `${symbol} ${fmtIndex(m.close, 1)}` : `${symbol} —`;
      sub = b ? `${BENCH} ${fmtIndex(b.close, 1)} · both rebased to 100` : null;
    } else {
      value = `${fmtPrice(sessions[at.at].close)} close`;
    }
  } else {
    value = at.next == null ? "No final close yet" : "No session that day";
    const parts = [
      at.prev != null ? `prev ${shortDay(sessions[at.prev].day)} ${fmtPrice(sessions[at.prev].close)}` : null,
      at.next != null ? `next ${shortDay(sessions[at.next].day)} ${fmtPrice(sessions[at.next].close)}` : null,
    ].filter(Boolean);
    sub = parts.length ? `Closes: ${parts.join(" · ")}` : null;
  }

  const lines: Readout["lines"] = [];
  const here = tradesByDay.get(day) ?? [];
  const sources = [...new Set(here.map((h) => h.lane))];
  for (const lane of sources) {
    const list = here.filter((h) => h.lane === lane);
    lines.push({ text: `${lane.label} · ${list.length} trade${list.length === 1 ? "" : "s"}`, head: true });
    for (const h of list.slice(0, LANE_LIMIT)) {
      const verb = h.trade.side === "buy" ? "Bought" : h.trade.side === "sell" ? "Sold" : "Other";
      lines.push({ text: `${verb} · ${h.trade.who} · ${h.trade.amount}`, side: h.trade.side });
    }
    if (list.length > LANE_LIMIT) lines.push({ text: `+${list.length - LANE_LIMIT} more` });
  }
  for (const s of spans) {
    const a = dayNumber(s.start)!;
    const b = dayNumber(s.end)!;
    if (day < a || day > b) continue;
    const who = s.source === "congress" ? "members" : "insiders";
    const window = s.source === "congress" ? 90 : 30;
    lines.push({
      text: `Shaded: ${s.source === "congress" ? "congressional" : "insider"} ${s.side === "buy" ? "buying" : "selling"} cluster, ${shortDay(a)} – ${shortDay(b)} (up to ${s.peak} ${who} within ${window} days)`,
    });
  }
  return { title, value, sub, lines };
}

function Tooltip({ readout, at, width }: { readout: Readout; at: { left: number; top: number }; width: number }) {
  // Beside the crosshair, on the side with more room, so it never hides the
  // close it is reading out. On a phone it may cover part of the line.
  const onRight = at.left < width / 2;
  const style: React.CSSProperties = onRight
    ? { left: Math.max(at.left + 12, 0), top: at.top + 4 }
    : { right: Math.max(width - at.left + 12, 0), top: at.top + 4 };
  return (
    <div
      aria-hidden
      className={cn(TIP_SURFACE, "pointer-events-none absolute z-20 w-max max-w-[min(320px,85vw)] px-3 py-2")}
      style={style}
    >
      <div className="text-muted-foreground">{readout.title}</div>
      <div className="tabular text-[13px] font-semibold text-foreground">{readout.value}</div>
      {readout.sub ? <div className="tabular text-muted-foreground">{readout.sub}</div> : null}
      {readout.lines.map((l, i) => (
        <div key={i} className={cn("flex items-start gap-1.5", l.head ? "mt-1.5 font-medium text-ink-2" : "text-muted-foreground")}>
          {l.side ? (
            <span
              aria-hidden
              className="mt-[5px] size-2 shrink-0 rounded-full"
              style={{ background: l.side === "buy" ? "var(--viz-buy)" : l.side === "sell" ? "var(--viz-sell)" : "var(--viz-seq)" }}
            />
          ) : null}
          <span className="min-w-0">{l.text}</span>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- formatting */

function fmtPrice(v: number): string {
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtAxisPrice(v: number, ticks: number[]): string {
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : v;
  if (v >= 10_000) return `$${Math.round(v / 1000)}k`;
  const digits = step < 1 ? 2 : step < 10 && !Number.isInteger(v) ? 1 : 0;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function fmtIndex(v: number, digits = 0): string {
  return v.toFixed(digits);
}

const DATE_LONG = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const DATE_SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const DATE_SHORT_Y = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function longDate(day: number): string {
  return DATE_LONG.format(new Date(`${isoFromDay(day)}T00:00:00Z`));
}

function shortDay(day: number): string {
  const d = new Date(`${isoFromDay(day)}T00:00:00Z`);
  return (d.getUTCFullYear() === new Date().getUTCFullYear() ? DATE_SHORT : DATE_SHORT_Y).format(d);
}

function wrapText(s: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of s.split(" ")) {
    if (line && (line + " " + w).length > width) {
      out.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}
