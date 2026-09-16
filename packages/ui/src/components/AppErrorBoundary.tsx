import { Component, type ErrorInfo, type ReactNode } from "react";

interface BoundaryState {
  failed: boolean;
}

/** An unexpected render failure must leave a visible, recoverable application. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    // Source records and credentials must not leak through error messages/stacks.
    console.error("Oracle view failed to render.", { name: error.name });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="page" role="alert">
        <h1>Oracle Property Intelligence</h1>
        <h2>This view could not be displayed</h2>
        <p>Your data has not been changed. Reload the application to retry.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload application
        </button>
        <p>
          The read-only <a href="/api/meta/run">dataset run summary</a> remains available.
        </p>
      </main>
    );
  }
}
