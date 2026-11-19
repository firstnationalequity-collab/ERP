// Price lists (Sales Manager, master.price.manage): a list per customer or general, with a validity range, and
// lines of item + unit + price. Lines are deactivated, never deleted.
import { useState } from 'react';
import { App, Button, Drawer, Space, Table } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CreatePriceListLineRequest,
  CreatePriceListRequest,
  UpdatePriceListLineRequest,
  UpdatePriceListRequest,
  type PriceListDto,
  type PriceListLineDto,
} from '@albert/shared';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ACTIVE_FILTER } from '../../components/DataTable';
import { DocForm, type FieldDef } from '../../components/DocForm';
import { ReasonModal } from '../../components/ReasonModal';
import { RefLabel } from '../../components/RefSelect';
import { StatusTag } from '../../components/StatusTag';
import { formatDate, formatDecimal } from '../../lib/format';
import { MasterPage } from './MasterPage';

const listFields: FieldDef[] = [
  { name: 'name', label: 'Name', kind: 'text' },
  { name: 'customerId', label: 'Customer (empty = general list)', kind: 'ref', path: '/master/customers', nullable: true },
  { name: 'currency', label: 'Currency (ISO)', kind: 'text' },
  { name: 'validFrom', label: 'Valid from', kind: 'date' },
  { name: 'validTo', label: 'Valid to (empty = open-ended)', kind: 'date', nullable: true },
];

export function PriceListsPage() {
  const [open, setOpen] = useState<PriceListDto | null>(null);
  return (
    <>
      <MasterPage<PriceListDto, typeof CreatePriceListRequest, typeof UpdatePriceListRequest>
        config={{
          title: 'Price lists',
          path: '/master/price-lists',
          noun: 'price list',
          manageKey: 'master.price.manage',
          filters: [ACTIVE_FILTER],
          onRowClick: setOpen,
          columns: [
            { key: 'code', title: 'Code' },
            { key: 'name', title: 'Name' },
            { key: 'customerId', title: 'Customer', render: (r) => (r.customerId ? <RefLabel path="/master/customers" id={r.customerId} /> : 'General') },
            { key: 'currency', title: 'Currency' },
            { key: 'validFrom', title: 'Valid from', render: (r) => formatDate(r.validFrom), exportValue: (r) => formatDate(r.validFrom) },
            { key: 'validTo', title: 'Valid to', render: (r) => formatDate(r.validTo), exportValue: (r) => formatDate(r.validTo) },
            { key: 'isActive', title: 'Status', render: (r) => <StatusTag status={r.isActive ? 'ACTIVE' : 'INACTIVE'} />, exportValue: (r) => (r.isActive ? 'ACTIVE' : 'INACTIVE') },
          ],
          isActive: (r) => r.isActive,
          create: { schema: CreatePriceListRequest, initial: { currency: 'PKR' }, fields: [{ name: 'code', label: 'Code', kind: 'text' }, ...listFields] },
          edit: {
            schema: UpdatePriceListRequest,
            readOnly: (r) => [{ label: 'Code', value: r.code }],
            initial: (r) => ({ name: r.name, customerId: r.customerId ?? '', currency: r.currency, validFrom: r.validFrom, validTo: r.validTo ?? '' }),
            fields: () => listFields,
          },
          extraActions: (r) => <Button type="link" onClick={() => setOpen(r)}>Lines</Button>,
        }}
      />
      {open && <PriceListLinesDrawer list={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function PriceListLinesDrawer({ list, onClose }: { list: PriceListDto; onClose(): void }) {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const key = ['master', 'price-list', list.id];
  const detail = useQuery({ queryKey: key, queryFn: () => api<PriceListDto>(`/master/price-lists/${list.id}`) });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<PriceListLineDto | null>(null);
  const [toggling, setToggling] = useState<PriceListLineDto | null>(null);
  const mayManage = can('master.price.manage');
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  return (
    <Drawer open onClose={onClose} width={760} title={`${list.code} — ${list.name}`} extra={mayManage && <Button type="primary" onClick={() => setAdding(true)}>Add line</Button>}>
      <Table<PriceListLineDto>
        rowKey="id"
        size="small"
        loading={detail.isLoading}
        dataSource={detail.data?.lines ?? []}
        pagination={false}
        scroll={{ x: true }}
        columns={[
          { title: 'Item', render: (_, l) => <RefLabel path="/master/items" id={l.itemId} /> },
          { title: 'Unit', render: (_, l) => <RefLabel path="/master/uoms" id={l.uomId} /> },
          { title: `Unit price (${list.currency})`, align: 'right', render: (_, l) => formatDecimal(l.unitPrice, 2) },
          { title: 'Status', render: (_, l) => <StatusTag status={l.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
          {
            title: '',
            render: (_, l) =>
              mayManage && (
                <Space size={0}>
                  <Button type="link" onClick={() => setEditing(l)}>Edit price</Button>
                  <Button type="link" danger={l.isActive} onClick={() => setToggling(l)}>{l.isActive ? 'Deactivate' : 'Activate'}</Button>
                </Space>
              ),
          },
        ]}
      />
      <DocForm
        open={adding}
        title="Add price line"
        mode="create"
        schema={CreatePriceListLineRequest}
        fields={[
          { name: 'itemId', label: 'Item', kind: 'ref', path: '/master/items', params: { status: 'ACTIVE' } },
          { name: 'uomId', label: 'Unit', kind: 'ref', path: '/master/uoms', params: { active: 'active' } },
          { name: 'unitPrice', label: `Unit price (${list.currency})`, kind: 'decimal' },
        ]}
        onCancel={() => setAdding(false)}
        onSubmit={async (values) => {
          await api(`/master/price-lists/${list.id}/lines`, { method: 'POST', body: values });
          void message.success('Line added');
          setAdding(false);
          await refresh();
        }}
      />
      {editing && (
        <DocForm
          open
          title="Edit price"
          mode="edit"
          schema={UpdatePriceListLineRequest}
          initialValues={{ unitPrice: editing.unitPrice }}
          readOnly={[{ label: 'Item', value: <RefLabel path="/master/items" id={editing.itemId} /> }, { label: 'Unit', value: <RefLabel path="/master/uoms" id={editing.uomId} /> }]}
          fields={[{ name: 'unitPrice', label: `Unit price (${list.currency})`, kind: 'decimal' }]}
          onCancel={() => setEditing(null)}
          onSubmit={async (values) => {
            await api(`/master/price-list-lines/${editing.id}`, { method: 'PATCH', body: values });
            setEditing(null);
            await refresh();
          }}
        />
      )}
      <ReasonModal
        open={toggling !== null}
        title={toggling?.isActive ? 'Deactivate price line' : 'Activate price line'}
        reasonRequired={toggling?.isActive ?? false}
        danger={toggling?.isActive}
        onCancel={() => setToggling(null)}
        onSubmit={async (reason) => {
          if (!toggling) return;
          await api(`/master/price-list-lines/${toggling.id}/${toggling.isActive ? 'deactivate' : 'activate'}`, { method: 'POST', body: reason ? { reason } : {} });
          setToggling(null);
          await refresh();
        }}
      />
    </Drawer>
  );
}
