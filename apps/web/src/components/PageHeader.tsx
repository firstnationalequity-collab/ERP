import type { ReactNode } from 'react';
import { Space, Typography } from 'antd';

export function PageHeader({ title, extra, children }: { title: string; extra?: ReactNode; children?: ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {extra && <Space wrap>{extra}</Space>}
      </div>
      {children && <Typography.Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 0 }}>{children}</Typography.Paragraph>}
    </div>
  );
}
