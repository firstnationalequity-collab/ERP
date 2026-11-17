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
