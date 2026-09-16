import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches anything a page throws during render.
 *
 * Without this, one bad value from the API — a null where a number was
 * expected, a shape the frontend has not been taught yet — takes the whole
 * application to a white screen. For an operations tool that is the worst
 * outcome available: indistinguishable from the platform being down, at
 * exactly the moment someone needs to know whether it is.
 *
 * So the failure is contained to the page, the navigation stays usable, and
 * the message says what went wrong rather than leaving someone to guess.
 *
 * Reset by keying this on the route: the boundary is remounted on navigation,
 * so a page that throws does not trap the operator on a dead screen.
 */

interface Props {
  children: ReactNode;
  /** Shown in the message so the reader knows which screen failed. */
  label?: string;
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

export class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The panel is for the operator; the stack is for whoever has to fix it.
    console.error('[AquaNereon.FLOW] page failed to render', error, info);
  }

  private reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="page-error">
        <div className="page-error-card">
          <h2>This screen could not be rendered</h2>
          <p className="page-error-msg">{error.message || 'Unknown error.'}</p>
          <p>
            The rest of the application is unaffected — the navigation above
            still works, and the other screens are reading the same data
            successfully.
          </p>
          <div className="page-error-actions">
            <button type="button" className="btn" onClick={this.reset}>
              Try again
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => window.location.assign('/')}
            >
              Back to City Command
            </button>
          </div>
          <p className="page-error-note">
            The full stack trace is in the browser console.
          </p>
        </div>
      </div>
    );
  }
}
