import { useEffect, useState } from 'react';
import { fmtDateTime, fmtRate } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { loadDynamicActiveNegotiatedRates } from '../lib/negotiatedRateLoad';
import { formatAdjustment, type NegotiatedView } from '../lib/negotiatedRates';

/**
 * Warning only. Shows both calculated results and both adjustments.
 * It does not write a rate, and it does not fill the treasury quote or the request.
 */
export default function DynamicActiveNegotiatedRates({ clientId, idSuffix }: { clientId: string | null; idSuffix: string }) {
  const { t } = useI18n();
  const [pack, setPack] = useState<{ id: string; rows: NegotiatedView[] } | null>(null);
  const id = clientId?.trim() || '';
  const rows = pack && pack.id === id ? pack.rows : [];
  const titleId = 'negotiated-warn-' + idSuffix;

  useEffect(() => {
    if (!id) return;
    let live = true;
    loadDynamicActiveNegotiatedRates(id)
      .then((next) => {
        if (live) setPack({ id, rows: next });
      })
      .catch(() => {
        if (live) setPack({ id, rows: [] });
      });
    return () => {
      live = false;
    };
  }, [id]);

  if (!rows.length) return null;

  const groups: NegotiatedView[][] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last[0].pair === row.pair) last.push(row);
    else groups.push([row]);
  }

  return (
    <aside className="negotiated-warn" aria-labelledby={titleId}>
      <h3 id={titleId} className="small strong">{t('აქტიური შეთანხმებული კორექტირება', 'Active negotiated adjustment')}</h3>
      <p className="tiny">{t(
        'მხოლოდ გაფრთხილება. ეს რიცხვები კურსის ველში არ იწერება და მოთხოვნის არც ერთ მხარეს არ ეწერება.',
        'Warning only. These numbers are not written into the rate field, and they are not written onto either side of the request.',
      )}</p>
      {groups.map((group) => (
        <div key={group[0].pair} className="negotiated-warn-pair">
          <p className="small strong">{group[0].pair}</p>
          {group[0].tied && (
            <p className="tiny">{t('ერთ დროს რამდენიმე ჩანაწერია. არც ერთი არ არის არჩეული.', 'Several entries share this time. None is chosen.')}</p>
          )}
          {group.map((row, index) => (
            <div key={row.id}>
              {group.length > 1 && (
                <p className="tiny">{t('ჩანაწერი {n}', 'Entry {n}', { n: index + 1 })}</p>
              )}
              <dl className="negotiated-warn-facts">
                <div>
                  <dt>{t('ყიდვის კორექტირება', 'Buy adjustment')}</dt>
                  <dd>{row.buyRate == null ? t('არ არის', 'Not set') : formatAdjustment(row.buyRate)}</dd>
                </div>
                <div>
                  <dt>{t('გაყიდვის კორექტირება', 'Sell adjustment')}</dt>
                  <dd>{row.sellRate == null ? t('არ არის', 'Not set') : formatAdjustment(row.sellRate)}</dd>
                </div>
                {row.midpoint != null && (
                  <div>
                    <dt>{t('სტანდარტის შუა წერტილი ახლა', 'Standard midpoint now')}</dt>
                    <dd>{fmtRate(row.midpoint)}</dd>
                  </div>
                )}
                <div>
                  <dt>{t('შედეგი: კლიენტის ყიდვა', 'Result: client buy')}</dt>
                  <dd>{row.clientBuy == null ? t('არ ითვლება', 'Not calculated') : fmtRate(row.clientBuy)}</dd>
                </div>
                <div>
                  <dt>{t('შედეგი: კლიენტის გაყიდვა', 'Result: client sell')}</dt>
                  <dd>{row.clientSell == null ? t('არ ითვლება', 'Not calculated') : fmtRate(row.clientSell)}</dd>
                </div>
                <div>
                  <dt>{t('ვადა', 'Expires')}</dt>
                  <dd>{row.expiresAt ? fmtDateTime(row.expiresAt) : t('ვადა არ არის მითითებული', 'No expiry is set')}</dd>
                </div>
              </dl>
              {row.midpoint == null && (
                <p className="tiny">{t(
                  'ახლანდელი სტანდარტული კურსი არ ჩანს, ამიტომ შედეგი არ ითვლება.',
                  'The current standard rate is not available, so the result is not calculated.',
                )}</p>
              )}
            </div>
          ))}
        </div>
      ))}
    </aside>
  );
}
