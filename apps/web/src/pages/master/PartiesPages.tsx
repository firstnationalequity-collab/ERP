// Customers (with addresses) and vendors. Created DRAFT; activated by the approve-key holder who neither created
// nor last edited the draft (M2 Q5). Tax, credit, toll and bank details of an active party change only with a
// countersign by an approve-key holder (the API asks; the form collects it).
import { useState } from 'react';
import { App, Button, Drawer, Space, Table, Tag, Typography } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AddressType,
  CreateAddressRequest,
  CreateCustomerRequest,
  CreateVendorRequest,
  PartyStatus,
  UpdateAddressRequest,
  UpdateCustomerRequest,
  UpdateVendorRequest,
  type AddressDto,
  type CustomerDto,
  type VendorDto,
} from '@albert/shared';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { statusFilter } from '../../components/DataTable';
import { DocForm, type FieldDef } from '../../components/DocForm';
import { ReasonModal } from '../../components/ReasonModal';
import { StatusTag } from '../../components/StatusTag';
import { formatDate, formatPKR } from '../../lib/format';
import { MasterPage, enumOptions, yesNo } from './MasterPage';

const partyActive = (r: { status: string }) => r.status === 'ACTIVE';

const customerFields: FieldDef[] = [
  { name: 'name', label: 'Name', kind: 'text' },
  { name: 'ntn', label: 'NTN', kind: 'text', placeholder: '1234567-8', nullable: true },
  { name: 'cnic', label: 'CNIC (when no NTN)', kind: 'text', placeholder: '12345-1234567-1', nullable: true },
  { name: 'strn', label: 'STRN', kind: 'text', nullable: true },
  { name: 'creditLimit', label: 'Credit limit (PKR)', kind: 'decimal' },
  { name: 'paymentTermsDays', label: 'Payment terms (days)', kind: 'int' },
  { name: 'isTollCustomer', label: 'Toll customer (owns stock we make for them)', kind: 'switch' },
];

export function CustomersPage() {
  const [addressesOf, setAddressesOf] = useState<CustomerDto | null>(null);
  return (
    <>
      <MasterPage<CustomerDto, typeof CreateCustomerRequest, typeof UpdateCustomerRequest>
        config={{
          title: 'Customers',
          intro: 'A new customer is DRAFT until a Sales Manager who did not create or last edit it activates it. Goods are dispatched only to ACTIVE customers.',
          path: '/master/customers',
          noun: 'customer',
          manageKey: 'master.customer.manage',
          activateKeys: ['master.customer.approve'],
          countersignBy: 'Sales Manager',
          filters: [statusFilter(PartyStatus)],
          columns: [
            { key: 'code', title: 'Code' },
            { key: 'name', title: 'Name' },
            { key: 'ntn', title: 'NTN' },
            { key: 'cnic', title: 'CNIC' },
            { key: 'strn', title: 'STRN' },
            { key: 'creditLimit', title: 'Credit limit', render: (r) => formatPKR(r.creditLimit), exportValue: (r) => r.creditLimit, exportFormat: 'money' },
            { key: 'paymentTermsDays', title: 'Terms (d)' },
            { key: 'isTollCustomer', title: 'Toll', render: (r) => (r.isTollCustomer ? <Tag color="purple">TOLL</Tag> : ''), exportValue: (r) => yesNo(r.isTollCustomer) },
            { key: 'status', title: 'Status', render: (r) => <StatusTag status={r.status} /> },
          ],
          isActive: partyActive,
          create: { schema: CreateCustomerRequest, initial: { creditLimit: '0', paymentTermsDays: 0, isTollCustomer: false }, fields: [{ name: 'code', label: 'Code', kind: 'text' }, ...customerFields] },
          edit: {
            schema: UpdateCustomerRequest,
            readOnly: (r) => [{ label: 'Code', value: r.code }, { label: 'Status', value: <StatusTag status={r.status} /> }],
            initial: (r) => ({ name: r.name, ntn: r.ntn ?? '', cnic: r.cnic ?? '', strn: r.strn ?? '', creditLimit: r.creditLimit, paymentTermsDays: r.paymentTermsDays, isTollCustomer: r.isTollCustomer }),
            fields: () => customerFields,
          },
          extraActions: (r) => <Button type="link" onClick={() => setAddressesOf(r)}>Addresses</Button>,
        }}
      />
      {addressesOf && <AddressesDrawer customer={addressesOf} onClose={() => setAddressesOf(null)} />}
    </>
  );
}

