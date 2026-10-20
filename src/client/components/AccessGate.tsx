import React, { useEffect, useState } from 'react';
import { apiUrl, saveSession } from '../services/catalog';
import {AccessContext} from '../hooks/useAccess';

export function AccessGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [admin,setAdmin]=useState(false);
  const [checking, setChecking] = useState(true);
  const [configured, setConfigured] = useState(true);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const response = await fetch(apiUrl('/api/session'));
        if (!response.ok) throw new Error('Não foi possível verificar o acesso.');
        const state = await response.json();
        if (active) { setConfigured(state.configured); setReady(state.authenticated); setAdmin(state.role==='admin'); }
      } catch { if (active) setError('Sem conexão com o servidor. Tente novamente.'); }
      finally { if (active) setChecking(false); }
    };
    void check();
    const expired = () => { setReady(false); setError('Seu acesso expirou. Entre novamente.'); };
    window.addEventListener('minatto-session-expired', expired);
    return () => { active = false; window.removeEventListener('minatto-session-expired', expired); };
  }, []);

  if (ready) return <AccessContext.Provider value={{admin}}>{children}</AccessContext.Provider>;
  return <main className="min-h-screen bg-[#141414] text-white flex items-center justify-center p-6 safe-top safe-bottom">
    <form className="w-full max-w-sm space-y-5" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try {
        const response = await fetch(apiUrl('/api/session'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Não foi possível entrar.');
        saveSession(result.token); setAdmin(result.role==='admin'); setCode(''); setReady(true);
      } catch (err) { setError(err instanceof Error ? err.message : 'Não foi possível entrar.'); }
      finally { setBusy(false); }
    }}>
      <h1 className="text-3xl text-[#E50914] font-bold">MINATTOFLIX</h1>
      <p>{checking ? 'Verificando acesso…' : configured ? 'Entre com seu código de acesso.' : 'O administrador precisa configurar o acesso no servidor.'}</p>
      {!checking && configured && <><label className="block" htmlFor="access-code">Código de acesso</label><input id="access-code" className="w-full rounded bg-zinc-800 p-3" type="password" autoComplete="current-password" maxLength={200} value={code} onChange={event => setCode(event.target.value)} required /><button className="w-full bg-[#E50914] p-3 rounded disabled:opacity-50" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button></>}
      {error && <p role="alert" className="text-red-300">{error}</p>}
    </form>
  </main>;
}
