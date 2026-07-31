import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("[ErrorBoundary]", error.message, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            height: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: 32,
            fontFamily: "system-ui, sans-serif",
            background: "#fef2f2",
            color: "#991b1b",
          }}
        >
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
            App Crashed
          </h2>
          <pre
            style={{
              maxWidth: 600,
              fontSize: 12,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "#fff",
              padding: 16,
              borderRadius: 8,
              border: "1px solid #fecaca",
            }}
          >
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
        </div>
      );
    }

    return this.props.children;
  }
}
