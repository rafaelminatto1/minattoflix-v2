import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; error?: Error }> {
  state = { failed: false, error: undefined };
  static getDerivedStateFromError(error: Error) { return { failed: true, error }; }
  render() {
    if (this.state.failed) return (
      <div role="alert" className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-2xl font-bold">Não foi possível abrir esta tela</h1>
        <p className="text-zinc-400 max-w-md">
          {this.state.error?.message || 'Ocorreu um erro inesperado.'}
        </p>
        <div className="flex gap-3">
          <button className="bg-[#E50914] rounded px-5 py-3 font-bold" onClick={() => window.location.reload()}>Recarregar</button>
          <button className="bg-zinc-800 rounded px-5 py-3 font-bold" onClick={() => this.setState({ failed: false, error: undefined })}>Tentar novamente</button>
        </div>
      </div>
    );
    return this.props.children;
  }
}
