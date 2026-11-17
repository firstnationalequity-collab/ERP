import { Layout, Typography } from 'antd';
import { Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './api/client';

// Login, permission-driven sidebar and module pages are built in M1 (docs/build-plan.md).

function Home() {
  const health = useQuery({ queryKey: ['health'], queryFn: () => api<{ status: string }>('/health') });
  return (
    <Typography.Paragraph>
      API status: {health.isLoading ? 'checking…' : health.data?.status ?? 'unreachable'}
    </Typography.Paragraph>
  );
}

export function App() {
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header style={{ color: '#fff', fontWeight: 600 }}>Albert Pharma ERP</Layout.Header>
      <Layout.Content style={{ padding: 24 }}>
        <Routes>
          <Route path="/" element={<Home />} />
        </Routes>
      </Layout.Content>
    </Layout>
  );
}
