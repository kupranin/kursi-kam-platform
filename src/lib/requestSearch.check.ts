import {
  applySearchFilters,
  currencyPairOptions,
  daysBefore,
  searchEngaged,
  searchNeedle,
  searchPlan,
  searchStatusOf,
  type SearchChain,
} from './requestSearch';

function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

function callsFor(plan: ReturnType<typeof searchPlan>): string[] {
  const calls: string[] = [];
  const chain: SearchChain = {
    eq(column, value) { calls.push(`eq ${column} ${String(value)}`); return chain; },
    neq(column, value) { calls.push(`neq ${column} ${value}`); return chain; },
    is(column, value) { calls.push(`is ${column} ${String(value)}`); return chain; },
    gte(column, value) { calls.push(`gte ${column} ${value}`); return chain; },
    lte(column, value) { calls.push(`lte ${column} ${value}`); return chain; },
    or(filters) { calls.push(`or ${filters}`); return chain; },
    order() { return chain; },
    range() { return Promise.resolve({ data: [], error: null, count: 0 }); },
  };
  applySearchFilters(chain, plan);
  return calls;
}

const needle = searchNeedle('  მაია 12 ');
assert(needle === 'მაია 12', 'keeps a Georgian name');
const hostile = searchNeedle('1,kam_id.neq.other)');
assert(hostile === '1kamidneqother', 'strips filter punctuation');
assert(!hostile.includes(',') && !hostile.includes('.'), 'no breakout characters');

assert(daysBefore('2026-10-15', 29) === '2026-09-16', '30-day window');
assert(daysBefore('2024-03-01', 1) === '2024-02-29', 'leap day');

assert(!searchEngaged({ text: '', status: 'all', dates: '30', pair: 'all' }), 'idle until the KAM searches');
assert(searchEngaged({ text: 'ა', status: 'all', dates: '30', pair: 'all' }), 'text starts a search');
assert(searchEngaged({ text: '', status: 'lost', dates: '30', pair: 'all' }), 'status starts a search');
assert(searchEngaged({ text: '', status: 'all', dates: 'all', pair: 'all' }), 'all dates starts a search');

const pairs = currencyPairOptions();
assert(pairs.includes('USD/GEL') && !pairs.includes('USD/USD'), 'pairs are two different currencies');

const named = searchPlan({
  kamId: 'kam-1',
  text: 'მაია',
  status: 'all',
  dates: '30',
  pair: 'USD/GEL',
  offset: 0,
  today: '2026-10-15',
});
assert(named.limit === 25, 'page size 25');
const namedCalls = callsFor(named);
assert(namedCalls[0] === 'eq kam_id kam-1', 'always the signed-in KAM');
assert(namedCalls.includes('gte request_date 2026-09-16'), 'default date starts 30 days back');
assert(namedCalls.includes('lte request_date 2026-10-15'), 'default date includes today');
assert(namedCalls.includes('eq sells_currency USD') && namedCalls.includes('eq gets_currency GEL'), 'pair filter');
const textCall = namedCalls.find((call) => call.startsWith('or client_name'));
assert(!!textCall && textCall.includes('client_name.ilike."*მაია*"') && textCall.includes('client_id.ilike."*მაია*"'), 'name and client id');
assert(!textCall?.includes('id.eq'), 'a name is not a request id');

const byId = callsFor(searchPlan({
  kamId: 'kam-1', text: '4821', status: 'all', dates: 'all', pair: 'all', offset: 25, today: '2026-10-15',
}));
assert(!byId.some((call) => call.startsWith('gte ')), 'all dates drops the date filter');
assert(byId.some((call) => call.includes('id.eq.4821')), 'digits also match the request id');
assert(byId.some((call) => call.includes('client_id.ilike."*4821*"')), 'digits still match a client id');

const injected = callsFor(searchPlan({
  kamId: 'kam-1', text: '1,kam_id.neq.other)', status: 'all', dates: 'all', pair: 'all', offset: 0, today: '2026-10-15',
}));
const injectedOr = injected.find((call) => call.startsWith('or '));
assert(!!injectedOr && !injectedOr.includes('kam_id.neq') && injectedOr.includes('ilike."*1kamidneqother*"'), 'typed text stays inside the quote');

const lost = callsFor(searchPlan({
  kamId: 'kam-1', text: '', status: 'lost', dates: '30', pair: 'all', offset: 0, today: '2026-10-15',
}));
assert(lost.some((call) => call.includes('loss_open.eq.true')), 'lost includes an open loss');
assert(lost.some((call) => call.includes('outcome.eq.did_not_go_through')), 'lost includes did not go through');
assert(lost.some((call) => call.includes('went_through.eq.false')), 'an app completion is not lost');
assert(lost.some((call) => call.includes('display_class.eq.lost')), 'historical lost uses the display class');

assert(searchStatusOf({ went_through: true, loss_reason: 'other' }) === 'completed', 'completed wins over a loss mark');
assert(searchStatusOf({ loss_reason: 'postponed' }) === 'lost', 'loss reason is lost');
assert(searchStatusOf({ client_reply: 'approved', outcome: 'did_not_go_through' }) === 'lost', 'a deal that did not go through is lost');
assert(searchStatusOf({ client_reply: 'approved', loss_open: true }) === 'lost', 'an open loss stays lost');
assert(searchStatusOf({ client_reply: 'approved' }) === 'accepted', 'an approval with no loss is accepted');
assert(searchStatusOf({ client_reply: 'approved', loss_reason: 'other' }) === 'lost', 'a loss mark beats an approval');
assert(searchStatusOf({ client_reply: 'better' }) === 'better', 'better rate with no decision');
assert(searchStatusOf({ client_reply: 'better', better_decision: 'accepted', quote_state: 'quoted' }) === 'quoted', 'an answered better rate is quoted');
assert(searchStatusOf({ quote_state: 'expired', quote_status: 'quoted' }) === 'quoted', 'an expired quote stays quoted');
assert(searchStatusOf({ quote_status: 'asking', outcome: 'waiting' }) === 'waiting', 'an ask is waiting');
assert(searchStatusOf({ client_reply: 'declined' }) === 'lost', 'a client decline is lost');
assert(searchStatusOf({ quote_status: 'declined' }) === 'lost', 'a treasury decline is lost');
assert(searchStatusOf({ loss_open: true, outcome: 'waiting' }) === 'lost', 'an open loss is lost');
assert(searchStatusOf({ source: 'import', legacy_status: 'შესრულდა' }) === 'completed', 'a completed file status is a completed search row');
assert(searchStatusOf({ source: 'import', legacy_status: 'შესრულდა ნაწილობრივ' }) === 'completed', 'a partial file status is won in search');
assert(searchStatusOf({ source: 'import', legacy_status: 'შეთანხმებულია და გაწერეთ კურსი' }) === 'lost', 'a waiting file status is lost in search');
assert(searchStatusOf({ import_key: 'agreement:4', legacy_status: 'უცნობი' }) === 'lost', 'an unknown file status is lost in search');
assert(searchStatusOf({ source: 'app', outcome: 'did_not_go_through' }) === 'lost', 'an app outcomes label stays on the app search rule');

console.log('request search plan ok');
