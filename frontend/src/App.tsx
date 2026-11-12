import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { CampaignDetailPage } from './pages/CampaignDetailPage';
import { CampaignReportPage } from './pages/CampaignReportPage';
import { CampaignsPage } from './pages/CampaignsPage';
import { ContactDetailPage } from './pages/ContactDetailPage';
import { ContactsPage } from './pages/ContactsPage';
import { DashboardPage } from './pages/DashboardPage';
import { ImportPage } from './pages/ImportPage';
import { LoginPage } from './pages/LoginPage';
import { NewCampaignPage } from './pages/NewCampaignPage';
import { SchedulerPage } from './pages/SchedulerPage';
import { SuppressionPage } from './pages/SuppressionPage';
import { TemplatesPage } from './pages/TemplatesPage';

function Protected() {
  const { user, ready } = useAuth();
  if (!ready) return <p className="p-8 text-sm text-muted">Loading the desk…</p>;
  if (!user) return <Navigate to="/login" replace />;
  return <Layout />;
}

export default function App() {
  const { user, ready } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={ready && user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route element={<Protected />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/contacts/import" element={<ImportPage />} />
        <Route path="/contacts/:id" element={<ContactDetailPage />} />
        <Route path="/campaigns" element={<CampaignsPage />} />
        <Route path="/campaigns/new" element={<NewCampaignPage />} />
        <Route path="/campaigns/:id" element={<CampaignDetailPage />} />
        <Route path="/campaigns/:id/report" element={<CampaignReportPage />} />
        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/suppression" element={<SuppressionPage />} />
        <Route path="/scheduler" element={<SchedulerPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
