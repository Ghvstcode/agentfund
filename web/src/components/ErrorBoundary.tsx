import { AlertTriangle } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './Button';

interface Props {
  children: ReactNode;
  /** Changing this value clears a caught error (pass the current path). */
  resetKey?: string;
}

interface State {
  error: Error | null;
  resetKey: string | undefined;
}

/** Last line of defence: a rendering error shows a recoverable message, not a blank page. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <section className="container-page py-16 sm:py-24" role="alert">
        <div className="mx-auto grid max-w-md gap-5">
          <span className="flex size-10 items-center justify-center rounded-lg border bg-card shadow-card">
            <AlertTriangle className="size-4 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
          </span>
          <header className="grid gap-2">
            <p className="label">Unexpected error</p>
            <h1 className="text-2xl font-semibold tracking-tight">This page stopped working</h1>
            <p className="text-sm text-pretty text-muted-foreground">
              Something in the interface failed while drawing this page. Nothing was lost on the server; reloading
              usually fixes it.
            </p>
          </header>
          <pre className="code-block">{error.message}</pre>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => window.location.reload()}>
              Reload the page
            </Button>
            <Button onClick={() => this.setState({ error: null })}>Try again</Button>
          </div>
        </div>
      </section>
    );
  }
}
