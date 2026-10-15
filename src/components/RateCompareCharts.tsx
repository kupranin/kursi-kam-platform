// Competitive position for USD/GEL, EUR/GEL and RUB/GEL.
// Rates are the stored board quotes. Differences are subtractions of those quotes.
// Buy is the rate when a client sells currency to the bureau (higher is the better buy).
// Sell is the rate when the bureau sells currency to the client (lower is the better sell).

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { fmtRate } from '../lib/format';
import { useI18n } from '../lib/i18n';
import type { CurrentBoard } from '../lib/rateGrid';

const FOCUS_PAIRS = ['USD/GEL', 'EUR/GEL', 'RUB/GEL'] as const;
type FocusPair = (typeof FOCUS_PAIRS)[number];
type Tr = (ka: string, en: string, vars?: Record<string, string | number>) => string;
type Standing = 'ahead' | 'tied' | 'behind' | 'only' | 'nokursi' | 'none';

interface ProviderPoint {
  key: string;
  label: string;
  kursi: boolean;
  buy: number | null;
  sell: number | null;
  spread: number | null;
  buyDiff: number | null;
  sellDiff: number | null;
}

interface PairModel {
  pair: FocusPair;
  providers: ProviderPoint[];
  hasKursi: boolean;
  levelMin: number | null;
  levelMax: number | null;
  bestBuy: number | null;
  bestSell: number | null;
  bestBuyLabels: string[];
  bestSellLabels: string[];
  buyMin: number | null;
  buyMax: number | null;
  sellMin: number | null;
  sellMax: number | null;
  buyStanding: Standing;
  sellStanding: Standing;
  diffLimit: number;
}

