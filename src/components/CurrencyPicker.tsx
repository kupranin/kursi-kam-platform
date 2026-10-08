import { CURRENCIES } from '../lib/types';

interface Props {
  label: string;
  value: string;
  onChange: (c: string) => void;
  disabledValue?: string;
  /** Keeps two pickers on one page from sharing an id. */
  idSuffix?: string;
}

export default function CurrencyPicker({ label, value, onChange, disabledValue, idSuffix }: Props) {
  const id = 'cur-' + label.replace(/\s+/g, '-').toLowerCase() + (idSuffix ? '-' + idSuffix : '');
  const known = CURRENCIES as readonly string[];
  const codes = known.includes(value) || !/^[A-Z]{3}$/.test(value) ? CURRENCIES : [...CURRENCIES, value];
  return (
    <div className="field">
      <span className="label" id={id}>{label}</span>
      <div className="seg" role="group" aria-labelledby={id}>
        {codes.map((c) => (
          <button key={c} type="button" aria-pressed={value === c} disabled={c === disabledValue} onClick={() => onChange(c)}>
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}
