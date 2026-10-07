import { useState } from 'react';
import { useI18n } from '../lib/i18n';

export default function CopyLine({ label, text }: { label: string; text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try { await navigator.clipboard.writeText(text); } catch { /* the line stays on screen */ }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="copy-line">
      <div className="tiny muted">{label}</div>
      <div className="copy-line-row">
        <p className="copy-line-text">{text}</p>
        <button type="button" className="btn" onClick={copy}>{copied ? t('დაკოპირდა', 'Copied') : t('კოპირება', 'Copy')}</button>
      </div>
    </div>
  );
}
