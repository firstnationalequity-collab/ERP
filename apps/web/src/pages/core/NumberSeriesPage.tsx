// Number series (core.settings.manage; decision Q16). Patterns are checked live with the shared rules, so a
// pattern that would repeat numbers after a reset cannot be saved.
import { useState } from 'react';
import { Alert, App, Button, Form, Input, Modal, Select, Table, Typography } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NumberSeriesReset, formatDocNo, numberPatternErrors, type NumberSeriesDto } from '@albert/shared';
import { api, errorText } from '../../api/client';
import { PageHeader } from '../../components/PageHeader';
import { companyToday } from '../../lib/format';

const RESET_LABEL: Record<NumberSeriesReset, string> = {
  FISCAL_YEAR: 'Each fiscal year (1 July)',
  CALENDAR_YEAR: 'Each calendar year (1 January)',
  NEVER: 'Never',
};

interface Values {
  docType: string;
  name: string;
  prefix: string;
  pattern: string;
  reset: NumberSeriesReset;
  reason: string;
}

export function NumberSeriesPage() {
  const qc = useQueryClient();
  const series = useQuery({ queryKey: ['number-series'], queryFn: () => api<NumberSeriesDto[]>('/core/number-series') });
  const [editing, setEditing] = useState<{ row: NumberSeriesDto | null } | null>(null);
  return (
    <>
      <PageHeader title="Number series" extra={<Button type="primary" onClick={() => setEditing({ row: null })}>New series</Button>}>
        Tokens: {'{PREFIX} {FY} {YYYY} {YY} {SEQ:n}'}. FY 2026-27 is written 2627. Numbers already issued keep their format.
      </PageHeader>
      <Table<NumberSeriesDto>
        rowKey="id"
        loading={series.isLoading}
        dataSource={series.data ?? []}
        pagination={false}
        scroll={{ x: true }}
        columns={[
          { title: 'Document', dataIndex: 'docType' },
          { title: 'Name', dataIndex: 'name' },
          { title: 'Pattern', render: (_, s) => <Typography.Text code>{s.pattern}</Typography.Text> },
          { title: 'Prefix', dataIndex: 'prefix' },
          { title: 'Restarts', render: (_, s) => RESET_LABEL[s.reset] },
          { title: 'Next number', render: (_, s) => <Typography.Text strong>{s.preview}</Typography.Text> },
          { title: '', render: (_, s) => <Button type="link" onClick={() => setEditing({ row: s })}>Edit</Button> },
        ]}
      />
      {editing && <SeriesModal row={editing.row} onClose={() => setEditing(null)} onSaved={() => qc.invalidateQueries({ queryKey: ['number-series'] })} />}
    </>
  );
}

function SeriesModal({ row, onClose, onSaved }: { row: NumberSeriesDto | null; onClose(): void; onSaved(): unknown }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<Values>();
  const pattern = Form.useWatch('pattern', form) ?? row?.pattern ?? '';
  const reset = Form.useWatch('reset', form) ?? row?.reset ?? 'FISCAL_YEAR';
  const prefix = Form.useWatch('prefix', form) ?? row?.prefix ?? '';
  const problems = pattern ? numberPatternErrors(pattern, reset) : [];
  const example = problems.length === 0 && pattern ? formatDocNo(pattern, { prefix, date: companyToday(), seq: 1 }) : null;
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const v = await form.validateFields();
    try {
      if (row) {
        await api(`/core/number-series/${row.id}`, { method: 'PATCH', body: { name: v.name, prefix: v.prefix, pattern: v.pattern, reset: v.reset, reason: v.reason } });
      } else {
        await api('/core/number-series', { method: 'POST', body: v });
      }
      void message.success('Saved');
      await onSaved();
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <Modal open title={row ? `Edit ${row.docType}` : 'New number series'} onCancel={onClose} onOk={() => void save()} okButtonProps={{ disabled: problems.length > 0 }}>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <Form form={form} layout="vertical" initialValues={row ?? { reset: 'FISCAL_YEAR', pattern: '{PREFIX}-{FY}-{SEQ:5}' }}>
        {!row && (
          <Form.Item name="docType" label="Document type code" rules={[{ required: true, pattern: /^[A-Z][A-Z0-9_]{1,29}$/, message: 'Upper case code, e.g. GRN' }]}>
            <Input />
          </Form.Item>
        )}
        <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="prefix" label="Prefix" rules={[{ pattern: /^[A-Za-z0-9]{0,10}$/, message: 'Up to 10 letters or digits' }]}><Input /></Form.Item>
        <Form.Item name="pattern" label="Pattern" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="reset" label="Restart numbering">
          <Select options={NumberSeriesReset.map((r) => ({ value: r, label: RESET_LABEL[r] }))} />
        </Form.Item>
        {problems.length > 0 && <Alert type="error" showIcon message={problems.join(' ')} style={{ marginBottom: 12 }} />}
        {example && <Typography.Paragraph>First number today would look like <Typography.Text strong>{example}</Typography.Text></Typography.Paragraph>}
        <Form.Item name="reason" label="Reason" rules={[{ required: true, min: 3 }]}><Input /></Form.Item>
      </Form>
    </Modal>
  );
}
