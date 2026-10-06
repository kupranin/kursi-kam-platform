import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type Kind = 'ok' | 'error';
interface ToastState { message: string; kind: Kind; id: number }
const ToastContext = createContext<(message: string, kind?: Kind) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const show = useCallback((message: string, kind: Kind = 'ok') => {
    const id = Date.now();
    setToast({ message, kind, id });
    window.setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), kind === 'error' ? 8000 : 5000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-area" aria-live="polite">
        {toast && (
          <div className={'toast toast-' + toast.kind} role={toast.kind === 'error' ? 'alert' : 'status'}>
            <span>{toast.message}</span>
            <button type="button" className="link" onClick={() => setToast(null)} aria-label="Close">×</button>
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
