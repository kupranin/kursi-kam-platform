import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider, PreviewAuth } from './lib/auth';
import { LanguageProvider } from './lib/i18n';
import { ToastProvider } from './lib/toast';
import { ViewAsProvider } from './lib/viewAs';
import PhonePreview from './phonePreview';
import './styles.css';

const preview = new URLSearchParams(window.location.search).get('preview') === 'phone';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <LanguageProvider>
        {preview ? (
          <PreviewAuth>
            <ViewAsProvider>
              <ToastProvider>
                <PhonePreview />
              </ToastProvider>
            </ViewAsProvider>
          </PreviewAuth>
        ) : (
          <AuthProvider>
            <ViewAsProvider>
              <ToastProvider>
                <App />
              </ToastProvider>
            </ViewAsProvider>
          </AuthProvider>
        )}
      </LanguageProvider>
    </BrowserRouter>
  </StrictMode>,
);
