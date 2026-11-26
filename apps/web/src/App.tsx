import { Spin } from 'antd';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { LoginPage } from './auth/LoginPage';
import { ChangePasswordPage } from './auth/ChangePasswordPage';
import { AppLayout } from './layouts/AppLayout';
import { RequirePermission } from './components/RequirePermission';
import { HomePage } from './pages/HomePage';
import { InboxPage } from './pages/core/InboxPage';
import { UsersPage } from './pages/core/UsersPage';
import { RolesPage } from './pages/core/RolesPage';
import { ApprovalRulesPage } from './pages/core/ApprovalRulesPage';
import { NumberSeriesPage } from './pages/core/NumberSeriesPage';
import { FiscalPeriodsPage } from './pages/core/FiscalPeriodsPage';
import { AuditPage } from './pages/core/AuditPage';
import { CategoriesPage, ConversionsPage, LocationsPage, TaxCodesPage, UomsPage, WarehousesPage } from './pages/master/CatalogPages';
import { ItemsPage } from './pages/master/ItemsPage';
import { CustomersPage, VendorsPage } from './pages/master/PartiesPages';
import { ApprovedSourcesPage } from './pages/master/ApprovedSourcesPage';
import { ProductsPage } from './pages/master/ProductsPage';
import { FormulasPage } from './pages/master/FormulasPage';
import { PriceListsPage } from './pages/master/PriceListsPage';
import { AccountsPage, CostCentersPage, JournalsPage, PostingRulesPage } from './pages/fin/FinancePages';
import { ExchangeRatesPage } from './pages/fin/ExchangeRatesPage';
import { PurchaseOrdersPage, RequisitionsPage } from './pages/purch/PurchasingPages';
import { GrnPage } from './pages/purch/GrnPage';
import { LandedCostPage } from './pages/purch/LandedCostPage';
import { VendorInvoicesPage } from './pages/purch/VendorInvoicesPage';
import { VendorPaymentsPage } from './pages/purch/VendorPaymentsPage';
import { ApAgeingPage, VendorLedgerPage } from './pages/purch/PayablesPages';

export function App() {
  const { user, restoring } = useAuth();

  if (restoring) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }
  if (!user) return <LoginPage />;
  // First login, admin reset or 90-day expiry: nothing else until the password is changed (the API enforces it too).
  if (user.mustChangePassword || user.passwordExpired) return <ChangePasswordPage forced />;

  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/change-password" element={<ChangePasswordPage forced={false} />} />
        <Route path="/approvals" element={<RequirePermission anyOf={['core.approval.inbox']}><InboxPage /></RequirePermission>} />
        <Route path="/master/items" element={<RequirePermission anyOf={['master.view']}><ItemsPage /></RequirePermission>} />
        <Route path="/master/formulas" element={<RequirePermission anyOf={['master.view']}><FormulasPage /></RequirePermission>} />
        <Route path="/master/products" element={<RequirePermission anyOf={['master.view']}><ProductsPage /></RequirePermission>} />
        <Route path="/master/customers" element={<RequirePermission anyOf={['master.view']}><CustomersPage /></RequirePermission>} />
        <Route path="/master/price-lists" element={<RequirePermission anyOf={['master.view']}><PriceListsPage /></RequirePermission>} />
        <Route path="/master/vendors" element={<RequirePermission anyOf={['master.view']}><VendorsPage /></RequirePermission>} />
        <Route path="/master/approved-sources" element={<RequirePermission anyOf={['master.view']}><ApprovedSourcesPage /></RequirePermission>} />
        <Route path="/master/item-categories" element={<RequirePermission anyOf={['master.view']}><CategoriesPage /></RequirePermission>} />
        <Route path="/master/uoms" element={<RequirePermission anyOf={['master.view']}><UomsPage /></RequirePermission>} />
        <Route path="/master/uom-conversions" element={<RequirePermission anyOf={['master.view']}><ConversionsPage /></RequirePermission>} />
        <Route path="/master/warehouses" element={<RequirePermission anyOf={['master.view']}><WarehousesPage /></RequirePermission>} />
        <Route path="/master/locations" element={<RequirePermission anyOf={['master.view']}><LocationsPage /></RequirePermission>} />
        <Route path="/master/tax-codes" element={<RequirePermission anyOf={['master.view']}><TaxCodesPage /></RequirePermission>} />
        <Route path="/purch/requisitions" element={<RequirePermission anyOf={['purch.view']}><RequisitionsPage /></RequirePermission>} />
        <Route path="/purch/orders" element={<RequirePermission anyOf={['purch.view']}><PurchaseOrdersPage /></RequirePermission>} />
        <Route path="/purch/grns" element={<RequirePermission anyOf={['purch.view']}><GrnPage /></RequirePermission>} />
        <Route path="/purch/landed-costs" element={<RequirePermission anyOf={['purch.view']}><LandedCostPage /></RequirePermission>} />
        <Route path="/purch/vendor-invoices" element={<RequirePermission anyOf={['purch.view', 'fin.view']}><VendorInvoicesPage /></RequirePermission>} />
        <Route path="/purch/vendor-payments" element={<RequirePermission anyOf={['purch.view', 'fin.view']}><VendorPaymentsPage /></RequirePermission>} />
        <Route path="/purch/vendor-ledger" element={<RequirePermission anyOf={['purch.view', 'fin.view']}><VendorLedgerPage /></RequirePermission>} />
        <Route path="/purch/ap-ageing" element={<RequirePermission anyOf={['purch.view', 'fin.view']}><ApAgeingPage /></RequirePermission>} />
        <Route path="/fin/exchange-rates" element={<RequirePermission anyOf={['fin.view', 'purch.view']}><ExchangeRatesPage /></RequirePermission>} />
        <Route path="/fin/journals" element={<RequirePermission anyOf={['fin.view']}><JournalsPage /></RequirePermission>} />
        <Route path="/fin/accounts" element={<RequirePermission anyOf={['fin.view', 'master.view']}><AccountsPage /></RequirePermission>} />
        <Route path="/fin/posting-rules" element={<RequirePermission anyOf={['fin.view', 'master.view']}><PostingRulesPage /></RequirePermission>} />
        <Route path="/fin/cost-centers" element={<RequirePermission anyOf={['fin.view', 'master.view']}><CostCentersPage /></RequirePermission>} />
        <Route path="/fiscal-periods" element={<RequirePermission anyOf={['core.period.manage', 'core.period.close', 'fin.view']}><FiscalPeriodsPage /></RequirePermission>} />
        <Route path="/audit" element={<RequirePermission anyOf={['core.audit.view']}><AuditPage /></RequirePermission>} />
        <Route path="/admin/users" element={<RequirePermission anyOf={['core.user.manage']}><UsersPage /></RequirePermission>} />
        <Route path="/admin/roles" element={<RequirePermission anyOf={['core.role.manage', 'core.user.manage']}><RolesPage /></RequirePermission>} />
        <Route path="/admin/approval-rules" element={<RequirePermission anyOf={['core.settings.manage']}><ApprovalRulesPage /></RequirePermission>} />
        <Route path="/admin/number-series" element={<RequirePermission anyOf={['core.settings.manage']}><NumberSeriesPage /></RequirePermission>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppLayout>
  );
}
