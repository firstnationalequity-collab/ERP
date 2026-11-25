// Fiscal periods (rule 11): monthly, July–June. Create a year (core.period.manage); close with a reason and
// reopen with the Finance Manager e-signature (core.period.close; owner Q2). Periods close and reopen in order
// (owner Q3): only the earliest open period shows Close, only the latest closed one shows Reopen.
// A closed period refuses every posting dated in it.
import { useMemo, useState } from 'react';
import { App, Button, Form, Input, InputNumber, Modal, Select, Space, Table } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fiscalYearOf, fiscalYearStarting, type FiscalPeriodDto } from '@albert/shared';
import { api, errorText } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ESignModal } from '../../components/ESignModal';
import { PageHeader } from '../../components/PageHeader';
import { StatusTag } from '../../components/StatusTag';
import { companyToday, formatDate } from '../../lib/format';

export function FiscalPeriodsPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const periods = useQuery({ queryKey: ['fiscal-periods'], queryFn: () => api<FiscalPeriodDto[]>('/core/fiscal-periods') });
  const years = useMemo(() => [...new Set((periods.data ?? []).map((p) => p.fiscalYear))].sort().reverse(), [periods.data]);
  const current = fiscalYearOf(companyToday()).label;
  const [year, setYear] = useState<string | undefined>();
  const shown = year ?? (years.includes(current) ? current : years[0]);
  const [creating, setCreating] = useState(false);
  const [acting, setActing] = useState<{ period: FiscalPeriodDto; to: 'close' | 'reopen' } | null>(null);
  // Periods close and reopen in order (owner Q3): find the one period of each kind that can move.
  const sorted = useMemo(() => [...(periods.data ?? [])].sort((a, b) => a.startDate.localeCompare(b.startDate)), [periods.data]);
  const closable = sorted.find((p) => p.status === 'OPEN')?.id;
  const reopenable = [...sorted].reverse().find((p) => p.status === 'CLOSED')?.id;

  return (
    <>
      <PageHeader
        title="Fiscal periods"
        extra={
          <>
            {years.length > 0 && <Select value={shown} onChange={setYear} options={years.map((y) => ({ value: y, label: `FY ${y}` }))} style={{ width: 140 }} />}
            {can('core.period.manage') && <Button type="primary" onClick={() => setCreating(true)}>New fiscal year</Button>}
          </>
        }
      >
        Monthly periods, July to June. Postings dated in a closed period are refused.
      </PageHeader>
      <Table<FiscalPeriodDto>
        rowKey="id"
        loading={periods.isLoading}
        dataSource={(periods.data ?? []).filter((p) => p.fiscalYear === shown)}
        pagination={false}
        locale={{ emptyText: 'No fiscal year yet' }}
        columns={[
          { title: '#', dataIndex: 'periodNo', width: 50 },
          { title: 'Period', dataIndex: 'name' },
          { title: 'From', render: (_, p) => formatDate(p.startDate) },
          { title: 'To', render: (_, p) => formatDate(p.endDate) },
          { title: 'Status', render: (_, p) => <StatusTag status={p.status} /> },
          {
            title: '',
            render: (_, p) =>
              can('core.period.close') && (p.id === closable || p.id === reopenable) && (
                <Button type="link" danger={p.status === 'OPEN'} onClick={() => setActing({ period: p, to: p.status === 'OPEN' ? 'close' : 'reopen' })}>
                  {p.status === 'OPEN' ? 'Close' : 'Reopen'}
                </Button>
              ),
          },
        ]}
      />
      {creating && (
        <CreateYearModal
          onClose={() => setCreating(false)}
          onSaved={async (label) => {
            void message.success(`FY ${label} created`);
            setYear(label);
            await qc.invalidateQueries({ queryKey: ['fiscal-periods'] });
          }}
        />
      )}
      {acting?.to === 'close' && (
        <ReasonModal
          title={`Close ${acting.period.name}`}
          note="No posting dated in this period will be accepted after closing."
          onClose={() => setActing(null)}
          onSubmit={async (reason) => {
            await api(`/core/fiscal-periods/${acting.period.id}/close`, { method: 'POST', body: { reason } });
            void message.success(`${acting.period.name} closed`);
            await qc.invalidateQueries({ queryKey: ['fiscal-periods'] });
          }}
        />
      )}
      <ESignModal
        open={acting?.to === 'reopen'}
        title={`Reopen ${acting?.period.name ?? ''}`}
        meaning="APPROVED"
        summary="Reopening changes reported figures: postings into this period will be accepted again. Your e-signature and reason are recorded."
        okText="Reopen"
        onCancel={() => setActing(null)}
        onSubmit={async (r) => {
          if (!acting) return;
          await api(`/core/fiscal-periods/${acting.period.id}/reopen`, { method: 'POST', body: { signature: r.signature } });
          void message.success(`${acting.period.name} reopened`);
          setActing(null);
          await qc.invalidateQueries({ queryKey: ['fiscal-periods'] });
        }}
      />
    </>
  );
}

function CreateYearModal({ onClose, onSaved }: { onClose(): void; onSaved(label: string): Promise<void> }) {
  const [startYear, setStartYear] = useState<number>(fiscalYearOf(companyToday()).startYear);
  const [error, setError] = useState<string | null>(null);
  const fy = fiscalYearStarting(startYear);
  const save = async () => {
    try {
      await api('/core/fiscal-years', { method: 'POST', body: { startYear } });
      await onSaved(fy.label);
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal open title="New fiscal year" onCancel={onClose} okText="Create 12 periods" onOk={() => void save()}>
      {error && <p style={{ color: '#cf1322' }}>{error}</p>}
      <Space direction="vertical">
        <span>
          Starts in July of <InputNumber min={2020} max={2099} value={startYear} onChange={(v) => setStartYear(v ?? startYear)} />
        </span>
        <span>
          FY {fy.label}: {formatDate(fy.startDate)} to {formatDate(fy.endDate)}, all periods OPEN.
        </span>
      </Space>
    </Modal>
  );
}

export function ReasonModal({ title, note, onClose, onSubmit }: { title: string; note?: string; onClose(): void; onSubmit(reason: string): Promise<void> }) {
  const [form] = Form.useForm<{ reason: string }>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const { reason } = await form.validateFields();
    setBusy(true);
    try {
      await onSubmit(reason);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open title={title} onCancel={onClose} onOk={() => void save()} confirmLoading={busy}>
      {note && <p>{note}</p>}
      {error && <p style={{ color: '#cf1322' }}>{error}</p>}
      <Form form={form} layout="vertical">
        <Form.Item name="reason" label="Reason" rules={[{ required: true, min: 3, message: 'Give a reason (at least 3 characters)' }]}>
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
