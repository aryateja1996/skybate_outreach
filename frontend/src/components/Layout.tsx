import { NavLink, Outlet } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { modeLabel } from '../lib/metrics';
import type { SystemStatus } from '../types';
import { Banner } from './ui';

const links = [
  ['/', 'Dashboard'],
  ['/contacts', 'Contacts'],
  ['/contacts/import', 'Import'],
  ['/campaigns', 'Campaigns'],
  ['/templates', 'AI writer'],
  ['/suppression', 'Suppression'],
  ['/scheduler', 'Scheduler'],
];

export function Layout() {
  const { user, logout } = useAuth();
  const [status, setStatus] = useState<SystemStatus | null>(null);

  useEffect(() => {
    api.get<SystemStatus>('/api/system/status').then((response) => setStatus(response.data)).catch(() => setStatus(null));
  }, []);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[16rem_1fr]">
      <aside className="bg-rail text-paper lg:min-h-screen">
        <div className="px-5 py-6">
          <p className="text-xs uppercase tracking-[0.18em] text-[#d7c4a8]">Skybate Technologies</p>
          <h1 className="mt-2 font-serif text-2xl">Outreach desk</h1>
        </div>
        <nav className="flex gap-2 overflow-x-auto px-3 pb-4 lg:block lg:space-y-1 lg:px-3">
          {links.filter(([to]) => to !== '/scheduler' || user?.role === 'admin').map(([to, label]) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/' || to === '/contacts'}
              className={({ isActive }) =>
                `block whitespace-nowrap px-3 py-2 text-sm ${isActive ? 'bg-white/10 text-white' : 'text-[#d9d3c7]'}`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div>
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <p className="text-sm text-muted">{user?.displayName}</p>
          <button className="text-sm text-copper" onClick={() => void logout()} type="button">Sign out</button>
        </header>
        {status?.sendingMode === 'dry_run' ? (
          <div className="px-5 pt-5">
            <Banner tone="warn">
              <strong>{modeLabel('dry_run')} is on.</strong> No emails are sent and no SMTP connection is opened.
              Simulated results are not deliveries.
              {status.dryRunReasons.length ? ` ${status.dryRunReasons.join(' ')}` : ''}
            </Banner>
          </div>
        ) : status ? (
          <div className="px-5 pt-5">
            <Banner tone="bad">Live sending is enabled for {status.senderEmail}. Approval and start are still separate actions.</Banner>
          </div>
        ) : null}
        <main className="px-5 py-6">
          <Outlet context={status} />
        </main>
      </div>
    </div>
  );
}
