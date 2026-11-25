// Approved sources / AVL (M2 Q4): the Purchase Officer proposes vendor + item + manufacturer + site (PENDING; an
// approval starts at once), attaches the evidence, and the QA Manager approves in "My approvals" — refused while
// nothing is attached. The QA Manager blocks an approved source here with an e-signature.
import { useState } from 'react';
import { App, Button, Descriptions, Drawer, Typography } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { ApprovedSourceStatus, AvlItemTypes, CreateApprovedSourceRequest, type ApprovedSourceDto } from '@albert/shared';
import { api, newIdempotencyKey } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { AttachmentsPanel } from '../../components/Attachments';
import { DataTable, statusFilter } from '../../components/DataTable';
import { DocForm } from '../../components/DocForm';
import { ESignModal } from '../../components/ESignModal';
import { PageHeader } from '../../components/PageHeader';
import { StatusTag } from '../../components/StatusTag';
import { formatDateTime } from '../../lib/format';

const SOURCE_TABLE = 'master.approved_sources';

export function ApprovedSourcesPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const queryKey = ['master', 'approved-sources'];
  const refresh = () => qc.invalidateQueries({ queryKey });
  const [proposing, setProposing] = useState(false);
  const [open, setOpen] = useState<ApprovedSourceDto | null>(null);
  const [blocking, setBlocking] = useState(false);

  return (
    <>
      <PageHeader title="Approved sources (AVL)" extra={can('master.vendor.manage') && <Button type="primary" onClick={() => setProposing(true)}>Propose a source</Button>}>
        Which manufacturer and site a vendor may supply each GMP material from. A proposal waits in the QA Manager's approvals; attach the
        evidence (questionnaire, audit report, sample CoA) before QA signs.
      </PageHeader>
      <DataTable<ApprovedSourceDto>
        title="Approved sources"
        path="/master/approved-sources"
        queryKey={queryKey}
        filters={[statusFilter(ApprovedSourceStatus)]}
        searchPlaceholder="Search vendor, item or manufacturer"
        onRowClick={setOpen}
        columns={[
          { key: 'vendorCode', title: 'Vendor', render: (r) => `${r.vendorCode} — ${r.vendorName}`, exportValue: (r) => `${r.vendorCode} — ${r.vendorName}` },
          { key: 'itemCode', title: 'Item', render: (r) => `${r.itemCode} — ${r.itemName}`, exportValue: (r) => `${r.itemCode} — ${r.itemName}` },
          { key: 'manufacturer', title: 'Manufacturer' },
          { key: 'manufacturingSite', title: 'Site' },
          { key: 'status', title: 'Status', render: (r) => <StatusTag status={r.status} /> },
          { key: 'updatedAt', title: 'Updated', render: (r) => formatDateTime(r.updatedAt), exportValue: (r) => formatDateTime(r.updatedAt) },
        ]}
        actions={(r) => <Button type="link" onClick={() => setOpen(r)}>Open</Button>}
      />

      <DocForm
        open={proposing}
        title="Propose an approved source"
        mode="create"
        schema={CreateApprovedSourceRequest}
        intro={<Typography.Paragraph type="secondary">Only GMP materials ({AvlItemTypes.join(', ')}) and active vendors. The approval starts when you save.</Typography.Paragraph>}
        fields={[
          { name: 'vendorId', label: 'Vendor', kind: 'ref', path: '/master/vendors', params: { status: 'ACTIVE' } },
          { name: 'itemId', label: 'Item', kind: 'ref', path: '/master/items', params: { status: 'ACTIVE' } },
          { name: 'manufacturer', label: 'Manufacturer', kind: 'text' },
          { name: 'manufacturingSite', label: 'Manufacturing site (address)', kind: 'textarea' },
          { name: 'notes', label: 'Notes', kind: 'textarea' },
        ]}
        onCancel={() => setProposing(false)}
        onSubmit={async (values) => {
          const created = await api<ApprovedSourceDto>('/master/approved-sources', { method: 'POST', body: values });
          void message.success('Proposed. Attach the evidence now; QA approves it in My approvals.');
          setProposing(false);
          await refresh();
          setOpen(created);
        }}
      />

      <Drawer open={open !== null} onClose={() => setOpen(null)} width={640} title="Approved source">
        {open && (
          <>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="Status"><StatusTag status={open.status} /></Descriptions.Item>
              <Descriptions.Item label="Vendor">{open.vendorCode} — {open.vendorName}</Descriptions.Item>
              <Descriptions.Item label="Item">{open.itemCode} — {open.itemName}</Descriptions.Item>
              <Descriptions.Item label="Manufacturer">{open.manufacturer}</Descriptions.Item>
              <Descriptions.Item label="Site">{open.manufacturingSite}</Descriptions.Item>
              {open.notes && <Descriptions.Item label="Notes">{open.notes}</Descriptions.Item>}
            </Descriptions>
            <Typography.Title level={5} style={{ marginTop: 16 }}>Evidence</Typography.Title>
            <AttachmentsPanel recordTable={SOURCE_TABLE} recordId={open.id} canUpload={can('master.vendor.manage')} gmp />
            {open.status === 'APPROVED' && can('master.avl.approve') && (
              <Button danger style={{ marginTop: 16 }} onClick={() => setBlocking(true)}>
                Block this source
              </Button>
            )}
          </>
        )}
      </Drawer>

      <ESignModal
        open={blocking}
        title="Block approved source"
        meaning="REJECTED"
        summary={open ? `Block ${open.manufacturer} (${open.manufacturingSite}) for ${open.itemCode} from ${open.vendorCode}. It can no longer be used on new orders.` : undefined}
        okText="Block"
        onCancel={() => setBlocking(false)}
        onSubmit={async (r) => {
          if (!open) return;
          const updated = await api<ApprovedSourceDto>(`/master/approved-sources/${open.id}/block`, {
            method: 'POST',
            body: { signature: r.signature },
            idempotencyKey: newIdempotencyKey(),
          });
          void message.success('Source blocked');
          setBlocking(false);
          setOpen(updated);
          await refresh();
        }}
      />
    </>
  );
}
