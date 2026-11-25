// Daily exchange rates (owner 2026-11-25, Q4): PKR per 1 unit, one per currency and date, kept by the Finance
// Manager (fin.rate.manage). Documents (PO submit, GRN, invoices) use the rate of their own date and copy it;
// a missing rate stops them (RATE_MISSING). A correction needs a reason and is kept in the audit trail.
import { useState } from 'react';
import { App, Button, Input, Space, Table } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SetExchangeRateRequest, type ExchangeRateDto } from '@albert/shared';
import { api, errorText } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DocForm } from '../../components/DocForm';
import { PageHeader } from '../../components/PageHeader';
import { companyToday, formatDate, formatDateTime, formatDecimal } from '../../lib/format';

const queryKey = ['fin', 'exchange-rates'];

export function ExchangeRatesPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [currency, setCurrency] = useState('');
  const [editing, setEditing] = useState<Partial<ExchangeRateDto> | null>(null);
  const list = useQuery({
    queryKey: [...queryKey, currency],
    queryFn: () => api<ExchangeRateDto[]>(`/fin/exchange-rates${/^[A-Z]{3}$/.test(currency) ? `?currency=${currency}` : ''}`),
  });
  const manage = can('fin.rate.manage');
  return (
    <>
      <PageHeader
        title="Exchange rates"
        extra={
          <Space>
            <Input aria-label="Filter by currency" placeholder="Currency (e.g. USD)" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} style={{ width: 170 }} />
            {manage && <Button type="primary" onClick={() => setEditing({ rateDate: companyToday(), source: 'SBP' })}>Enter rate</Button>}
          </Space>
        }
      >
        PKR per 1 unit of foreign currency, one rate per day. A document dated on a day without a rate is refused.
      </PageHeader>
      <Table<ExchangeRateDto>
        rowKey="id"
        loading={list.isLoading}
        dataSource={list.data ?? []}
        pagination={{ pageSize: 50 }}
        locale={{ emptyText: list.error ? errorText(list.error) : 'No rates yet' }}
        columns={[
          { title: 'Date', render: (_, r) => formatDate(r.rateDate) },
          { title: 'Currency', dataIndex: 'currency' },
          { title: 'Rate (PKR)', render: (_, r) => formatDecimal(r.rate, 4) },
          { title: 'Source', dataIndex: 'source' },
          { title: 'Last changed', render: (_, r) => `${r.updatedBy}, ${formatDateTime(r.updatedAt)}` },
          { title: '', render: (_, r) => manage && <Button type="link" onClick={() => setEditing(r)}>Correct</Button> },
        ]}
      />
      {editing && (
        <DocForm
          open
          title={editing.id ? `Correct ${editing.currency} rate of ${formatDate(editing.rateDate)}` : 'Enter exchange rate'}
          mode={editing.id ? 'edit' : 'create'}
          schema={SetExchangeRateRequest}
          initialValues={{ currency: editing.currency ?? '', rateDate: editing.rateDate, rate: editing.rate ?? '', source: editing.source ?? '' }}
          fields={[
            { name: 'currency', label: 'Currency', kind: 'text', disabled: !!editing.id },
            { name: 'rateDate', label: 'Date', kind: 'date', disabled: !!editing.id },
            { name: 'rate', label: 'Rate (PKR per 1 unit)', kind: 'decimal' },
            { name: 'source', label: 'Source', kind: 'text' },
            ...(editing.id ? [{ name: 'reason', label: 'Reason for the correction', kind: 'textarea' as const }] : []),
          ]}
          onCancel={() => setEditing(null)}
          onSubmit={async (values) => {
            await api('/fin/exchange-rates', { method: 'POST', body: values });
            void message.success('Rate saved');
            setEditing(null);
            await qc.invalidateQueries({ queryKey });
          }}
        />
      )}
    </>
  );
}