function shown(value: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function sameRate(a: number, b: number): boolean {
  return a.toFixed(5) === b.toFixed(5);
}

/** Subtraction of two stored rates, at the same five decimals the table prints. */
function gap(from: number, base: number): number {
  const text = (from - base).toFixed(5);
  if (text === '0.00000' || text === '-0.00000') return 0;
  return Number(text);
}

function fmtSigned(value: number): string {
  const text = value.toFixed(5);
  if (text === '0.00000' || text === '-0.00000') return '0.00000';
  return text.startsWith('-') ? '−' + text.slice(1) : '+' + text;
}

function posPct(value: number, min: number, max: number): number {
  const span = max - min;
  if (!(span > 0)) return 50;
  const pct = ((value - min) / span) * 100;
  if (!Number.isFinite(pct)) return 50;
  return Math.min(100, Math.max(0, pct));
}

function barBox(diff: number, limit: number): { left: string; width: string } | null {
  if (!(limit > 0) || diff === 0) return null;
  const pct = (diff / limit) * 50;
  if (!Number.isFinite(pct) || pct === 0) return null;
  if (pct > 0) return { left: '50%', width: pct + '%' };
  return { left: (50 + pct) + '%', width: (-pct) + '%' };
}

function sideStanding(kursiRate: number | null, rates: number[], kursiIsBest: boolean, bestCount: number): Standing {
  if (!rates.length) return 'none';
  if (kursiRate == null) return 'nokursi';
  if (rates.length === 1) return 'only';
  if (!kursiIsBest) return 'behind';
  return bestCount > 1 ? 'tied' : 'ahead';
}

function labelsFor(providers: ProviderPoint[], side: 'buy' | 'sell', best: number | null): string[] {
  if (best == null) return [];
  return providers.filter((p) => {
    const value = p[side];
    return value != null && sameRate(value, best);
  }).map((p) => p.label);
}

function buildPair(board: CurrentBoard, pair: FocusPair): PairModel {
  const index = board.pairs.indexOf(pair);
  const kursiRow = index < 0 ? undefined : board.rows.find((row) => row.key === 'kursi');
  const kursiBuy = kursiRow ? shown(kursiRow.quotes[index]?.buy ?? null) : null;
  const kursiSell = kursiRow ? shown(kursiRow.quotes[index]?.sell ?? null) : null;
  const providers: ProviderPoint[] = [];
  if (index >= 0) {
    for (const row of board.rows) {
      const quote = row.quotes[index];
      if (!quote) continue;
      const buy = shown(quote.buy);
      const sell = shown(quote.sell);
      if (buy == null && sell == null) continue;
      const kursi = row.key === 'kursi';
      providers.push({
        key: row.key,
        label: kursi ? 'Kursi.ge' : row.label,
        kursi,
        buy,
        sell,
        spread: buy != null && sell != null ? sell - buy : null,
        buyDiff: kursi ? (buy == null ? null : 0) : (buy != null && kursiBuy != null ? gap(buy, kursiBuy) : null),
        sellDiff: kursi ? (sell == null ? null : 0) : (sell != null && kursiSell != null ? gap(sell, kursiSell) : null),
      });
    }
  }
  const buys = providers.flatMap((p) => (p.buy == null ? [] : [p.buy]));
  const sells = providers.flatMap((p) => (p.sell == null ? [] : [p.sell]));
  const levels = providers.flatMap((p) => [p.buy, p.sell].filter((n): n is number => n != null));
  const bestBuy = buys.length ? Math.max(...buys) : null;
  const bestSell = sells.length ? Math.min(...sells) : null;
  const bestBuyLabels = labelsFor(providers, 'buy', bestBuy);
  const bestSellLabels = labelsFor(providers, 'sell', bestSell);
  const kursi = providers.find((p) => p.kursi);
  const diffs = providers.filter((p) => !p.kursi).flatMap((p) => [p.buyDiff, p.sellDiff].filter((n): n is number => n != null));
  const diffLimit = diffs.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  return {
    pair,
    providers,
    hasKursi: !!kursi,
    levelMin: levels.length ? Math.min(...levels) : null,
    levelMax: levels.length ? Math.max(...levels) : null,
    bestBuy,
    bestSell,
    bestBuyLabels,
    bestSellLabels,
    buyMin: buys.length ? Math.min(...buys) : null,
    buyMax: buys.length ? Math.max(...buys) : null,
    sellMin: sells.length ? Math.min(...sells) : null,
    sellMax: sells.length ? Math.max(...sells) : null,
    buyStanding: sideStanding(kursi?.buy ?? null, buys, bestBuyLabels.includes('Kursi.ge'), bestBuyLabels.length),
    sellStanding: sideStanding(kursi?.sell ?? null, sells, bestSellLabels.includes('Kursi.ge'), bestSellLabels.length),
    diffLimit,
  };
}

function standingText(t: Tr, side: 'buy' | 'sell', standing: Standing): string {
  const buy = side === 'buy';
  if (standing === 'ahead') return buy ? t('ყიდვაზე წინაა', 'Ahead on buy') : t('გაყიდვაზე წინაა', 'Ahead on sell');
  if (standing === 'tied') return buy ? t('ყიდვაზე თანაბარია', 'Tied on buy') : t('გაყიდვაზე თანაბარია', 'Tied on sell');
  if (standing === 'behind') return buy ? t('ყიდვაზე უკანაა', 'Behind on buy') : t('გაყიდვაზე უკანაა', 'Behind on sell');
  if (standing === 'only') return buy ? t('ყიდვაზე მხოლოდ Kursi.ge', 'Buy: only Kursi.ge') : t('გაყიდვაზე მხოლოდ Kursi.ge', 'Sell: only Kursi.ge');
  if (standing === 'nokursi') return buy ? t('Kursi.ge-ს ყიდვა არ არის', 'No Kursi.ge buy') : t('Kursi.ge-ს გაყიდვა არ არის', 'No Kursi.ge sell');
  return buy ? t('ყიდვა არ არის', 'No buy') : t('გაყიდვა არ არის', 'No sell');
}

interface RowHandlers {
  'aria-expanded': boolean;
  'aria-describedby'?: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onClick: () => void;
}

function useTips() {
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const fine = useRef(false);
  useEffect(() => {
    fine.current = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest('.fx-row')) {
        setPinned(null);
        setHover(null);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPinned(null);
        setHover(null);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  const openId = hover ?? pinned;
  const bind = (id: string): RowHandlers => ({
    'aria-expanded': openId === id,
    'aria-describedby': openId === id ? 'fx-open-tip' : undefined,
    onMouseEnter() { if (fine.current) setHover(id); },
    onMouseLeave() { setHover((current) => (current === id ? null : current)); },
    onFocus() { setHover(id); },
    onBlur() { setHover((current) => (current === id ? null : current)); },
    onClick() { setPinned((current) => (current === id ? null : id)); },
  });
  return { openId, bind };
}

function Tip({ provider, kursiMissing }: { provider: ProviderPoint; kursiMissing: boolean }) {
  const { t } = useI18n();
  const buy = t('ყიდვა', 'Buy');
  const sell = t('გაყიდვა', 'Sell');
  const buyGap = provider.buyDiff == null ? '—' : fmtSigned(provider.buyDiff) + ' GEL';
  const sellGap = provider.sellDiff == null ? '—' : fmtSigned(provider.sellDiff) + ' GEL';
  return (
    <div className="fx-tip" id="fx-open-tip" role="tooltip">
      <div className="fx-tip-name">{provider.label}</div>
      <div>{buy} {provider.buy == null ? '—' : fmtRate(provider.buy)}</div>
      <div>{sell} {provider.sell == null ? '—' : fmtRate(provider.sell)}</div>
      {kursiMissing && !provider.kursi ? (
        <div>{t('Kursi.ge ამ წყვილზე არ არის', 'Kursi.ge has no rate on this pair')}</div>
      ) : (
        <div>{t('სხვაობა Kursi.ge-სთან', 'Difference vs Kursi.ge')}: {buy} {buyGap}, {sell} {sellGap}</div>
      )}
      {provider.spread != null && (
        <div>{t('სპრედი (გაყიდვა − ყიდვა)', 'Spread (sell minus buy)')} {fmtSigned(provider.spread)} GEL</div>
      )}
    </div>
  );
}

function Axis({ min, max }: { min: number; max: number }) {
  const flat = fmtRate(min) === fmtRate(max);
  return (
    <div className={flat ? 'fx-axis is-flat' : 'fx-axis'}>
      <span>{fmtRate(min)}</span>
      {!flat && <span>{fmtRate(max)}</span>}
    </div>
  );
}

function RateNum({ word, value, best, signed }: { word: string; value: number | null; best?: boolean; signed?: boolean }) {
  const { t } = useI18n();
  const text = value == null ? '—' : signed ? fmtSigned(value) : fmtRate(value);
  return (
    <span className={best ? 'fx-num is-best' : 'fx-num'}>
      <span className="sr-only">{word} </span>
      {text}
      {best && <span className="sr-only"> {t('საუკეთესო', 'Best')}</span>}
    </span>
  );
}

function PositionChart({ model, openId, bind }: { model: PairModel; openId: string | null; bind: (id: string) => RowHandlers }) {
  const { t } = useI18n();
  if (model.levelMin == null || model.levelMax == null) return null;
  const buyWord = t('ყიდვა', 'Buy');
  const sellWord = t('გაყიდვა', 'Sell');
  const flat = fmtRate(model.levelMin) === fmtRate(model.levelMax);
  return (
    <div className="fx-block">
      <h3>{t('პოზიცია ბაზარზე', 'Position in the market')}</h3>
      <p className="tiny muted fx-note">
        {t(
          'შკალის ბოლოები ამ წყვილის ყველაზე დაბალი და ყველაზე მაღალი კურსია. ნულიდან არ იწყება. ოქროს რგოლი საუკეთესო კურსია.',
          'The scale ends are this pair’s lowest and highest rates. It does not start at zero. A gold ring marks the best rate.',
        )}
      </p>
      <div className="fx-legend">
        <span><i className="fx-swatch is-buy-kursi" />{t('Kursi.ge ყიდვა', 'Kursi.ge buy')}</span>
        <span><i className="fx-swatch is-sell-kursi" />{t('Kursi.ge გაყიდვა', 'Kursi.ge sell')}</span>
        <span><i className="fx-swatch is-buy-other" />{t('სხვა ყიდვა', 'Other buy')}</span>
        <span><i className="fx-swatch is-sell-other" />{t('სხვა გაყიდვა', 'Other sell')}</span>
        <span><i className="fx-swatch is-best" />{t('საუკეთესო', 'Best')}</span>
      </div>
      <div className="fx-line fx-head" aria-hidden="true">
        <span className="fx-name" />
        <div className="fx-plot"><Axis min={model.levelMin} max={model.levelMax} /></div>
        <span className="fx-nums"><span className="fx-num">{buyWord}</span><span className="fx-num">{sellWord}</span></span>
      </div>
      <div className="fx-rows">
        {model.providers.map((provider) => {
          const id = 'pos:' + provider.key;
          const open = openId === id;
          const buyAt = provider.buy == null ? null : flat ? 50 : posPct(provider.buy, model.levelMin as number, model.levelMax as number);
          const sellAt = provider.sell == null ? null : flat ? 50 : posPct(provider.sell, model.levelMin as number, model.levelMax as number);
          const bestBuy = provider.buy != null && model.bestBuy != null && sameRate(provider.buy, model.bestBuy);
          const bestSell = provider.sell != null && model.bestSell != null && sameRate(provider.sell, model.bestSell);
          const spreadStyle: CSSProperties | null = buyAt == null || sellAt == null ? null : {
            left: Math.min(buyAt, sellAt) + '%',
            width: Math.abs(sellAt - buyAt) + '%',
          };
          return (
            <div key={provider.key} className={provider.kursi ? 'fx-row is-kursi' : 'fx-row'}>
              <button type="button" className="fx-line" {...bind(id)}>
                <span className="fx-name">{provider.label}</span>
                <span className="fx-plot">
                  <span className="fx-track" aria-hidden="true">
                    {!flat && spreadStyle && <span className="fx-spread-line" style={spreadStyle} />}
                    {buyAt != null && <span className={bestBuy ? 'fx-mark is-buy is-best' : 'fx-mark is-buy'} style={{ left: buyAt + '%' }} />}
                    {sellAt != null && <span className={bestSell ? 'fx-mark is-sell is-best' : 'fx-mark is-sell'} style={{ left: sellAt + '%' }} />}
                  </span>
                </span>
                <span className="fx-nums">
                  <RateNum word={buyWord} value={provider.buy} best={bestBuy} />
                  <RateNum word={sellWord} value={provider.sell} best={bestSell} />
                </span>
              </button>
              {open && <Tip provider={provider} kursiMissing={!model.hasKursi} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DiffChart({ model, openId, bind }: { model: PairModel; openId: string | null; bind: (id: string) => RowHandlers }) {
  const { t } = useI18n();
  const others = model.providers.filter((provider) => !provider.kursi);
  const buyWord = t('ყიდვა', 'Buy');
  const sellWord = t('გაყიდვა', 'Sell');
  return (
    <div className="fx-block">
      <h3>{t('სხვაობა Kursi.ge-სთან, GEL', 'Difference vs Kursi.ge, GEL')}</h3>
      <p className="tiny muted fx-note">
        {t(
          'ნული Kursi.ge-ა. ყიდვის სხვაობა = კონკურენტის ყიდვა − Kursi.ge-ის ყიდვა. გაყიდვის სხვაობა = კონკურენტის გაყიდვა − Kursi.ge-ის გაყიდვა. ერთეული ლარია, 1 ვალუტის ერთეულზე, ხუთ ნიშნამდე, როგორც ცხრილში.',
          'Zero is Kursi.ge. Buy difference = competitor buy − Kursi.ge buy. Sell difference = competitor sell − Kursi.ge sell. The unit is GEL per 1 unit of currency, to five decimals, as in the table.',
        )}
      </p>
      <p className="tiny muted fx-note">
        {t(
          'ყიდვაზე პლუსი ნიშნავს, რომ კონკურენტი მეტ ლარს იხდის. გაყიდვაზე პლუსი ნიშნავს, რომ კონკურენტი უფრო ძვირად ყიდის. პლუსი ყოველთვის უპირატესობა არ არის.',
          'On buy, a plus means the competitor pays more GEL. On sell, a plus means the competitor charges more GEL. A plus is not always an advantage.',
        )}
      </p>
      {!model.hasKursi && <p className="empty">{t('Kursi.ge ამ წყვილზე არ არის, ამიტომ სხვაობა ვერ იზომება.', 'Kursi.ge has no rate on this pair, so the difference cannot be measured.')}</p>}
      {model.hasKursi && !others.length && <p className="empty">{t('ამ წყვილზე სხვა წყარო არ არის.', 'No other source on this pair.')}</p>}
      {model.hasKursi && others.length > 0 && (
        <>
          <p className="tiny muted fx-note">
            {model.diffLimit > 0
              ? t('შკალის ბოლოები ამ წყვილის ყველაზე დიდ სხვაობას ემთხვევა.', 'The scale ends match the largest difference on this pair.')
              : t('ყველა შედარებული კურსი Kursi.ge-ს ემთხვევა.', 'Every compared rate matches Kursi.ge.')}
          </p>
          <div className="fx-legend">
            <span><i className="fx-swatch is-diff-buy" />{t('ყიდვის სხვაობა', 'Buy difference')}</span>
            <span><i className="fx-swatch is-diff-sell" />{t('გაყიდვის სხვაობა', 'Sell difference')}</span>
          </div>
          <div className="fx-line fx-head" aria-hidden="true">
            <span className="fx-name" />
            <div className="fx-plot">
              {model.diffLimit > 0 ? (
                <div className="fx-axis">
                  <span>{fmtSigned(-model.diffLimit)}</span>
                  <span>0</span>
                  <span>{fmtSigned(model.diffLimit)}</span>
                </div>
              ) : (
                <div className="fx-axis is-flat"><span>0.00000</span></div>
              )}
            </div>
            <span className="fx-nums"><span className="fx-num">{buyWord}</span><span className="fx-num">{sellWord}</span></span>
          </div>
          <div className="fx-rows">
            {others.map((provider) => {
              const id = 'diff:' + provider.key;
              const open = openId === id;
              const buyBar = provider.buyDiff == null ? null : barBox(provider.buyDiff, model.diffLimit);
              const sellBar = provider.sellDiff == null ? null : barBox(provider.sellDiff, model.diffLimit);
              return (
                <div key={provider.key} className="fx-row">
                  <button type="button" className="fx-line" {...bind(id)}>
                    <span className="fx-name">{provider.label}</span>
                    <span className="fx-plot">
                      <span className="fx-div" aria-hidden="true">
                        <span className="fx-div-zero" />
                        {buyBar && <span className="fx-bar is-buy" style={buyBar} />}
                        {sellBar && <span className="fx-bar is-sell" style={sellBar} />}
                      </span>
                    </span>
                    <span className="fx-nums">
                      <RateNum word={buyWord} value={provider.buyDiff} signed />
                      <RateNum word={sellWord} value={provider.sellDiff} signed />
                    </span>
                  </button>
                  {open && <Tip provider={provider} kursiMissing={false} />}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function bestCaption(labels: string[], t: Tr): string {
  if (!labels.length) return '—';
  return labels.length > 1 ? labels.join(', ') + ' · ' + t('თანაბარი', 'tie') : labels[0];
}

function Ruler({ min, max, kursi, bestOnRight }: { min: number; max: number; kursi: number | null; bestOnRight: boolean }) {
  const flat = fmtRate(min) === fmtRate(max);
  const at = kursi == null || flat ? 50 : posPct(kursi, min, max);
  const kursiBest = kursi != null && sameRate(kursi, bestOnRight ? max : min);
  return (
    <div className="fx-ruler">
      <div className="fx-ruler-track" aria-hidden="true">
        {!flat && <span className={!bestOnRight ? 'fx-ruler-end is-low is-best' : 'fx-ruler-end is-low'} />}
        {!flat && <span className={bestOnRight ? 'fx-ruler-end is-high is-best' : 'fx-ruler-end is-high'} />}
        {kursi != null && <span className={kursiBest ? 'fx-ruler-kursi is-best' : 'fx-ruler-kursi'} style={{ left: at + '%' }} />}
      </div>
      <div className="fx-ruler-caps">
        {flat ? <span>{fmtRate(min)}</span> : (<><span>{fmtRate(min)}</span><span>{fmtRate(max)}</span></>)}
      </div>
    </div>
  );
}

function SideRange({
  side,
  standing,
  best,
  bestLabels,
  kursi,
  min,
  max,
  bestOnRight,
}: {
  side: 'buy' | 'sell';
  standing: Standing;
  best: number | null;
  bestLabels: string[];
  kursi: number | null;
  min: number | null;
  max: number | null;
  bestOnRight: boolean;
}) {
  const { t } = useI18n();
  const gap = kursi != null && best != null ? fmtSigned(kursi - best) : null;
  return (
    <article>
      <p className="strong">{side === 'buy' ? t('ყიდვა', 'Buy') : t('გაყიდვა', 'Sell')}</p>
      <p className="fx-standing">{standingText(t, side, standing)}</p>
      <dl>
        <div>
          <dt>{t('საუკეთესო', 'Best')}</dt>
          <dd>{best == null ? '—' : <><span className="strong">{fmtRate(best)}</span> {bestCaption(bestLabels, t)}</>}</dd>
        </div>
        <div>
          <dt>Kursi.ge</dt>
          <dd>
            {kursi == null ? '—' : <span className="strong">{fmtRate(kursi)}</span>}
            {gap != null && <span className="fx-gap">{t('საუკეთესოსთან {delta} GEL', '{delta} GEL vs best', { delta: gap })}</span>}
          </dd>
        </div>
        <div>
          <dt>{t('დიაპაზონი', 'Range')}</dt>
          <dd>
            {min == null || max == null
              ? '—'
              : <>{fmtRate(min)} – {fmtRate(max)} <span className="tiny muted">{t('სიგანე {span} GEL', 'Span {span} GEL', { span: fmtSigned(max - min).replace(/^\+/, '') })}</span></>}
          </dd>
        </div>
      </dl>
      {min != null && max != null && (
        <>
          <p className="tiny muted fx-ruler-caption">
            {bestOnRight
              ? kursi != null
                ? t('მარჯვნივ საუკეთესო ყიდვაა. იასამნისფერი წერტილი Kursi.ge-ა.', 'Best buy is on the right. The purple dot is Kursi.ge.')
                : t('მარჯვნივ საუკეთესო ყიდვაა.', 'Best buy is on the right.')
              : kursi != null
                ? t('მარცხნივ საუკეთესო გაყიდვაა. იასამნისფერი წერტილი Kursi.ge-ა.', 'Best sell is on the left. The purple dot is Kursi.ge.')
                : t('მარცხნივ საუკეთესო გაყიდვაა.', 'Best sell is on the left.')}
          </p>
          <Ruler min={min} max={max} kursi={kursi} bestOnRight={bestOnRight} />
        </>
      )}
    </article>
  );
}

function RangeSummary({ model }: { model: PairModel }) {
  const { t } = useI18n();
  const kursi = model.providers.find((provider) => provider.kursi);
  return (
    <div className="fx-block">
      <h3>{t('ბაზრის დიაპაზონი', 'Market range')}</h3>
      <p className="tiny muted fx-note">
        {t(
          'საუკეთესო ყიდვა ყველაზე მაღალი ყიდვაა. საუკეთესო გაყიდვა ყველაზე დაბალი გაყიდვაა. თანაბარი კურსი ცხრილის ხუთ ნიშანში თანაბრად ჩანს.',
          'Best buy is the highest buy. Best sell is the lowest sell. A tie is a tie in the table’s five decimals.',
        )}
      </p>
      <div className="fx-sum">
        <SideRange side="buy" standing={model.buyStanding} best={model.bestBuy} bestLabels={model.bestBuyLabels} kursi={kursi?.buy ?? null} min={model.buyMin} max={model.buyMax} bestOnRight />
        <SideRange side="sell" standing={model.sellStanding} best={model.bestSell} bestLabels={model.bestSellLabels} kursi={kursi?.sell ?? null} min={model.sellMin} max={model.sellMax} bestOnRight={false} />
      </div>
    </div>
  );
}

function PairDashboard({ model }: { model: PairModel }) {
  const { t } = useI18n();
  const { openId, bind } = useTips();
  if (!model.providers.length) {
    return <p className="empty">{t('ამ წყვილზე შენახული კურსი არ არის.', 'No saved rate for this pair.')}</p>;
  }
  return (
    <div id="fx-panel" role="tabpanel">
      <PositionChart model={model} openId={openId} bind={bind} />
      <DiffChart model={model} openId={openId} bind={bind} />
      <RangeSummary model={model} />
    </div>
  );
}

export default function RateCompareCharts({ board }: { board: CurrentBoard }) {
  const { t } = useI18n();
  const models = useMemo(() => FOCUS_PAIRS.map((pair) => buildPair(board, pair)), [board]);
  const [pair, setPair] = useState<FocusPair>('USD/GEL');
  const model = models.find((item) => item.pair === pair) ?? models[0];

  function onPairKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const index = FOCUS_PAIRS.indexOf(pair);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? FOCUS_PAIRS.length - 1
      : event.key === 'ArrowRight' ? (index + 1) % FOCUS_PAIRS.length
      : (index - 1 + FOCUS_PAIRS.length) % FOCUS_PAIRS.length;
    const id = FOCUS_PAIRS[next];
    setPair(id);
    event.currentTarget.querySelector<HTMLButtonElement>('[data-pair="' + id + '"]')?.focus();
  }

  return (
    <section className="card fx-dash" aria-labelledby="fx-dash-title">
      <div className="card-head">
        <div>
          <h2 id="fx-dash-title">{t('ბაზართან შედარება', 'Market comparison')}</h2>
          <p className="small muted">
            {t(
              'ყიდვა — კურსი, როცა კლიენტი ვალუტას ყიდის და Kursi.ge ყიდულობს. გაყიდვა — კურსი, როცა Kursi.ge ვალუტას ყიდის. საუკეთესო ყიდვა ყველაზე მაღალია, საუკეთესო გაყიდვა ყველაზე დაბალი. ციფრები ცხრილის შენახული კურსებია, 1 ერთეულზე, ლარში.',
              'Buy is the rate when a client sells currency and Kursi.ge buys it. Sell is the rate when Kursi.ge sells currency. Best buy is the highest buy. Best sell is the lowest sell. Figures are the stored table rates, GEL per 1 unit.',
            )}
          </p>
        </div>
      </div>
      <div className="fx-pairs" role="tablist" aria-label={t('წყვილი', 'Pair')} onKeyDown={onPairKey}>
        {models.map((item) => (
          <button
            key={item.pair}
            type="button"
            className="fx-pair"
            data-pair={item.pair}
            role="tab"
            aria-selected={item.pair === pair}
            aria-controls="fx-panel"
            onClick={() => setPair(item.pair)}
          >
            <span className="fx-pair-name">{item.pair}</span>
            <span className="fx-pair-status">
              {item.providers.length
                ? standingText(t, 'buy', item.buyStanding) + ' · ' + standingText(t, 'sell', item.sellStanding)
                : t('კურსი არ არის', 'No rate')}
            </span>
          </button>
        ))}
      </div>
      <PairDashboard key={pair} model={model} />
    </section>
  );
}
