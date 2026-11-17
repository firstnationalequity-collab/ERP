import { useMemo, type ReactNode } from 'react';
import { Badge, Button, Dropdown, Layout, Menu, Space, Typography } from 'antd';
import { BellOutlined, UserOutlined } from '@ant-design/icons';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { MenuProps } from 'antd';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { visibleMenu } from './menu';

/** Inbox count for the badge; refreshed every minute. */
export function useInboxCount(enabled: boolean) {
  return useQuery({
    queryKey: ['approvals', 'inbox', 'count'],
    queryFn: () => api<{ count: number }>('/core/approvals/inbox/count'),
    enabled,
    refetchInterval: 60_000,
  });
}

export function AppLayout({ children }: { children: ReactNode }) {
  const { user, can, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const inbox = useInboxCount(can('core.approval.inbox'));
  const count = inbox.data?.count ?? 0;

  const items = useMemo<MenuProps['items']>(() => {
    const entries = visibleMenu(user?.permissions ?? []);
    const top = entries.filter((e) => !e.group);
    const groups = [...new Set(entries.filter((e) => e.group).map((e) => e.group))];
    const link = (e: (typeof entries)[number]) => ({
      key: e.path,
      label:
        e.key === 'inbox' ? (
          <Link to={e.path}>
            {e.label} <Badge count={count} size="small" offset={[6, -2]} />
          </Link>
        ) : (
          <Link to={e.path}>{e.label}</Link>
        ),
    });
    return [
      ...top.map(link),
      ...groups.map((g) => ({ type: 'group' as const, key: g ?? '', label: g, children: entries.filter((e) => e.group === g).map(link) })),
    ];
  }, [user, count]);

  const selected = '/' + (location.pathname.split('/').filter(Boolean).slice(0, location.pathname.startsWith('/admin') ? 2 : 1).join('/'));

  const userMenu: MenuProps['items'] = [
    { key: 'password', label: 'Change password', onClick: () => navigate('/change-password') },
    { key: 'logout', label: 'Sign out', onClick: () => void logout() },
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider breakpoint="lg" collapsedWidth={0} width={220} theme="light" style={{ borderRight: '1px solid #f0f0f0' }}>
        <div style={{ padding: '16px 20px', fontWeight: 600, color: '#1f4e79' }}>Albert Pharma ERP</div>
        <Menu mode="inline" selectedKeys={[selected]} items={items} style={{ borderRight: 0 }} />
      </Layout.Sider>
      <Layout>
        <Layout.Header style={{ background: '#fff', padding: '0 16px', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', borderBottom: '1px solid #f0f0f0' }}>
          <Space size="large">
            {can('core.approval.inbox') && (
              <Link to="/approvals" aria-label={`${count} approvals waiting`}>
                <Badge count={count} size="small">
                  <BellOutlined style={{ fontSize: 18 }} />
                </Badge>
              </Link>
            )}
            <Dropdown menu={{ items: userMenu }} trigger={['click']}>
              <Button type="text" icon={<UserOutlined />}>
                <Typography.Text>{user?.fullName}</Typography.Text>
              </Button>
            </Dropdown>
          </Space>
        </Layout.Header>
        <Layout.Content style={{ padding: 16, maxWidth: 1400, width: '100%' }}>{children}</Layout.Content>
      </Layout>
    </Layout>
  );
}
