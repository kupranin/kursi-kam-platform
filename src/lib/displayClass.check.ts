import { displayClass, isHistoricalRequest } from './displayClass';

function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

assert(displayClass({ source: 'import', legacy_status: 'შესრულდა' }) === 'won', 'შესრულდა is won');
assert(displayClass({ source: 'import', import_key: 'agreement:1', legacy_status: 'შესრულდა ნაწილობრივ' }) === 'won', 'ნაწილობრივ is won');
assert(displayClass({ source: 'import', legacy_status: 'შეთანხმებულია და გაწერეთ კურსი' }) === 'lost', 'waiting text is lost');
assert(displayClass({ source: 'import', legacy_status: '' }) === 'lost', 'blank file status is lost');
assert(displayClass({ source: 'import', legacy_status: null }) === 'lost', 'missing file status is lost');
assert(displayClass({ import_key: 'agreement:9', legacy_status: 'რაღაც უცნობი' }) === 'lost', 'unknown text is lost');
assert(displayClass({ source: 'import', legacy_status: 'არ შესრულდა' }) === 'lost', 'refusal is lost');
assert(displayClass({ source: 'import', legacy_status: 'ბანკმა გააჩერა ტრანზაქცია' }) === 'lost', 'bank stop is lost');

const imported = [
  'შესრულდა',
  'შესრულდა ნაწილობრივ',
  'შეთანხმებულია და გაწერეთ კურსი',
  'არ შესრულდა',
  'აღარ დასჭირდა და გააუქმა',
  'უარი თქვა, მცირედი განსხვავების გამო ბანკში ურჩევნოდა კონვერტაცია',
  '',
  'not a known status',
].map((legacy_status) => displayClass({ source: 'import', import_key: 'agreement:1', legacy_status }));
assert(imported.every((klass) => klass !== 'open'), 'no imported row is open');
assert(imported.filter((klass) => klass === 'won').length === 2, 'only the two completed file statuses are won');

const staleApp = displayClass({
  source: 'app',
  import_key: null,
  legacy_status: 'არ შესრულდა',
  rate_written_at: null,
});
assert(staleApp === 'open', 'an app row with no rate_written_at and no decline stays open');
assert(!isHistoricalRequest({ source: 'app', import_key: null }), 'a normal app row is not historical');
assert(displayClass({ source: 'app', rate_written_at: '2026-10-17T10:00:00Z' }) === 'won', 'a written app rate is won');
assert(displayClass({ source: 'app', client_reply: 'declined' }) === 'lost', 'an app decline is lost');
assert(displayClass({ source: 'app', outcome: 'did_not_go_through' } as { source: string }) === 'open', 'an outcomes label alone does not lose an app row');

console.log('display class ok');
