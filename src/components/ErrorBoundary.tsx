// The last line of defence: if the page crashes, show a short plain message and a way back.
// The error itself goes to the browser console only, never onto the page.
import { Component, type ErrorInfo, type ReactNode } from 'react';

type State = { failed: boolean };

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('QuoteDesk page error', error.message, info.componentStack?.split('\n')[1]?.trim());
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="mx-auto mt-24 max-w-md rounded-lg border border-border bg-card p-6 text-center">
        <h1 className="text-lg font-semibold">Something went wrong on this page</h1>
        <p className="mt-2 text-sm text-muted-foreground">Your data is safe. Reload the page to continue. If it happens again after reloading, use Reset demo in the footer.</p>
        <button type="button" onClick={() => window.location.reload()} className="mt-4 rounded-md border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:bg-teal-800">
          Reload the page
        </button>
      </div>
    );
  }
}
