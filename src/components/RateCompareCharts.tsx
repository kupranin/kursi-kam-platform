// Buy vs sell for the current rates board. One chart per pair, so a ruble
// rate and a euro cross are not drawn on the same scale. Each bar is one
// source's own stored rate, per 1 unit. Sources are never averaged.

import { fmtRate } from '../lib/format';
import { useI18n } from '../lib/i18n';
import type { CurrentBoard } from '../lib/rateGrid';

interface Side {
  key: string;
  label: string;
  buy: number | null;
  sell: number | null;
}

function shown(value: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function pairSides(board: CurrentBoard, index: number): Side[] {
  return board.rows.flatMap((row) => {
    const quote = row.quotes[index];
    if (!quote) return [];
    const buy = shown(quote.buy);
    const sell = shown(quote.sell);
    if (buy == null && sell == null) return [];
    return [{ key: row.key, label: row.label, buy, sell }];
  });
}

/** Scale for one pair. Padded past the lowest and highest rate so a small spread still shows. */
function pairScale(values: number[]): { floor: number; ceiling: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const pad = span > 0 ? span * 0.4 : max * 0.02;
  return { floor: Math.max(0, min - pad), ceiling: max + pad };
}

function barPercent(value: number, floor: number, ceiling: number): number {
  const span = ceiling - floor;
  if (!(span > 0)) return 0;
  const pct = ((value - floor) / span) * 100;
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

function SideBar({
  word,
  value,
  kind,
  floor,
  ceiling,
}: {
  word: string;
  value: number | null;
  kind: 'buy' | 'sell';
  floor: number;
  ceiling: number;
}) {
  return (
    <div className="rate-chart-side" aria-hidden={value == null ? true : undefined}>
      <span className="rate-chart-word">{word}</span>
      <span className={value == null ? 'rate-chart-track is-empty' : 'rate-chart-track'} aria-hidden="true">
        {value != null && (
          <span className={kind === 'buy' ? 'is-buy' : 'is-sell'} style={{ width: barPercent(value, floor, ceiling) + '%' }} />
        )}
      </span>
      <span className="rate-chart-num">{value == null ? '' : fmtRate(value)}</span>
    </div>
  );
}

function PairChart({ pair, sides, buyWord, sellWord }: { pair: string; sides: Side[]; buyWord: string; sellWord: string }) {
  const values = sides.flatMap((side) => [side.buy, side.sell].filter((value): value is number => value != null));
  if (!values.length) return null;
  const scale = pairScale(values);
  return (
    <div className="rate-chart">
      <h3>{pair}</h3>
      <ul>
        {sides.map((side) => (
          <li key={side.key}>
            <div className="rate-chart-source">{side.label}</div>
            <SideBar word={buyWord} value={side.buy} kind="buy" floor={scale.floor} ceiling={scale.ceiling} />
            <SideBar word={sellWord} value={side.sell} kind="sell" floor={scale.floor} ceiling={scale.ceiling} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function RateCompareCharts({ board }: { board: CurrentBoard }) {
  const { t } = useI18n();
  const charts = board.pairs
    .map((pair, index) => ({ pair, sides: pairSides(board, index) }))
    .filter((chart) => chart.sides.length > 0);
  if (!charts.length) return null;

  const buyWord = t('ყიდვა', 'Buy');
  const sellWord = t('გაყიდვა', 'Sell');

  return (
    <section className="card rate-compare" aria-labelledby="rate-compare-title">
      <div className="card-head">
        <div>
          <h2 id="rate-compare-title">{t('ყიდვა და გაყიდვა', 'Buy and sell')}</h2>
          <p className="small muted">
            {t(
              '1 ერთეულზე, მათ შორის რუბლი. ყიდვა — ვყიდულობთ, როცა კლიენტი ყიდის. თითო წყვილს თავისი დიაგრამა აქვს და წყაროები ცალ-ცალკეა.',
              'Per 1 unit, including the ruble. Buy is when the client sells to Kursi. Each pair has its own chart, and each source keeps its own rate.',
            )}
          </p>
        </div>
      </div>
      <div className="legend">
        <span><i style={{ background: 'var(--aubergine)' }} />{buyWord}</span>
        <span><i style={{ background: 'var(--gold)' }} />{sellWord}</span>
      </div>
      <p className="tiny muted scale-note">
        {t(
          'შკალა თითო წყვილზეა და ნულიდან არ იწყება, რომ ყიდვა და გაყიდვა ერთმანეთისგან ჩანდეს. ციფრი ზოლის ბოლოს იმავე კურსია, რაც ცხრილში.',
          'Each pair has its own scale, and the scale does not start at zero, so buy and sell can be told apart. The figure at the end of a bar is the same rate as in the table.',
        )}
      </p>
      <div className="rate-charts">
        {charts.map((chart) => (
          <PairChart key={chart.pair} pair={chart.pair} sides={chart.sides} buyWord={buyWord} sellWord={sellWord} />
        ))}
      </div>
    </section>
  );
}
