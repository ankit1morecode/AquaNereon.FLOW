import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';

/**
 * Failure handling for the 3D canvas.
 *
 * WebGL is not guaranteed: a remote desktop, a blocklisted driver, a browser
 * with hardware acceleration switched off, or simply too many live contexts on
 * the page will all refuse a renderer. Without a boundary, that surfaces as a
 * blank screen, which is the worst possible outcome for a demonstration —
 * indistinguishable from the app being broken.
 *
 * So: detect the capability before mounting, catch anything that throws after,
 * and in both cases say what happened and what to try.
 */

/**
 * Cheap capability probe: allocate a throwaway context and release it.
 *
 * Cached for the page's lifetime. A browser allows only a handful of live
 * WebGL contexts, and probing on every mount is a good way to spend them —
 * the answer cannot change between mounts anyway.
 */
let probeResult: { ok: boolean; reason?: string } | null = null;

export function detectWebGL(): { ok: boolean; reason?: string } {
  if (probeResult) return probeResult;
  probeResult = runProbe();
  return probeResult;
}

function runProbe(): { ok: boolean; reason?: string } {
  if (typeof document === 'undefined') return { ok: false, reason: 'No document' };
  try {
    const canvas = document.createElement('canvas');
    const gl =
      (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ??
      (canvas.getContext('webgl') as WebGLRenderingContext | null);
    if (!gl) {
      return { ok: false, reason: 'The browser did not provide a WebGL context.' };
    }
    // Release it immediately; the real renderer needs its own.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function Panel({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="viz-fallback">
      <div className="viz-fallback-card">
        <h2>{title}</h2>
        <p>{detail}</p>
        <ul>
          <li>Check that hardware acceleration is enabled in the browser settings.</li>
          <li>Close other tabs holding 3D content — WebGL contexts are limited.</li>
          <li>
            Over a remote desktop, software rendering may need to be allowed
            explicitly.
          </li>
        </ul>
        <p className="viz-fallback-note">
          The simulation itself is pure TypeScript and does not need a GPU.
          <code>npm run probe</code> prints the full measurement chain — flow
          conditions, swirl, ring readings and state — in a terminal.
        </p>
      </div>
    </div>
  );
}

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class CanvasErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the detail in the console: the panel is for the viewer, the stack
    // is for whoever has to fix it.
    console.error('[AquaNereon.FLOW] 3D view failed to render', error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <Panel
          title="The 3D view could not be rendered"
          detail={this.state.error.message}
        />
      );
    }
    return this.props.children;
  }
}

/**
 * Watch one canvas for context loss and recover from it.
 *
 * A lost context does not throw, so the error boundary never sees it — the
 * page simply goes blank white, which is the worst failure mode available.
 * Calling preventDefault on the loss event is what makes restoration possible
 * at all; if the browser does not restore within a short window we force a new
 * context by remounting.
 *
 * Contexts are lost more often than people expect: a driver reset, the GPU
 * process restarting, or simply opening enough 3D views that the browser
 * reclaims the oldest.
 */
export interface ContextRecovery {
  lost: boolean;
  /** Retries are spent; stop trying and show the explanation instead. */
  exhausted: boolean;
  /** Bump this as a React key to rebuild the renderer from scratch. */
  generation: number;
  /**
   * @param bornLost true when the context came back already lost, which the
   *        `webglcontextlost` event never fires for.
   */
  attach: (canvas: HTMLCanvasElement, bornLost?: boolean) => void;
}

export function useContextRecovery(restoreAfterMs = 1500, maxAttempts = 2): ContextRecovery {
  const [lost, setLost] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [generation, setGeneration] = useState(0);
  const attempts = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const scheduleRetry = useCallback(() => {
    if (attempts.current >= maxAttempts) {
      // A fresh context keeps arriving dead, which usually means the browser
      // is out of them. Retrying forever would spin the page; say so instead.
      setLost(false);
      setExhausted(true);
      return;
    }
    setLost(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      attempts.current += 1;
      setGeneration((g) => g + 1);
      setLost(false);
    }, restoreAfterMs);
  }, [maxAttempts, restoreAfterMs]);

  const attach = useCallback(
    (canvas: HTMLCanvasElement, bornLost = false) => {
      cleanupRef.current?.();

      const onLost = (event: Event) => {
        // Without this the context can never be restored, only replaced.
        event.preventDefault();
        scheduleRetry();
      };

      const onRestored = () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
        attempts.current = 0;
        setLost(false);
        setExhausted(false);
      };

      canvas.addEventListener('webglcontextlost', onLost as EventListener);
      canvas.addEventListener('webglcontextrestored', onRestored);
      cleanupRef.current = () => {
        canvas.removeEventListener('webglcontextlost', onLost as EventListener);
        canvas.removeEventListener('webglcontextrestored', onRestored);
      };

      if (bornLost) scheduleRetry();
    },
    [scheduleRetry],
  );

  useEffect(
    () => () => {
      cleanupRef.current?.();
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return { lost, exhausted, generation, attach };
}

/** Shown over the canvas while a lost context is being recovered. */
export function ContextLostNotice() {
  return (
    <div className="viz-context-lost">
      <span className="spinner" />
      Graphics context was lost. Restoring the view…
    </div>
  );
}

export function WebGLUnavailable({ reason }: { reason?: string }) {
  return (
    <Panel
      title="WebGL is not available"
      detail={reason ?? 'This browser or machine cannot provide a WebGL context.'}
    />
  );
}

/** Shown once retries are spent: the context keeps arriving already lost. */
export function ContextExhausted() {
  return (
    <Panel
      title="The 3D view lost its graphics context"
      detail="Each new rendering context came back already lost, which usually means the browser has run out of them or the GPU process is restarting. Reloading the page normally clears it."
    />
  );
}
