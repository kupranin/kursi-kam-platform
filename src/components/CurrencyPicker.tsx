import { CURRENCIES } from '../lib/types';

interface Props {
  label: string;
  value: string;
  onChange: (c: string) => void;
  disabledValue?: string;
}

export default function CurrencyPicker({ label, value, onChange, disabledValue }: Props) {
  const id = 'cur-' + label.replace(/\s+/g, '-').toLowerCase();
  return (
    <div className="field">
      <span className="label" id={id}>{label}</span>
      <div className="seg" role="group" aria-labelledby={id}>
        {CURRENCIES.map((c) => (
          <button key={c} type="button" aria-pressed={value === c} disabled={c === disabledValue} onClick={() => onChange(c)}>
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}
