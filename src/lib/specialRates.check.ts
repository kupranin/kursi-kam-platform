// @ts-nocheck — reads the SQL files with node:fs. The app tsconfig has no Node types.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kamMayWriteSpecialRates } from './clientOwnership';
import {
  clearSpecialBanks,
  specialRateBoxChecked,
  specialTermsNeedClear,
  upsertSpecialBank,
  visibleSpecialBanks,
  type SpecialBankWrite,
  type StoredSpecialBank,
} from './specialRateStatus';

function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const setup = readFileSync(join(root, 'supabase/setup/51_client_special_rates_many_banks.sql'), 'utf8');
const migration = readFileSync(join(root, 'supabase/migrations/20261017190000_client_special_rates_many_banks.sql'), 'utf8');
assert(setup === migration, 'setup 51 and the migration are the same bytes');
assert(/add column if not exists active boolean not null default true/.test(setup), 'active defaults true so stored terms stay visible');
assert(/and r\.active/.test(setup), 'the read returns only active rows');
assert(/on conflict \(client_id, bank\)/.test(setup), 'one row per client and bank stays');
assert(/coalesce\(excluded\.comment, s\.comment\)/.test(setup), 'a blank field keeps the stored comment');
assert(/active = true/.test(setup), 'saving a bank sets that row active');
assert(/active = false/.test(setup), 'uncheck stores active false');
assert(!/delete\s+from\s+public\.client_special_rates/i.test(setup), 'uncheck does not delete rows');
assert(!/drop\s+table/i.test(setup), 'the table stays');
assert(!/create\s+table[\s\S]*audit/i.test(setup), 'no new audit table');
assert(!/is_my_client\(v_id\)/.test(setup), 'write does not require is_my_client');
assert(!/my_role\(\) = 'kam' and private\.is_my_client/.test(setup), 'a KAM write is not limited to their book');
assert(!/create\s+or\s+replace\s+function\s+private\.is_my_client/i.test(setup), 'is_my_client stays unchanged');
assert(!/create\s+policy\s+transactions_read/i.test(setup), 'transactions_read stays unchanged');
assert(!/request_abs_valuation/i.test(setup), 'valuation SQL stays untouched');
assert(!/dynamic_active_negotiated/i.test(setup), 'negotiated adjustments stay untouched');
assert(!/insert\s+into\s+public\.requests/i.test(setup), 'special terms do not write a request');
assert(!/update\s+public\.requests/i.test(setup), 'special terms do not update a request');
assert(!/my_role\(\) = 'analyst'/.test(setup), 'an analyst is not granted');
assert(!/my_role\(\) = 'manager'/.test(setup), 'a manager is not granted a write');
assert((setup.match(/can_see_all\(\)/g) || []).length === 1, 'can_see_all stays on the read');
const writeGates = setup.match(/if not \(\s*private\.is_admin\(\)\s*or private\.is_treasury\(\)\s*or private\.my_role\(\) = 'kam'\s*\) then/g);
assert(writeGates?.length === 2, 'save and clear use the same write gate');
assert(/private\.is_my_client\(r\.client_id\)/.test(setup), 'the widened read stays');

const client = '01001001010';
const other = '01001001011';
const blank: Pick<SpecialBankWrite, 'providerLabel' | 'comment' | 'sells' | 'gets' | 'rate'> = {
  providerLabel: null,
  comment: null,
  sells: null,
  gets: null,
  rate: null,
};

function bank(clientId: string, code: SpecialBankWrite['bank'], comment: string, rate: number): SpecialBankWrite {
  return { clientId, bank: code, providerLabel: null, comment, sells: 'USD', gets: 'GEL', rate };
}

let rows: StoredSpecialBank[] = [];
rows = upsertSpecialBank(rows, bank(client, 'TBC', 'tbc term', 2.6));
rows = upsertSpecialBank(rows, bank(client, 'BOG', 'bog term', 2.7));
rows = upsertSpecialBank(rows, bank(other, 'Liberty', 'other client', 3));

const both = visibleSpecialBanks(rows, client);
assert(both.map((row) => row.bank).join(',') === 'TBC,BOG', 'two banks stay stored for one client');
assert(both[0].comment === 'tbc term' && both[1].comment === 'bog term', 'each bank keeps its own term');
assert(specialRateBoxChecked(both.length), 'the box is checked when active banks exist');

rows = upsertSpecialBank(rows, { clientId: client, bank: 'BOG', ...blank });
const afterBlank = visibleSpecialBanks(rows, client);
assert(afterBlank.map((row) => row.bank).join(',') === 'TBC,BOG', 'saving the second bank does not drop the first');
assert(afterBlank.find((row) => row.bank === 'BOG')?.comment === 'bog term', 'a blank field does not erase the saved term');
assert(afterBlank.find((row) => row.bank === 'TBC')?.rate === 2.6, 'the first bank rate stays');

const cleared = clearSpecialBanks(rows, client);
assert(cleared.length === 3, 'uncheck keeps every row');
assert(cleared.filter((row) => row.clientId === client).every((row) => row.active === false), 'uncheck sets active false');
assert(cleared.find((row) => row.bank === 'TBC' && row.clientId === client)?.comment === 'tbc term', 'the cleared row still holds the old term');
assert(visibleSpecialBanks(cleared, client).length === 0, 'the next load does not show the old banks as active');
assert(!specialRateBoxChecked(visibleSpecialBanks(cleared, client).length), 'the next load shows the box unchecked');
assert(visibleSpecialBanks(cleared, other).map((row) => row.bank).join(',') === 'Liberty', 'another client stays active');
assert(specialTermsNeedClear(true, false), 'unchecking a loaded box is the explicit clear');
assert(!specialTermsNeedClear(false, false), 'a client with no active terms is not cleared again');
assert(!specialTermsNeedClear(true, true), 'leaving the box checked does not clear');

const restored = upsertSpecialBank(cleared, { clientId: client, bank: 'TBC', ...blank });
const shown = visibleSpecialBanks(restored, client);
assert(shown.length === 1 && shown[0].bank === 'TBC' && shown[0].comment === 'tbc term', 'saving one bank after a clear does not revive the other');
assert(restored.find((row) => row.clientId === client && row.bank === 'BOG')?.active === false, 'BOG stays inactive until it is saved');

assert(kamMayWriteSpecialRates({ role: 'kam', canViewClient: true }), 'a KAM can write for a client they can open');
assert(!kamMayWriteSpecialRates({ role: 'kam', canViewClient: false }), 'a KAM cannot write a client they cannot open');
assert(kamMayWriteSpecialRates({ role: 'admin', canViewClient: true }), 'an admin can write');
assert(kamMayWriteSpecialRates({ role: 'treasury', canViewClient: true }), 'treasury can write');
assert(!kamMayWriteSpecialRates({ role: 'manager', canViewClient: true }), 'a manager cannot write');
assert(!kamMayWriteSpecialRates({ role: 'analyst', canViewClient: true }), 'an analyst cannot write');

console.log('client special rates ok');
