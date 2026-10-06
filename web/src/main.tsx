import { QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { createQueryClient } from './api/queries';
import { App } from './App';
import './index.css';

// Toasts only follow an action, so their code can arrive after the page has painted.
const Toaster = lazy(() => import('./components/ui/sonner').then((module) => ({ default: module.Toaster })));

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing the #root element');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient()}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
      <Suspense fallback={null}>
        <Toaster position="bottom-right" />
      </Suspense>
    </QueryClientProvider>
  </StrictMode>,
);
