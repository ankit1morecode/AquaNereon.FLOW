import { lazy, Suspense } from 'react';
import { Navigate, Route, BrowserRouter, Routes } from 'react-router-dom';
import { ApiProvider } from './services/ApiProvider';
import { AppShell } from './app/AppShell';
import { CityCommand } from './pages/CityCommand';
import { ZoneIntelligence } from './pages/ZoneIntelligence';
import { NodeDiagnostics } from './pages/NodeDiagnostics';
import { Events } from './pages/Events';
import { Reports } from './pages/Reports';

/**
 * Application root.
 *
 * Five screens from the dossier's frontend structure (§27), plus the 3D
 * junction as a full-viewport route of its own. Everything reads through
 * ApiProvider, so which backend is behind it is decided in exactly one place.
 *
 * The 3D route is loaded lazily, and deliberately not imported statically
 * anywhere: Three.js is most of the bundle, and an operator opening the event
 * list has no use for a renderer. A single eager import here would quietly
 * undo the lazy boundary inside JunctionPreview as well.
 */

const JunctionFullView = lazy(async () => {
  const module = await import('./viz');
  return { default: module.JunctionFlow3D };
});

export function App() {
  return (
    <ApiProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<CityCommand />} />
            <Route path="/zones" element={<Navigate to="/zones/Z-CENTRAL" replace />} />
            <Route path="/zones/:zoneId" element={<ZoneIntelligence />} />
            <Route path="/nodes" element={<Navigate to="/nodes/AN-J-014" replace />} />
            <Route path="/nodes/:nodeId" element={<NodeDiagnostics />} />
            <Route path="/events" element={<Events />} />
            <Route path="/reports" element={<Reports />} />
            <Route
              path="/viz"
              element={
                <Suspense
                  fallback={
                    <div className="empty" style={{ padding: 32 }}>
                      <span className="spinner" /> Loading 3D view…
                    </div>
                  }
                >
                  <JunctionFullView />
                </Suspense>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ApiProvider>
  );
}
