// @ts-nocheck — reads the SQL files with node:fs. The app tsconfig has no Node types.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_TIME_OWNER_RULE,
  MONTH_WINDOW_OWNER_RULE,
  allTimeClientOwner,
  cappedClientIds,
  describeClientAudit,
  kamMayEditRequest,
  kamMayReadSpecialRates,
  kamMayWriteSpecialRates,
  maySetOwnerOverride,
  monthPortfolioRows,
  monthWindowOwner,
  ownerDisplayText,
  ownerSourceCaption,
  requestKamRows,
} from './clientOwnership';

function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const setup = readFileSync(join(root, 'supabase/setup/49_client_ownership.sql'), 'utf8');
const migration = readFileSync(join(root, 'supabase/migrations/20261017150000_client_ownership.sql'), 'utf8');
const ownerLoads = readFileSync(join(root, 'src/lib/clientOwners.ts'), 'utf8');
assert(setup === migration, 'setup 49 and the migration are the same bytes');
assert(!/create\s+(or\s+replace\s+)?function\s+private\.owners\b/i.test(setup), '49 does not create private.owners');
assert(/private\.owners\(/.test(setup), '49 names private.owners so it is not confused with the all-time owner');
assert(!/create\s+or\s+replace\s+function\s+public\.client_request_brief\b/i.test(setup), '45 client_request_brief stays');
assert(!/create\s+or\s+replace\s+function\s+public\.client_request_history\b/i.test(setup), '45 client_request_history stays');
assert(!/create\s+or\s+replace\s+function\s+private\.request_display_class\b/i.test(setup), '45 request_display_class stays');
assert(!/create\s+or\s+replace\s+function\s+public\.analytics_request_kpis\b/i.test(setup), '47 analytics_request_kpis stays');
assert(!/create\s+or\s+replace\s+function\s+public\.save_client_special_rate\b/i.test(setup), 'special-rate writes stay on the existing function');
assert(!/update\s+public\.requests\b/i.test(setup), '49 does not write requests');
assert(/function\s+public\.client_effective_owners/.test(setup), 'the all-time owner is a new function');

// private.owners(p_from, p_to) is not the function under test.
// It is the month window: highest count, tie = latest requested_at.
// allTimeClientOwner has no date window and leaves that tie unresolved.
const allTimeRule: string = ALL_TIME_OWNER_RULE;
const monthWindowRule: string = MONTH_WINDOW_OWNER_RULE;
assert(allTimeRule !== monthWindowRule, 'all-time rule is not private.owners');
assert(monthWindowRule === 'private.owners', 'the month-window label stays private.owners');
assert(allTimeClientOwner.name === 'allTimeClientOwner', 'the tested function is the all-time owner');
assert(monthWindowOwner.name !== allTimeClientOwner.name, 'monthWindowOwner is not allTimeClientOwner');

const highest = allTimeClientOwner({
  assignedKamId: null,
  counts: [{ kamId: 'kam-a', count: 5 }, { kamId: 'kam-b', count: 2 }],
});
assert(highest.kind === 'computed' && highest.kamId === 'kam-a' && highest.rule === ALL_TIME_OWNER_RULE, 'highest count wins');

const tie = allTimeClientOwner({
  assignedKamId: null,
  counts: [{ kamId: 'kam-a', count: 4 }, { kamId: 'kam-b', count: 4 }],
});
assert(tie.kind === 'unresolved' && tie.kamId == null, 'a tie for the highest count is unresolved');
const monthTie = monthWindowOwner([
  { kamId: 'kam-a', requestedAt: '2026-10-01T00:00:00Z' },
  { kamId: 'kam-a', requestedAt: '2026-10-02T00:00:00Z' },
  { kamId: 'kam-a', requestedAt: '2026-10-03T00:00:00Z' },
  { kamId: 'kam-a', requestedAt: '2026-10-04T00:00:00Z' },
  { kamId: 'kam-b', requestedAt: '2026-10-05T00:00:00Z' },
  { kamId: 'kam-b', requestedAt: '2026-10-06T00:00:00Z' },
  { kamId: 'kam-b', requestedAt: '2026-10-07T00:00:00Z' },
  { kamId: 'kam-b', requestedAt: '2026-10-08T00:00:00Z' },
]);
assert(monthTie === 'kam-b', 'the month window, like private.owners, gives a tie to the later request');
assert(tie.kamId !== monthTie, 'all-time does not adopt the month-window winner');

const monthDifferent = monthWindowOwner([
  { kamId: 'kam-a', requestedAt: '2026-10-01T00:00:00Z' },
  { kamId: 'kam-b', requestedAt: '2026-10-02T00:00:00Z' },
  { kamId: 'kam-b', requestedAt: '2026-10-03T00:00:00Z' },
]);
assert(monthDifferent === 'kam-b' && highest.kamId === 'kam-a', 'month portfolio owner is not the all-time owner');

const overrideWinner = allTimeClientOwner({ assignedKamId: 'kam-c', counts: [{ kamId: 'kam-a', count: 9 }] });
assert(overrideWinner.kind === 'override' && overrideWinner.kamId === 'kam-c', 'assigned_kam_id overrides a winner');
const overrideTie = allTimeClientOwner({
  assignedKamId: 'kam-c',
  counts: [{ kamId: 'kam-a', count: 2 }, { kamId: 'kam-b', count: 2 }],
});
assert(overrideTie.kind === 'override' && overrideTie.kamId === 'kam-c', 'assigned_kam_id overrides a tie');
const cleared = allTimeClientOwner({ assignedKamId: null, counts: [{ kamId: 'kam-a', count: 9 }] });
assert(cleared.kind === 'computed' && cleared.kamId === 'kam-a', 'clearing the override restores the counted owner');
assert(allTimeClientOwner({ assignedKamId: '  ', counts: [{ kamId: 'kam-a', count: 9 }] }).kind === 'computed', 'a blank override is not an owner');
assert(allTimeClientOwner({ assignedKamId: null, counts: [] }).kind === 'unresolved', 'no requests and no override is unresolved');
assert(allTimeClientOwner({ assignedKamId: null, counts: [{ kamId: null, count: 8 }, { kamId: 'kam-a', count: 1 }] }).kamId === 'kam-a', 'a blank kam id cannot win');

assert(ownerDisplayText('unresolved', null, 'ka') === 'განუსაზღვრელია', 'unresolved Georgian label');
assert(ownerDisplayText('unresolved', null, 'en') === 'Unresolved', 'unresolved English label');
assert(ownerDisplayText('none', null, 'en') === 'Not assigned', 'the old empty assignment label stays available');
assert(ownerDisplayText('unresolved', null, 'ka') !== ownerDisplayText('none', null, 'ka'), 'unresolved is not the old not-assigned label');
assert(ownerDisplayText('named', 'ანა', 'ka') === 'ანა', 'a restored counted owner shows the name');
assert(ownerSourceCaption('computed', 'en') !== ownerSourceCaption('unresolved', 'en'), 'a cleared override with a winner is not the no-winner text');
assert(ownerSourceCaption('unresolved', 'en').includes('no single winner'), 'no override and no winner is explicit');
assert(ownerSourceCaption('computed', 'ka').includes('გადაფარვა არ არის'), 'a counted owner says there is no override');

assert(kamMayReadSpecialRates({ role: 'kam', canViewClient: true }), 'a KAM can read special rates for a client they can open');
assert(!kamMayWriteSpecialRates({ role: 'kam', isMyClient: false }), 'a KAM cannot write special rates for a client they do not own');
assert(kamMayWriteSpecialRates({ role: 'kam', isMyClient: true }), 'a KAM can still write special rates for their own client');
assert(!kamMayReadSpecialRates({ role: 'analyst', canViewClient: true }), 'an analyst is not added');
assert(!kamMayReadSpecialRates({ role: 'kam', canViewClient: false }), 'a client the KAM cannot open stays hidden');
assert(kamMayWriteSpecialRates({ role: 'admin', isMyClient: false }), 'an admin can still write special rates');
assert(!kamMayWriteSpecialRates({ role: 'manager', isMyClient: true }), 'a manager still cannot write');

assert(!kamMayEditRequest('kam', 'kam-a', 'kam-b'), 'a KAM cannot edit another KAM request');
assert(kamMayEditRequest('kam', 'kam-a', 'kam-a'), 'a KAM can edit their own request');
assert(kamMayEditRequest('admin', 'admin-1', 'kam-b'), 'the admin exception stays');
assert(!kamMayEditRequest('manager', 'manager-1', 'kam-b'), 'a manager is not the admin exception');
assert(!kamMayEditRequest('treasury', 'treasury-1', 'kam-b'), 'treasury cannot edit a KAM request');
assert(!kamMayEditRequest('analyst', 'analyst-1', 'kam-b'), 'an analyst cannot edit a KAM request');

assert(maySetOwnerOverride('admin', 'admin'), 'an admin on the admin screen may set the override');
assert(!maySetOwnerOverride('admin', 'kam'), 'view-as does not show the override control');
assert(!maySetOwnerOverride('manager', 'manager'), 'a manager cannot set the override');
assert(!maySetOwnerOverride('treasury', 'treasury'), 'treasury cannot set the override');
assert(!maySetOwnerOverride('kam', 'kam'), 'a KAM cannot set the override');
assert(!maySetOwnerOverride('analyst', 'analyst'), 'an analyst cannot set the override');

const renamed = describeClientAudit('update', '01010101010', { assigned_kam_id: 'kam-a' }, { assigned_kam_id: 'kam-b' }, { 'kam-a': 'ნინო', 'kam-b': 'გიორგი' });
assert(renamed.includes('ნინო') && renamed.includes('გიორგი'), 'activity names the old and new owner');
const clearedLine = describeClientAudit('update', '01010101010', { assigned_kam_id: 'kam-a' }, { assigned_kam_id: null }, { 'kam-a': 'ნინო' });
assert(clearedLine.includes('ნინო') && clearedLine.includes('გადაფარვა მოხსნილია'), 'clearing names the old owner');
assert(describeClientAudit('update', '01010101010', { name: 'ძველი' }, { name: 'ახალი', assigned_kam_id: null }, {}) === 'შეიცვალა კლიენტი 01010101010', 'a name-only change stays the old sentence');
assert(!describeClientAudit('delete', '01010101010', { assigned_kam_id: 'kam-a' }, null, { 'kam-a': 'ნინო' }).includes('ნინო'), 'deleting a client is not an owner clear');

const mixed = { clients: 4, requests_judged: 9, requests_won: 2 };
const portfolio = monthPortfolioRows([mixed]);
const requests = requestKamRows([mixed]);
assert(portfolio.length === 1 && portfolio[0].clients === 4, 'month portfolio client count');
assert(requests.length === 1 && requests[0].requests_won === 2 && requests[0].requests_judged === 9, 'request KAM performance');
assert(requests[0].requests_judged !== portfolio[0].clients, 'request performance is not the month client count');
assert(requestKamRows([{ clients: 3, requests_judged: 0, requests_won: 0 }]).length === 0, 'month clients are not one your-requests row');
assert(monthPortfolioRows([{ clients: 0, requests_judged: 5, requests_won: 1 }]).length === 0, 'request wins do not invent a portfolio client');

assert(/order by s\.id\s+limit 100/i.test(setup), 'special-rate ids keep the lowest 100 normalized ids');
assert(!/array_agg\(s\.id\)/.test(setup), 'special-rate ids are not aggregated without an order');
assert(/order by a\.client_id\s+limit 100/i.test(setup), 'owner ids keep the lowest 100 normalized ids');
assert(!/\[[0-9]+:[0-9]+\]/.test(setup), 'client ids are not sliced by input position');
assert(!/::text\[\]\)\[/.test(setup), 'a coalesce cast is not sliced');
assert(!/up to 200 ids/.test(setup), 'the owner cap is 100');
assert(!/i \+ 200/.test(ownerLoads), 'owner loads are not positional batches of 200');
assert(/i \+ 100/.test(ownerLoads), 'owner loads stay within the 100 id maximum');
const manyIds = Array.from({ length: 130 }, (_, i) => String(i).padStart(9, '0'));
const forwardIds = cappedClientIds(manyIds);
const reverseIds = cappedClientIds([...manyIds].reverse());
const messyIds = cappedClientIds(manyIds.flatMap((id, i) => (i % 2 === 0 ? [` ${id} `, `${id}.0`, id] : [id])));
assert(forwardIds.length === 100 && reverseIds.length === 100 && messyIds.length === 100, 'the cap stays 100');
assert(forwardIds.join('|') === reverseIds.join('|') && forwardIds.join('|') === messyIds.join('|'), 'two equal inputs cannot drop different ids');
assert(forwardIds[0] === '000000000' && forwardIds[99] === '000000099' && !forwardIds.includes('000000129'), 'the lowest normalized ids are kept');
assert(cappedClientIds(['1234567890', '01234567890']).join('|') === '01234567890', 'a 10-digit id and its normalized form are one id');

console.log('client ownership ok');
