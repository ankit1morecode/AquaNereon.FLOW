import { useCallback, useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useApi, useQuery } from '../services/ApiProvider';
import { STATE_CLASS, STATE_LABEL, clockTime } from '../components/ui';

/**
 * The application frame: navigation, and the two facts that must be visible
 * from every screen.
 *
 * Those two are the worst node state anywhere on the network, and whether the
 * data is coming from real hardware or the simulator. The first so that a
 * disturbance is never more than a glance away regardless of which page
 * someone is on; the second because a demonstration that does not say it is a
 * demonstration is the easiest way to lose an audience's trust later.
 */

const NAV = [
  { to: '/', label: 'City Command', end: true },
  { to: '/zones', label: 'Zone Intelligence' },
  { to: '/nodes', label: 'Node Diagnostics' },
  { to: '/events', label: 'Events' },
  { to: '/reports', label: 'Reports' },
];

export function AppShell() {
  const client = useApi();
  const location = useLocation();
  const navigate = useNavigate();
  const overview = useQuery((c) => c.getCityOverview(), []);

  const isBare = location.pathname.startsWith('/viz');

  const leaveBare = useCallback(() => {
    // Go back if there is somewhere to go back to; otherwise this was opened
    // directly and City Command is the sensible home.
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/');
  }, [navigate]);

  // Escape leaves the full-screen view. Bound here rather than inside the 3D
  // module, which is reusable and has no business knowing about app routing.
  useEffect(() => {
    if (!isBare) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') leaveBare();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isBare, leaveBare]);

  const o = overview.data;
  const worst = o
    ? o.nodes_by_state.DISTURBANCE > 0
      ? 'DISTURBANCE'
      : o.nodes_by_state.PRE_DISTURBANCE > 0
        ? 'PRE_DISTURBANCE'
        : o.nodes_by_state.DRIFT > 0
          ? 'DRIFT'
          : 'STABLE'
    : 'STABLE';

  // The full-screen 3D view gets the whole viewport; a nav bar across the top
  // would sit in front of the thing it is there to show. It still needs a way
  // out, though — a view with no exit is a trap, and someone who opened it
  // from a node has nothing to click.
  //
  // So: one floating control, and the module's own header is hidden here
  // because it repeats a brand the application already shows.
  if (isBare) {
    return (
      <div className="shell-bare">
        <Outlet />
        <button
          type="button"
          className="bare-back"
          onClick={leaveBare}
          title="Return to the platform (Esc)"
        >
          <span aria-hidden="true">←</span>
          AquaNereon<i>.FLOW</i>
          <em>platform</em>
        </button>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="shell-bar">
        <div className="brand">
          <span className="brand-mark" />
          <h1>
            AquaNereon<i>.FLOW</i>
          </h1>
          <span className="brand-sub">Urban Water Intelligence</span>
        </div>

        <nav className="shell-nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              {item.label}
            </NavLink>
          ))}
          <NavLink
            to="/viz"
            className={({ isActive }) => (isActive ? 'nav-link viz active' : 'nav-link viz')}
          >
            3D Junction
          </NavLink>
        </nav>

        <div className="shell-status">
          <span className={`shell-state ${STATE_CLASS[worst]}`}>
            <i />
            {STATE_LABEL[worst]}
          </span>
          {o && o.open_events > 0 && (
            <span className="shell-events">{o.open_events} open</span>
          )}
          <span
            className={client.mode === 'SIMULATION' ? 'shell-mode sim' : 'shell-mode live'}
            title={client.label}
          >
            {client.mode === 'SIMULATION' ? 'SIMULATION' : 'LIVE'}
          </span>
          {o && <span className="shell-clock">{clockTime(o.timestamp)}</span>}
        </div>
      </header>

      <main className="shell-main">
        <Outlet />
      </main>
    </div>
  );
}
