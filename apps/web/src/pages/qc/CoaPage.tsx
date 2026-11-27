// Certificates of analysis (M4 task 4; 0039). The QC Manager (qc.coa.issue) issues one certificate per QC approval of
// a material lot with an e-signature (APPROVED); the PDF is stored with its SHA-256 and checked on every download.
// Lots waiting for a certificate are listed first. Finished-goods certificates follow QA release (M7).
import { useState } from 'react';
import { App, Button, Table, Typography } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CoaCandidateDto, CoaDto } from '@albert/shared';
import { api, apiBlob, errorText } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DataTable } from '../../components/DataTable';
import { ESignModal } from '../../components/ESignModal';
import { PageHeader } from '../../components/PageHeader';
import { formatDateTime } from '../../lib/format';

const queryKey = ['qc', 'coas'];

export function CoaPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [issuing, setIssuing] = useState<CoaCandidateDto | null>(null);
  const issuer = can('qc.coa.issue');
  const { data: candidates = [] } = useQuery({ queryKey: [...queryKey, 'candidates'], queryFn: () => api<CoaCandidateDto[]>('/qc/coas/candidates') });

  const openPdf = async (c: CoaDto) => {
    try {
      const url = URL.createObjectURL(await apiBlob(`/qc/coas/${c.id}/pdf`));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      void message.error(errorText(err));
    }
  };

  return (
    <>
      <PageHeader title="Certificates of analysis">
        One certificate per QC approval of a material lot, issued with an e-signature. The stored PDF is checked against its fingerprint every time it is opened.
      </PageHeader>
      <Typography.Title level={5}>Approved lots waiting for a certificate</Typography.Title>
      <Table<CoaCandidateDto>
        rowKey="dispositionId"
        size="small"
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        dataSource={candidates}
        locale={{ emptyText: 'Every approved lot has its certificate' }}
        columns={[
          { title: 'Lot', dataIndex: 'lotNo' },
          { title: 'Item', render: (_, c) => `${c.itemCode} — ${c.itemName}` },
          { title: 'Approved', render: (_, c) => `${formatDateTime(c.approvedAt)} · ${c.approvedByName}` },
          {
            title: '',
            render: (_, c) =>
              issuer ? (
                <Button type="link" onClick={() => setIssuing(c)}>
                  Issue certificate
                </Button>
              ) : null,
          },
        ]}
        style={{ marginBottom: 24 }}
      />
      <DataTable<CoaDto>
        title="Issued certificates"
        path="/qc/coas"
        queryKey={queryKey}
        searchPlaceholder="Search certificate number, lot number, item code or name"
        rowKey={(r) => r.id}
        columns={[
          { key: 'docNo', title: 'Certificate' },
          { key: 'lotNo', title: 'Lot' },
          { key: 'itemCode', title: 'Item', render: (r) => `${r.itemCode} — ${r.itemName}`, exportValue: (r) => `${r.itemCode} — ${r.itemName}` },
          { key: 'issuedAt', title: 'Issued', render: (r) => `${formatDateTime(r.issuedAt)} · ${r.issuedByName}`, exportValue: (r) => `${formatDateTime(r.issuedAt)} · ${r.issuedByName}` },
          { key: 'sha256', title: 'SHA-256', render: (r) => <Typography.Text code copyable={{ text: r.sha256 }}>{r.sha256.slice(0, 12)}…</Typography.Text>, exportValue: (r) => r.sha256 },
        ]}
        actions={(r) => <Button type="link" onClick={() => void openPdf(r)}>Open PDF</Button>}
      />
      <ESignModal
        open={issuing !== null}
        title={issuing ? `Issue certificate for lot ${issuing.lotNo}` : 'Issue certificate'}
        meaning="APPROVED"
        summary={issuing ? `You issue the certificate of analysis for lot ${issuing.lotNo} (${issuing.itemCode}), reporting its QC approval. It cannot be changed afterwards.` : ''}
        okText="Issue"
        onCancel={() => setIssuing(null)}
        onSubmit={async (r) => {
          await api('/qc/coas', { method: 'POST', body: { lotId: issuing!.lotId, signature: r.signature } });
          void message.success('Certificate issued');
          setIssuing(null);
          await qc.invalidateQueries({ queryKey });
        }}
      />
    </>
  );
}
