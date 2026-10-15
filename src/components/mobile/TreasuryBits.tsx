import { minutesSince, sideAmount } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { useTick } from '../../lib/useLive';
import { formatBanks } from '../../lib/types';

export function clientName(name: string | null | undefined, id: string): string {
  const trimmed = name?.trim();
  return trimmed || id;
}

export function pairText(sells: string, gets: string): string {
  if (!sells || !gets) return '';
  return sells + '/' + gets;
}

export function WaitClock({ iso }: { iso: string | null | undefined }) {
  const { t } = useI18n();
  useTick(10000);
  if (!iso) return null;
  const mins = minutesSince(iso);
  const label = mins < 1
    ? t('ახლახან', 'Just now')
    : t('ელოდება {n} წთ', 'Waiting {n} min', { n: mins });
  return <div className={'m-card-time' + (mins >= 2 ? ' is-wait' : '')}>{label}</div>;
}

export function Fact({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <p className="m-fact">
      <span className="m-fact-label">{label}</span>
      <span className="m-fact-value">{value}</span>
    </p>
  );
}

export function DealFacts({
  sells,
  gets,
  amount,
  getsAmount,
  bank,
}: {
  sells: string;
  gets: string;
  amount: number | null;
  getsAmount: number | null | undefined;
  bank?: string[];
}) {
  const { t } = useI18n();
  const banks = formatBanks(bank);
  return (
    <div className="m-facts">
      {pairText(sells, gets) && <p className="m-focal-pair">{pairText(sells, gets)}</p>}
      <Fact label={t('კლიენტი ყიდის', 'Client sells')} value={sideAmount(sells, amount)} />
      <Fact label={t('კლიენტი იღებს', 'Client gets')} value={sideAmount(gets, getsAmount)} />
      {banks && <Fact label={t('ბანკი', 'Bank')} value={banks} />}
    </div>
  );
}
