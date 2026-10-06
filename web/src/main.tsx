import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { createQueryClient } from './api/queries';
import { App } from './App';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/pages.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing the #root element');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient()}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
