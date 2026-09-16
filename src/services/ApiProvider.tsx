import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ApiClient } from './client';
import { HttpApiClient } from './httpClient';
import { PlatformSimulator } from './platformSimulator';
import { SimulatedApiClient } from './simulatedClient';

/**
 * Wires one API client into the tree, and gives pages a way to read from it.
 *
 * Which client is chosen is the only place in the frontend that knows whether
 * a backend exists. `VITE_API_BASE_URL` in the environment switches to the
 * real one; without it the platform simulator runs in the browser.
 */

interface ApiContextValue {
  client: ApiClient;
  /** Present only in simulation, for pages that want to drive the clock. */
  platform: PlatformSimulator | null;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export function ApiProvider({ children }: { children: ReactNode }) {
  const value = useMemo<ApiContextValue>(() => {
    const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
    if (baseUrl) {
      return { client: new HttpApiClient({ baseUrl }), platform: null };
    }
    const platform = new PlatformSimulator({ timeScale: 6, tickHz: 4 });
    return { client: new SimulatedApiClient(platform), platform };
  }, []);

  // Start and stop with the effect, not with the memo. React runs an effect's
  // cleanup on its simulated unmount in development, so a platform started
  // during construction gets stopped once and never restarted — which shows up
  // as a frozen clock and no events, and nowhere near the code that caused it.
  useEffect(() => {
    value.platform?.start();
    return () => value.platform?.stop();
  }, [value]);

  // Dev handle, so the running platform can be inspected or driven from the
  // console without instrumenting the render path.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { aquaPlatform?: PlatformSimulator | null }).aquaPlatform =
      value.platform;
  }, [value]);

  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error('useApi must be used inside <ApiProvider>');
  return ctx.client;
}

export function usePlatform(): PlatformSimulator | null {
  return useContext(ApiContext)?.platform ?? null;
}

/* ------------------------------------------------------------------ */
/* Query hook                                                          */
/* ------------------------------------------------------------------ */

export interface QueryState<T> {
  data: T | undefined;
  error: Error | null;
  /** True only on the first load, so refreshes do not flash the UI back to a spinner. */
  loading: boolean;
}

/**
 * Read from the API and re-read whenever the client says something changed.
 *
 * Deliberately small. The alternative is a caching query library, and nothing
 * here needs one: every screen reads a handful of endpoints from a source that
 * already tells it when to look again.
 *
 * `deps` must include everything the fetcher closes over, the same as an effect.
 */
export function useQuery<T>(
  fetcher: (client: ApiClient) => Promise<T>,
  deps: unknown[],
): QueryState<T> {
  const client = useApi();
  const [state, setState] = useState<QueryState<T>>({
    data: undefined,
    error: null,
    loading: true,
  });

  // Keep the newest fetcher without making it a dependency, so callers can
  // write it inline without re-subscribing on every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const run = async () => {
      // Drop a refresh that lands while the previous one is still open, rather
      // than queueing them: on a fast tick that would spiral.
      if (inFlight) return;
      inFlight = true;
      try {
        const data = await fetcherRef.current(client);
        if (!cancelled) setState({ data, error: null, loading: false });
      } catch (err) {
        if (!cancelled) {
          setState((prev) => ({
            data: prev.data,
            error: err instanceof Error ? err : new Error(String(err)),
            loading: false,
          }));
        }
      } finally {
        inFlight = false;
      }
    };

    void run();
    const unsubscribe = client.subscribe(() => void run());
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, ...deps]);

  return state;
}
