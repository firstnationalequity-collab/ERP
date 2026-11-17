import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import enGB from 'antd/locale/en_GB';
import { ApiRequestError } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { App } from './App';

// Do not retry refusals (4xx): they will not change by trying again.
const retry = (count: number, err: unknown) => !(err instanceof ApiRequestError && err.status < 500) && count < 2;

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry, refetchOnWindowFocus: false }, mutations: { retry: false } },
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element missing');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ConfigProvider locale={enGB} theme={{ token: { colorPrimary: '#1f4e79', borderRadius: 6 } }}>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </AuthProvider>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
