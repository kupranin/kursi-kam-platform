import type { CurrentBoard } from './rateGrid';
import { MIDPOINT_ABOVE, MIDPOINT_BELOW, treasuryMidpointWarning } from './treasuryMidpoint';

function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

const kursi: CurrentBoard = {
  pairs: ['USD/GEL'],
  rows: [{ key: 'kursi', label: 'Kursi', quotes: [{ buy: 2.594, sell: 2.601 }] }],
  updatedAt: null,
};

const midpoint = (2.594 + 2.601) / 2;

assert(
  treasuryMidpointWarning(kursi, 'USD', 'GEL', 2.20) == null,
  'client sells USD, gets GEL, quote 2.20 is below the midpoint and does not warn',
);

const above = treasuryMidpointWarning(kursi, 'USD', 'GEL', 2.70);
assert(
  above?.direction === 'above' && above.midpoint === midpoint,
  'client gets GEL, quote 2.70 is above the midpoint and warns',
);

const below = treasuryMidpointWarning(kursi, 'GEL', 'USD', 2.40);
assert(
  below?.direction === 'below' && below.midpoint === midpoint,
  'client sells GEL, gets USD, quote 2.40 is below the midpoint and warns',
);

assert(Math.abs(midpoint - 2.5975) < 1e-9, 'the example midpoint is about 2.5975');

const missing: CurrentBoard = { pairs: [], rows: [], updatedAt: null };
assert(
  treasuryMidpointWarning(missing, 'USD', 'GEL', 2.70) == null,
  'a missing board does not warn on the midpoint rule',
);
assert(treasuryMidpointWarning(null, 'USD', 'GEL', 2.70) == null, 'no loaded board does not warn');

const missingSell: CurrentBoard = {
  pairs: ['USD/GEL'],
  rows: [{ key: 'kursi', label: 'Kursi', quotes: [{ buy: 2.594, sell: null }] }],
  updatedAt: null,
};
assert(
  treasuryMidpointWarning(missingSell, 'USD', 'GEL', 2.70) == null,
  'a missing Kursi sell does not warn',
);

const competitor: CurrentBoard = {
  pairs: ['USD/GEL'],
  rows: [{ key: 'valuto', label: 'Valuto', quotes: [{ buy: 2.594, sell: 2.601 }] }],
  updatedAt: null,
};
assert(
  treasuryMidpointWarning(competitor, 'USD', 'GEL', 2.70) == null,
  'a competitor row is not the published Kursi board',
);

assert(treasuryMidpointWarning(kursi, 'EUR', 'USD', 1.2) == null, 'a cross with no GEL side does not warn');
assert(treasuryMidpointWarning(kursi, 'GEL', 'USD', 2.70) == null, 'selling GEL above the midpoint does not warn');
assert(treasuryMidpointWarning(kursi, 'USD', 'GEL', midpoint) == null, 'a quote equal to the midpoint does not warn');

assert(MIDPOINT_ABOVE.en.includes('above the published midpoint') && MIDPOINT_ABOVE.ka.includes('{rate}') && MIDPOINT_ABOVE.ka.includes('{mid}'), 'the above warning names both numbers');
assert(MIDPOINT_BELOW.en.includes('below the published midpoint') && MIDPOINT_BELOW.en.includes('{rate}') && MIDPOINT_BELOW.en.includes('{mid}'), 'the below warning names both numbers');

console.log('treasury midpoint ok');
