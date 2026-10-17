import {
  clientBuyFromAdjustment,
  clientSellFromAdjustment,
  formatAdjustment,
  negotiatedSourceFromRpc,
  selectActiveNegotiated,
  standardMidpoint,
  type NegotiatedSourceRow,
} from './negotiatedRates';

function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

const NOW = Date.parse('2026-10-17T08:00:00.000Z');
const NEWER = '2026-10-17T07:00:00.000Z';
const OLDER = '2026-10-16T07:00:00.000Z';
const FUTURE = '2026-10-18T08:00:00.000Z';
const PAST = '2026-10-16T08:00:00.000Z';

assert(standardMidpoint(2.675, 2.715).toFixed(6) === '2.695000', 'midpoint is (buy + sell) / 2');
assert(clientBuyFromAdjustment(2.695, 0.01).toFixed(5) === '2.70500', 'client buy adds the buy adjustment');
assert(clientSellFromAdjustment(2.695, 0.02).toFixed(5) === '2.67500', 'client sell subtracts the sell adjustment');
assert(clientBuyFromAdjustment(2.695, -0.005).toFixed(5) === '2.69000', 'a negative buy adjustment still adds');
assert(formatAdjustment(0.015) === '+0.01500', 'a positive adjustment keeps its sign');
assert(formatAdjustment(-0.005) === '-0.00500', 'a negative adjustment keeps its sign');
assert(formatAdjustment(0) === '0.00000', 'zero stays unsigned');

function row(patch: Partial<NegotiatedSourceRow> & Pick<NegotiatedSourceRow, 'id'>): NegotiatedSourceRow {
  return {
    createdAt: NEWER,
    expiresAt: FUTURE,
    baseCurrency: 'GEL',
    secondaryCurrency: 'USD',
    buyRate: 0.01,
    sellRate: 0.02,
    standardBuy: 2.675,
    standardSell: 2.715,
    ...patch,
  };
}

const picked = selectActiveNegotiated([
  row({ id: 'old', createdAt: OLDER, buyRate: 0.5 }),
  row({ id: 'new', createdAt: NEWER, buyRate: 0.01 }),
  row({ id: 'eur', baseCurrency: 'EUR', secondaryCurrency: 'GEL', buyRate: 0.03, sellRate: 0.04, standardBuy: 2.9, standardSell: 3.1 }),
  row({ id: 'expired', expiresAt: PAST, buyRate: 9 }),
  row({ id: 'now', expiresAt: '2026-10-17T08:00:00.000Z', buyRate: 8 }),
  row({ id: 'open', expiresAt: null, createdAt: NEWER, buyRate: 0.01 }),
  row({ id: 'gbp', secondaryCurrency: 'GBP' }),
  row({ id: 'cross', baseCurrency: 'USD', secondaryCurrency: 'EUR' }),
], NOW);

const usd = picked.filter((item) => item.pair === 'GEL/USD');
assert(usd.length === 2, 'latest USD rows stay, including a row with no expiry');
assert(usd.every((item) => item.id === 'new' || item.id === 'open'), 'an older USD row is not shown');
assert(usd.every((item) => item.tied), 'two USD rows at the same time are a tie');
assert(usd[0].clientBuy?.toFixed(5) === '2.70500', 'tied USD client buy uses the midpoint');
assert(usd[0].clientSell?.toFixed(5) === '2.67500', 'tied USD client sell uses the midpoint');
assert(usd[0].midpoint?.toFixed(6) === '2.695000', 'the view exposes the midpoint');

const eur = picked.filter((item) => item.pair === 'GEL/EUR');
assert(eur.length === 1 && eur[0].id === 'eur' && !eur[0].tied, 'EUR is kept on its own');
assert(eur[0].clientBuy?.toFixed(5) === '3.03000', 'EUR client buy is midpoint plus adjustment');
assert(eur[0].clientSell?.toFixed(5) === '2.96000', 'EUR client sell is midpoint minus adjustment');
assert(!picked.some((item) => item.id === 'expired' || item.id === 'now' || item.id === 'gbp' || item.id === 'cross'), 'expired, other pairs, and crosses stay hidden');

const tie = selectActiveNegotiated([
  row({ id: 'b', createdAt: NEWER, buyRate: 0.02 }),
  row({ id: 'a', createdAt: NEWER, buyRate: 0.01 }),
], NOW);
assert(tie.length === 2 && tie[0].id === 'a' && tie[1].id === 'b' && tie.every((item) => item.tied), 'a created_at tie keeps both rows and does not pick');

const noStandard = selectActiveNegotiated([
  row({ id: 'bare', standardBuy: null, standardSell: null }),
], NOW);
assert(noStandard.length === 1 && noStandard[0].buyRate === 0.01 && noStandard[0].clientBuy == null && noStandard[0].clientSell == null, 'missing standard leaves the adjustments and skips the results');

const parsed = negotiatedSourceFromRpc({
  row_id: '7',
  created_at: NEWER,
  expires_at: FUTURE,
  base_currency: 'gel',
  secondary_currency: 'usd',
  buy_rate: '0.010000',
  sell_rate: '0.020000',
  standard_buy: '2.675000',
  standard_sell: '2.715000',
});
assert(parsed?.buyRate === 0.01 && parsed.standardBuy === 2.675, 'numeric strings from the RPC become numbers');
const shown = parsed ? selectActiveNegotiated([parsed], NOW) : [];
assert(shown.length === 1 && shown[0].pair === 'GEL/USD' && shown[0].clientBuy?.toFixed(5) === '2.70500', 'a parsed RPC row calculates the same client buy');
assert(negotiatedSourceFromRpc({ buy_rate: 1 }) == null, 'a row without an id is dropped');

console.log('negotiated rates ok');
