# Rates chart redesign

The visual comparison on the Rates page is now a three-part FX dashboard for USD/GEL, EUR/GEL, and RUB/GEL. The downloadable rates table is unchanged and sits under the chart.

## Inspection

1. **Charts.** They lived in `src/components/RateCompareCharts.tsx`, styled by `.rate-chart*` in `src/styles.css`, and were rendered from `src/pages/MarketRates.tsx` below `CurrentBoardTable`. Each pair got a horizontal bar per source. The bar width ran from a padded floor, so close FX rates still looked like long bars.

2. **Downloadable table.** On screen: `CurrentBoardTable`, `PairSides`, and `QuoteCells` in `src/pages/MarketRates.tsx` (source, then Buy and Sell for every pair). Download: the page-head button calls `downloadGrid`, which writes `historySheet(grid)` from `src/lib/rateGrid.ts`. The grid CSS is `.table.rate-grid` in `src/styles.css`. Loading is `loadMarketRateData` in `src/lib/marketBoard.ts`. There is no separate filter control on this table.

3. **Chart data.** `CurrentBoard`: `pairs: string[]`, `rows: { key, label, quotes }[]`, `updatedAt: string | null`. Each quote is `{ buy: number | null, sell: number | null }` (`RateQuote` in `src/lib/rateGrid.ts`). Rates are quote currency per 1 base, including the ruble. The board label for Kursi is `Kursi`. The chart shows that row as Kursi.ge. The table still says Kursi.

4. **Shared data.** Yes. The page loads once into `grid` (history download) and `board` (screen). The chart and the on-screen table both read `board`. The chart does not read `grid` and does not call Supabase. Pair switching uses that already loaded board.

5. **Buy and sell.** See the semantics decision below. The old chart text said buy is when the client sells to Kursi. Nothing on this page ranked a “best” price. `best` inside `assignRateSlots` is the closest stored snapshot, not the best price.

6. **Timestamps.** `CurrentBoard.updatedAt` is one instant: the latest `fetched_at` across the whole board (`buildCurrentBoard`). A row quote does not carry its own time. Per-provider last update is not on the loaded chart data, so the tooltips do not invent one. The page header already prints the board time.

7. **Chart libraries.** `package.json` has React, React DOM, React Router, Supabase, and `xlsx`. No chart library. The new charts are React and CSS.

## Semantics

Cited from the code, not from an assumption that higher is always better.

- A pair is base/quote: how many quote units for 1 base. GEL pairs are foreign/GEL (`src/lib/rateGrid.ts`).
- Buy is the board’s buy column: the rate when the client sells that currency and Kursi buys it. `ClientHistory` uses Kursi’s buy when the client sells the base, and Kursi’s sell when the client sells GEL (`standardSide`). The old chart said the same thing. The rate desk labels the same columns “we buy” and “we sell”, and it uses buy when the client sells foreign currency for GEL and sell when the client sells GEL (`RateDesk.tsx`).
- So the client who sells currency receives GEL at the **buy** rate. A higher buy pays the client more. **Best buy is the highest buy.** A tie is a tie when the table’s four decimals match (`toFixed(4)`, same as `fmtRate`).
- The client who buys currency pays GEL at the **sell** rate. A lower sell costs the client less. **Best sell is the lowest sell.** Same tie rule.
- Standing uses that rule. Ahead means Kursi.ge alone is best. Tied means Kursi.ge shares the best printed rate. Behind means someone else is strictly better. Only Kursi.ge means nobody else quoted that side.
- Chart 2 does not treat a plus as a win. Buying difference = competitor buy − Kursi buy. A plus means the competitor pays more GEL. Selling difference = competitor sell − Kursi sell. A plus means the competitor charges more GEL. The chart states both sentences in Georgian and English.

## Design

One card, not three pair panels. A selector defaults to USD/GEL: USD/GEL, EUR/GEL, RUB/GEL. Each button also shows that pair’s buy and sell standing, so all three pairs are visible without opening three charts. CNY and crosses stay in the table only.

For the selected pair:

1. **Position.** One dot row per provider. A circle is buy, a diamond is sell, a line between them is the spread. Kursi.ge is purple on a pale row. Competitors are muted. A gold ring and a gold underline mark the best buy and best sell. The axis ends are the lowest and highest stored rates on that pair. It does not start at zero. Padding is only so a marker at the end is not clipped.
2. **Difference vs Kursi.ge.** Competitors only. Zero is Kursi.ge. Purple bars are the buy gap. Gold-outline bars are the sell gap. The scale ends are the largest observed gap on that pair, in GEL, so a small gap is not drawn as a large one. The signed number is always printed.
3. **Market range.** Two compact columns, not another bar chart: best, Kursi.ge, gap versus best, and the min–max span. A thin ruler shows where Kursi.ge sits. Best buy is the right end. Best sell is the left end. Ties name every source.

Hover on a fine pointer, and tap elsewhere, opens the provider, buy, sell, both gaps versus Kursi.ge, and the spread (sell − buy) when both exist. No per-provider timestamp. Escape or a tap outside closes it. On a narrow screen the detail sits at the bottom of the viewport.

## Files

Changed:

- `src/components/RateCompareCharts.tsx` — the dashboard. Derived numbers are memoized from `board`.
- `src/styles.css` — replaced `.rate-chart*` only. `.table.rate-grid` and `.legend` are untouched. Mobile rules use the existing `max-width: 800px` breakpoint.
- `src/pages/MarketRates.tsx` — the chart is rendered above the table. That file also contains the table, so this was the only way to change the order. The diff is those two lines. `CurrentBoardTable`, `PairSides`, `QuoteCells`, and `downloadGrid` are the same.

Not changed: `src/lib/rateGrid.ts`, `src/lib/marketBoard.ts`, rate ingestion, permissions, Supabase queries, and the Phase 2 files.

## Unit

**GEL per 1 unit of currency, four decimal places**, the same precision as the table. A difference is the subtraction of the two stored rates, then shown at four decimals so it matches subtracting the printed table figures. Tetri was not used: 1 tetri is 0.01 GEL, and the board is kept to 0.0001, so a tetri figure would hide or rescale the last digits.

## Checks

- `npx tsc --noEmit` passed (also run inside `npm run build`).
- `npm run build` passed (`tsc --noEmit && vite build`).
- There is no `VITE_SUPABASE_URL` in this workspace, so the live Rates page stops on the setup screen and live rates could not be loaded. No sample path exists on the page.
- Layout was checked in headless Chrome at 1280px and 390px against a temporary preview of this component, since a Cursor browser tab could not be opened. The preview file was removed and is not part of the app. On a fixture board, USD showed Kursi.ge behind on both sides, EUR ahead on both, and RUB tied. Printed rates matched the fixture. Gaps matched the subtractions (for example 2.7120 − 2.7050 = +0.0070 and 2.7280 − 2.7350 = −0.0070). Marker positions sat on the observed range (Kursi.ge 2.7050 at about 10% and 2.7350 at about 73% of 2.7000–2.7480). Pair switching, the tooltip, and the English strings worked. `scrollWidth` did not exceed the viewport at either width.
- Not verified: the chart against live Supabase rows, or a signed-in pass through the real Rates route.
