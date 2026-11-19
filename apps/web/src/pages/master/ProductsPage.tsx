// Products (FG items we sell or make for a toll customer). Registration no., artwork version and quality-agreement
// date need a QA countersign (qa.product.countersign) whenever they are set or changed.
import { CreateProductRequest, UpdateProductRequest, type ProductDto } from '@albert/shared';
import { ACTIVE_FILTER } from '../../components/DataTable';
import type { FieldDef } from '../../components/DocForm';
import { RefLabel } from '../../components/RefSelect';
import { StatusTag } from '../../components/StatusTag';
import { formatDate } from '../../lib/format';
import { MasterPage } from './MasterPage';

const productFields: FieldDef[] = [
  { name: 'customerId', label: 'Toll customer (empty = our own product)', kind: 'ref', path: '/master/customers', params: { status: 'ACTIVE' }, nullable: true },
  { name: 'registrationNo', label: 'DRAP registration no. (QA countersign)', kind: 'text', nullable: true },
  { name: 'artworkVersion', label: 'Artwork version (QA countersign)', kind: 'text', nullable: true },
  { name: 'qualityAgreementSignedOn', label: 'Quality agreement signed on (QA countersign)', kind: 'date', nullable: true },
];

export function ProductsPage() {
  return (
    <MasterPage<ProductDto, typeof CreateProductRequest, typeof UpdateProductRequest>
      config={{
        title: 'Products',
        intro: 'Finished-goods items with their registration and artwork. Setting or changing the regulated fields needs a QA Manager countersign.',
        path: '/master/products',
        noun: 'product',
        manageKey: 'master.product.manage',
        countersignBy: 'QA Manager',
        filters: [ACTIVE_FILTER],
        searchPlaceholder: 'Search item code, name or registration no.',
        columns: [
          { key: 'itemCode', title: 'Item code' },
          { key: 'itemName', title: 'Name' },
          { key: 'customerId', title: 'Toll customer', render: (r) => (r.customerId ? <RefLabel path="/master/customers" id={r.customerId} /> : '') },
          { key: 'registrationNo', title: 'Registration no.' },
          { key: 'artworkVersion', title: 'Artwork' },
          { key: 'qualityAgreementSignedOn', title: 'Quality agreement', render: (r) => formatDate(r.qualityAgreementSignedOn), exportValue: (r) => formatDate(r.qualityAgreementSignedOn) },
          { key: 'isActive', title: 'Status', render: (r) => <StatusTag status={r.isActive ? 'ACTIVE' : 'INACTIVE'} />, exportValue: (r) => (r.isActive ? 'ACTIVE' : 'INACTIVE') },
        ],
        isActive: (r) => r.isActive,
        create: {
          schema: CreateProductRequest,
          fields: [{ name: 'itemId', label: 'FG item', kind: 'ref', path: '/master/items', params: { type: 'FG', status: 'ACTIVE' } }, ...productFields],
        },
        edit: {
          schema: UpdateProductRequest,
          readOnly: (r) => [{ label: 'Item', value: `${r.itemCode} — ${r.itemName}` }],
          initial: (r) => ({
            customerId: r.customerId ?? '',
            registrationNo: r.registrationNo ?? '',
            artworkVersion: r.artworkVersion ?? '',
            qualityAgreementSignedOn: r.qualityAgreementSignedOn ?? '',
          }),
          fields: () => productFields,
        },
      }}
    />
  );
}
