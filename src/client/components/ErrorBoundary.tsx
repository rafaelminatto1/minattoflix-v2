import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div role="alert" className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center"><h1 className="text-2xl font-bold">Não foi possível abrir esta tela</h1><p>Recarregue o sistema para tentar novamente.</p><button className="bg-red-600 rounded px-5 py-3" onClick={() => window.location.reload()}>Recarregar</button></div>;
    return this.props.children;
  }
}
