import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Boundary de erro de renderizacao: evita que um crash de componente
 * deixe a tela em branco. Render error boundary with a minimal fallback.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught an error", error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="relative flex h-screen animate-fade items-center justify-center p-4 text-zinc-100 light:text-zinc-900">
        {/* Brilho difuso atras do card. */}
        <div
          aria-hidden
          className="pointer-events-none absolute h-72 w-72 rounded-full bg-red-500/10 blur-3xl"
        />
        <div className="glass relative w-full max-w-md animate-pop-in overflow-hidden rounded-2xl border-red-500/25 p-6 text-center shadow-[0_0_80px_rgba(239,68,68,0.12)]">
          {/* Filete de luz no topo do card. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-red-400/50 to-transparent"
          />
          <div className="mx-auto mb-4 grid h-9 w-9 place-items-center rounded-xl bg-red-500/15 text-red-400 light:text-red-700 ring-1 ring-inset ring-red-500/20 light:ring-red-600/25">
            {/* Icone decorativo de alerta. */}
            <svg
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4.5 w-4.5"
              aria-hidden
            >
              <path d="M10 3.2 2.8 16h14.4L10 3.2z" />
              <path d="M10 8.2v3.4" />
              <path d="M10 14.2h.01" />
            </svg>
          </div>
          <h2 className="mb-1 text-sm font-semibold text-zinc-100 light:text-zinc-900">Algo deu errado</h2>
          <p className="mb-5 text-xs text-zinc-500">um componente falhou ao renderizar</p>
          <button
            onClick={() => location.reload()}
            className="rounded-xl bg-gradient-to-r from-cyan-500 to-violet-500 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-cyan-500/10 transition-all duration-200 hover:scale-[1.03] hover:shadow-[0_0_24px_rgba(34,211,238,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 light:focus-visible:ring-offset-white active:scale-95"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