const addressFields: FieldDef[] = [
  { name: 'type', label: 'Type', kind: 'select', options: enumOptions(AddressType) },
  { name: 'line1', label: 'Address line 1', kind: 'text' },
  { name: 'line2', label: 'Address line 2', kind: 'text', nullable: true },
  { name: 'city', label: 'City', kind: 'text' },
  { name: 'province', label: 'Province', kind: 'text', nullable: true },
  { name: 'isDefault', label: 'Default address of this type', kind: 'switch' },
];

function AddressesDrawer({ customer, onClose }: { customer: CustomerDto; onClose(): void }) {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const key = ['customer-addresses', customer.id];
  const list = useQuery({ queryKey: key, queryFn: () => api<AddressDto[]>(`/master/customers/${customer.id}/addresses`) });
  const [form, setForm] = useState<{ address?: AddressDto } | null>(null);
  const [toggling, setToggling] = useState<AddressDto | null>(null);
  const mayManage = can('master.customer.manage');
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  return (
    <Drawer open onClose={onClose} width={760} title={`Addresses of ${customer.code} — ${customer.name}`} extra={mayManage && <Button type="primary" onClick={() => setForm({})}>New address</Button>}>
      <Table<AddressDto>
        rowKey="id"
        size="small"
        loading={list.isLoading}
        dataSource={list.data ?? []}
        pagination={false}
        scroll={{ x: true }}
        columns={[
          { title: 'Type', dataIndex: 'type' },
          { title: 'Address', render: (_, a) => [a.line1, a.line2, a.city, a.province].filter(Boolean).join(', ') },
          { title: 'Default', render: (_, a) => (a.isDefault ? <Tag color="blue">DEFAULT</Tag> : '') },
          { title: 'Status', render: (_, a) => <StatusTag status={a.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
          {
            title: '',
            render: (_, a) =>
              mayManage && (
                <Space size={0}>
                  <Button type="link" onClick={() => setForm({ address: a })}>Edit</Button>
                  <Button type="link" danger={a.isActive} onClick={() => setToggling(a)}>{a.isActive ? 'Deactivate' : 'Activate'}</Button>
                </Space>
              ),
          },
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
        Addresses are never deleted; deactivate one that is no longer used.
      </Typography.Paragraph>
      {form && !form.address && (
        <DocForm
          open
          title="New address"
          mode="create"
          schema={CreateAddressRequest}
          fields={addressFields}
          initialValues={{ type: 'BILLING', isDefault: false }}
          onCancel={() => setForm(null)}
          onSubmit={async (values) => {
            await api(`/master/customers/${customer.id}/addresses`, { method: 'POST', body: values });
            void message.success('Address added');
            setForm(null);
            await refresh();
          }}
        />
      )}
      {form?.address && (
        <DocForm
          open
          title="Edit address"
          mode="edit"
          schema={UpdateAddressRequest}
          fields={addressFields}
          initialValues={{ ...form.address, line2: form.address.line2 ?? '', province: form.address.province ?? '' }}
          onCancel={() => setForm(null)}
          onSubmit={async (values) => {
            await api(`/master/customer-addresses/${form.address!.id}`, { method: 'PATCH', body: values });
            void message.success('Saved');
            setForm(null);
            await refresh();
          }}
        />
      )}
      <ReasonModal
        open={toggling !== null}
        title={toggling?.isActive ? 'Deactivate address' : 'Activate address'}
        reasonRequired={toggling?.isActive ?? false}
        danger={toggling?.isActive}
        onCancel={() => setToggling(null)}
        onSubmit={async (reason) => {
          if (!toggling) return;
          await api(`/master/customer-addresses/${toggling.id}/${toggling.isActive ? 'deactivate' : 'activate'}`, { method: 'POST', body: reason ? { reason } : {} });
          setToggling(null);
          await refresh();
        }}
      />
    </Drawer>
  );
}

const vendorFields: FieldDef[] = [
  { name: 'name', label: 'Name', kind: 'text' },
  { name: 'isForeign', label: 'Foreign vendor', kind: 'switch' },
  { name: 'country', label: 'Country (ISO, e.g. PK, CN, IN)', kind: 'text' },
  { name: 'currency', label: 'Currency (ISO, e.g. PKR, USD)', kind: 'text' },
  { name: 'ntn', label: 'NTN', kind: 'text', placeholder: '1234567-8', nullable: true },
  { name: 'cnic', label: 'CNIC (when no NTN)', kind: 'text', nullable: true },
  { name: 'strn', label: 'STRN', kind: 'text', nullable: true },
  { name: 'bankName', label: 'Bank', kind: 'text', nullable: true },
  { name: 'bankAccount', label: 'Bank account / IBAN', kind: 'text', nullable: true },
  { name: 'paymentTermsDays', label: 'Payment terms (days)', kind: 'int', help: 'Due date for AP ageing = invoice date + these days' },
  // 0031 (owner 2026-11-25): WHT section and filer status; changing either on an active vendor needs a countersign.
  { name: 'whtTaxCodeId', label: 'WHT section (withholding tax code)', kind: 'ref', path: '/master/tax-codes', nullable: true },
  { name: 'isFiler', label: 'Filer (on the FBR Active Taxpayers List)', kind: 'switch' },
  { name: 'filerCheckedOn', label: 'ATL checked on', kind: 'date', nullable: true, help: 'Give it together with the filer status' },
];

export function VendorsPage() {
  return (
    <MasterPage<VendorDto, typeof CreateVendorRequest, typeof UpdateVendorRequest>
      config={{
        title: 'Vendors',
        intro: 'A new vendor is DRAFT until a Purchase Manager who did not create or last edit it activates it. Approved sources (AVL) are kept per vendor and item.',
        path: '/master/vendors',
        noun: 'vendor',
        manageKey: 'master.vendor.manage',
        activateKeys: ['master.vendor.approve'],
        countersignBy: 'Purchase Manager',
        filters: [statusFilter(PartyStatus)],
        columns: [
          { key: 'code', title: 'Code' },
          { key: 'name', title: 'Name' },
          { key: 'country', title: 'Country' },
          { key: 'currency', title: 'Currency' },
          { key: 'ntn', title: 'NTN' },
          { key: 'strn', title: 'STRN' },
          { key: 'bankName', title: 'Bank' },
          { key: 'paymentTermsDays', title: 'Terms (d)' },
          { key: 'isFiler', title: 'Filer (ATL)', render: (r) => (r.isFiler === null ? 'Not checked' : `${r.isFiler ? 'Filer' : 'Non-filer'} · ${formatDate(r.filerCheckedOn)}`) },
          { key: 'status', title: 'Status', render: (r) => <StatusTag status={r.status} /> },
        ],
        isActive: partyActive,
        create: { schema: CreateVendorRequest, initial: { isForeign: false, country: 'PK', currency: 'PKR', paymentTermsDays: 0 }, fields: [{ name: 'code', label: 'Code', kind: 'text' }, ...vendorFields] },
        edit: {
          schema: UpdateVendorRequest,
          readOnly: (r) => [{ label: 'Code', value: r.code }, { label: 'Status', value: <StatusTag status={r.status} /> }],
          initial: (r) => ({
            name: r.name,
            isForeign: r.isForeign,
            country: r.country,
            currency: r.currency,
            ntn: r.ntn ?? '',
            cnic: r.cnic ?? '',
            strn: r.strn ?? '',
            bankName: r.bankName ?? '',
            bankAccount: r.bankAccount ?? '',
            paymentTermsDays: r.paymentTermsDays,
            whtTaxCodeId: r.whtTaxCodeId ?? '',
            isFiler: r.isFiler ?? undefined,
            filerCheckedOn: r.filerCheckedOn ?? '',
          }),
          fields: () => vendorFields,
        },
      }}
    />
  );
}
