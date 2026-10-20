import React, { useEffect, useState } from 'react';
import { requestJson } from '../services/catalog';

interface Diagnostics {
  metrics: Array<{ day: string; platform: string; event: string; count: number; duration_ms: number }>;
  tasks: Array<{ id: string; kind: string; status: string; attempts: number }>;
}
export function OperationsPanel() {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true); setError('');
    try { setData(await requestJson<Diagnostics>('/api/admin/diagnostics')); }
    catch (err) { setError(err instanceof Error ? err.message : 'Falha ao carregar diagnóstico.'); }
    finally { setBusy(false); }
  };
  useEffect(() => { void refresh(); }, []);
  return <div className="p-6 space-y-5 overflow-auto text-sm">
    <h2 className="text-lg font-semibold">Workers e Neon</h2>
    <p className="text-zinc-300">Serviços adicionais desativados. O catálogo continua nas suas fontes atuais; legendas e tarefas usam o banco existente.</p>
    <p className="text-zinc-400">Não há limite de gasto garantido pelo aplicativo: Workers e Neon podem cobrar excedentes. Sincronização automática desativada; tarefas solicitadas são processadas a cada seis horas.</p>
    <button onClick={() => void refresh()} disabled={busy} className="rounded bg-zinc-700 px-4 py-2 disabled:opacity-50">{busy ? 'Atualizando…' : 'Atualizar diagnóstico'}</button>
    {error && <p role="alert" className="text-red-300">{error}</p>}
    <h3 className="font-semibold">Tarefas recentes</h3>
    {!data?.tasks.length ? <p className="text-zinc-400">Nenhuma tarefa disponível.</p> : <ul className="space-y-2">{data.tasks.map(task => <li key={task.id}>{task.kind === 'scan' ? 'Sincronização' : 'Atualização de capas'} · {task.status} · {task.attempts}/3 tentativas</li>)}</ul>}
    <h3 className="font-semibold">Reprodução nos últimos sete dias</h3>
    {!data?.metrics.length ? <p className="text-zinc-400">As métricas aparecem após as primeiras reproduções.</p> : <div className="overflow-x-auto"><table className="w-full text-left"><thead><tr><th>Data</th><th>Plataforma</th><th>Evento</th><th>Quantidade</th></tr></thead><tbody>{data.metrics.map(row => <tr key={`${row.day}-${row.platform}-${row.event}`}><td className="py-2">{row.day.slice(0,10)}</td><td>{row.platform}</td><td>{{ start: 'Início', waiting: 'Espera', error: 'Erro', ended: 'Fim' }[row.event] || row.event}</td><td>{row.count}</td></tr>)}</tbody></table></div>}
  </div>;
}
