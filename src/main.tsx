import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './lib/auth';
import { LanguageProvider } from './lib/i18n';
import { ToastProvider } from './lib/toast';
import { ViewAsProvider } from './lib/viewAs';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <LanguageProvider>
        <AuthProvider>
          <ViewAsProvider>
            <ToastProvider>
              <App />
            </ToastProvider>
          </ViewAsProvider>
        </AuthProvider>
      </LanguageProvider>
    </BrowserRouter>
  </StrictMode>,
);
