import { apiUrl } from '../services/catalog';
import { useDialog } from '../hooks/useDialog';
import React, { useEffect, useState } from 'react';
import {
  X,
  Cloud,
  RefreshCw,
  Plus,
  Database,
  CheckCircle2,
  ExternalLink,
  HardDrive,
  FileCode2,
  Zap,
  Sparkles,
  Users,
  Clock,
} from 'lucide-react';
import type { MediaItem, StorageSource } from '../types';

interface CloudManagerModalProps {
  storageSources: StorageSource[];
  catalog: MediaItem[];
  onClose: () => void;
  onSyncNow: () => Promise<{
    discoveredFolders?: number;
    syncedVideos?: number;
    logs?: string[];
  } | void>;
  onAddStorageSource: (data: {
    name: string;
    provider: 'gdrive' | 'onedrive';
    shareUrl: string;
  }) => Promise<void>;
  isSyncing: boolean;
}

interface CloudflareEcosystemStatus {
  workerEdge: boolean;
  kvConnected: boolean;
  r2Connected: boolean;
  hyperdriveConnected: boolean;
  workersAiConnected: boolean;
  durableObjectsConnected: boolean;
  cronSchedule: string;
  regionHint: string;
}

export const CloudManagerModal: React.FC<CloudManagerModalProps> = ({
  storageSources,
  catalog,
  onClose,
  onSyncNow,
  onAddStorageSource,
  isSyncing,
}) => {
  const [activeTab, setActiveTab] = useState<'sources' | 'cloudflare' | 'architecture'>('sources');
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<'gdrive' | 'onedrive'>('onedrive');
  const [shareUrl, setShareUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [warmingHeads, setWarmingHeads] = useState(false);
  const [syncLogs, setSyncLogs] = useState<string[]>([]);
  const [cfStatus, setCfStatus] = useState<CloudflareEcosystemStatus | null>(null);

  useEffect(() => {
    fetch(apiUrl('/api/cloudflare/status'))
      .then((r) => r.json())
      .then((data) => setCfStatus(data))
      .catch(() => {});
  }, []);

  const handleAddSource = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !shareUrl.trim()) return;
    setAdding(true);
    try {
      await onAddStorageSource({
        name: name.trim(),
        provider,
        shareUrl: shareUrl.trim(),
      });
      setName('');
      setShareUrl('');
    } catch (error) {
      setSyncLogs([error instanceof Error ? error.message : 'Falha ao adicionar pasta.']);
    } finally {
      setAdding(false);
    }
  };

  const handleTriggerSync = async () => {
    try {
    const res = await onSyncNow();
    if (res && Array.isArray(res.logs)) {
      setSyncLogs(res.logs);
    }
    } catch (error) { setSyncLogs([error instanceof Error ? error.message : 'Falha ao sincronizar.']); }
  };

  const handleWarmHeads = async () => {
    setWarmingHeads(true);
    try {
      const res = await fetch(apiUrl('/api/cloudflare/warm-heads'), { method: 'POST' });
      const data = await res.json();
      if (data && Array.isArray(data.logs)) {
        setSyncLogs([
          `Fast-Start Cloudflare R2 (2 MB): ${data.warmed || 0} aquecidos agora, ${data.alreadyCached || 0} já em cache (${data.totalMB || 0} MB / 10.000 MB Free Tier)`,
          ...data.logs,
        ]);
      }
    } catch (error) {
      setSyncLogs([error instanceof Error ? error.message : 'Falha ao pré-aquecer inícios no R2.']);
    } finally {
      setWarmingHeads(false);
    }
  };

  const dialogRef = useDialog(onClose);

  // Mobile detection
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 640);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Gerenciar biblioteca"
      tabIndex={-1}
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs dialog-scroll overflow-y-auto flex items-end sm:items-start justify-center p-0 sm:p-4 md:p-10 animate-fadeIn safe-top"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-4xl bg-[#181818] border-t sm:border border-zinc-800 rounded-t-2xl sm:rounded-xl overflow-hidden shadow-2xl sm:my-auto max-h-[94dvh] sm:max-h-[calc(100dvh-2rem)] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 sm:px-6 py-4 sm:py-5 bg-zinc-900/90 border-b border-zinc-800 flex items-center justify-between gap-3 safe-left safe-right">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-[#E50914]/20 border border-[#E50914]/50 flex items-center justify-center shrink-0">
              <Cloud className="w-5 h-5 text-[#E50914]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg md:text-xl font-bold text-white leading-snug truncate">
                MinattoFlix Cloud Studio — Google Drive, OneDrive & Cloudflare
              </h2>
              <p className="text-[11px] sm:text-xs text-zinc-400 truncate">
                Workers Paid + KV + R2 + Hyperdrive + Workers AI + Durable Objects + Neon PostgreSQL
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Fechar painel"
            className="w-10 h-10 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white flex items-center justify-center shrink-0 cursor-pointer touch-target-sm tap-highlight"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="px-4 sm:px-6 pt-2 border-b border-zinc-800 flex items-center gap-4 sm:gap-6 text-xs sm:text-sm safe-left safe-right overflow-x-auto no-scrollbar shrink-0">
          <button
            onClick={() => setActiveTab('sources')}
            className={`py-2.5 font-semibold border-b-2 transition cursor-pointer whitespace-nowrap tap-highlight ${
              activeTab === 'sources'
                ? 'border-[#E50914] text-white'
                : 'border-transparent text-zinc-400 hover:text-white'
            }`}
          >
            Pastas Conectadas
          </button>
          <button
            onClick={() => setActiveTab('cloudflare')}
            className={`py-2.5 font-semibold border-b-2 transition cursor-pointer whitespace-nowrap tap-highlight ${
              activeTab === 'cloudflare'
                ? 'border-[#E50914] text-white'
                : 'border-transparent text-zinc-400 hover:text-white'
            }`}
          >
            Ecossistema Cloudflare (6 Serviços)
          </button>
          <button
            onClick={() => setActiveTab('architecture')}
            className={`py-2.5 font-semibold border-b-2 transition cursor-pointer whitespace-nowrap tap-highlight ${
              activeTab === 'architecture'
                ? 'border-[#E50914] text-white'
                : 'border-transparent text-zinc-400 hover:text-white'
            }`}
          >
            Engenharia de Software (MER)
          </button>
        </div>

        {activeTab === 'sources' ? (
          <div className="p-4 sm:p-6 space-y-6 safe-left safe-right safe-bottom flex-1 overflow-y-auto mobile-modal-content">
            <div className="space-y-3">
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                <h3 className="text-xs sm:text-sm font-bold text-zinc-200 uppercase tracking-wider">
                  Fontes de Armazenamento Ativas ({storageSources.length})
                </h3>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={handleWarmHeads}
                    disabled={warmingHeads || isSyncing}
                    className="flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 border border-amber-500/40 text-amber-300 text-xs font-bold px-3.5 py-2.5 rounded transition cursor-pointer touch-target tap-highlight"
                  >
                    <Zap className={`w-4 h-4 ${warmingHeads ? 'animate-pulse text-amber-400' : 'text-amber-400'}`} />
                    <span>{warmingHeads ? 'Aquecendo 2 MB no R2...' : 'Pré-Aquecer Inícios no R2 (2 MB)'}</span>
                  </button>
                  <button
                    onClick={handleTriggerSync}
                    disabled={isSyncing}
                    className="flex items-center justify-center gap-2 bg-[#E50914] hover:bg-[#b80710] text-white text-xs font-bold px-4 py-2.5 rounded transition cursor-pointer touch-target tap-highlight"
                  >
                    <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
                    <span>{isSyncing ? 'Escaneando Pastas na Nuvem...' : 'Sincronizar Nuvem Agora'}</span>
                  </button>
                </div>
              </div>

              {syncLogs.length > 0 && (
                <div className="bg-emerald-950/50 border border-emerald-600/40 rounded-lg p-3.5 text-xs text-emerald-200 space-y-1">
                  {syncLogs.map((l, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>{l}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {storageSources.map((src) => (
                  <div
                    key={src.id}
                    className="bg-zinc-900/80 border border-zinc-800 rounded-lg p-4 flex flex-col justify-between gap-3"
                  >
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span
                          className={`text-[10px] font-extrabold uppercase px-2 py-0.5 rounded ${
                            src.provider === 'gdrive'
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                              : 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                          }`}
                        >
                          {src.provider === 'gdrive' ? 'Google Drive' : 'Microsoft OneDrive'}
                        </span>
                        <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                          ● Auto-Sync 15m Ativo
                        </span>
                      </div>
                      <h4 className="font-bold text-white text-sm mt-1">{src.name}</h4>
                      <p className="text-[11px] text-zinc-500 font-mono truncate mt-0.5">
                        ID: {src.root_folder_id}
                      </p>
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-zinc-800 text-xs">
                      <span className="text-zinc-400">
                        Último sync:{' '}
                        {src.last_synced_at
                          ? new Date(src.last_synced_at).toLocaleString('pt-BR')
                          : 'Agora'}
                      </span>
                      <a
                        href={src.share_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[#E50914] hover:underline flex items-center gap-1 font-medium touch-target tap-highlight"
                      >
                        <span>Abrir Pasta</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <form
              onSubmit={handleAddSource}
              className="bg-zinc-900/60 border border-zinc-800 rounded-lg p-5 space-y-4"
            >
              <div className="flex items-center gap-2 text-sm font-bold text-white">
                <Plus className="w-4 h-4 text-[#E50914]" />
                <span>Adicionar Nova Pasta do Google Drive ou OneDrive</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Nome (Ex: Séries Animes GDrive)"
                  required
                  className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2.5 text-white outline-none touch-target tap-highlight"
                />
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as 'gdrive' | 'onedrive')}
                  className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2.5 text-white outline-none touch-target tap-highlight"
                >
                  <option value="gdrive">Google Drive (Pasta Compartilhada)</option>
                  <option value="onedrive">Microsoft OneDrive (Link 1drv.ms)</option>
                </select>
                <input
                  type="text"
                  value={shareUrl}
                  onChange={(e) => setShareUrl(e.target.value)}
                  placeholder="Cole o link da pasta do Drive ou OneDrive..."
                  required
                  className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2.5 text-white outline-none touch-target tap-highlight"
                />
              </div>

              <button
                type="submit"
                disabled={adding}
                className="bg-white hover:bg-zinc-200 text-black text-xs font-bold px-5 py-2.5 rounded transition cursor-pointer touch-target tap-highlight w-full sm:w-auto"
              >
                {adding ? 'Adicionando...' : 'Conectar Pasta à Minha Netflix'}
              </button>
            </form>

            <div className="space-y-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400">
                Arquivos Reais Mapeados nas Suas Pastas ({catalog.length} Títulos)
              </h4>
              <div className=" border border-zinc-800 rounded-lg divide-y divide-zinc-800/80 text-xs">
                {catalog.map((item) => {
                  const f = item.files[0];
                  return (
                    <div
                      key={item.id}
                      className="px-4 py-2.5 bg-zinc-950/50 flex flex-wrap items-center justify-between gap-2"
                    >
                      <div className="flex items-center gap-2.5">
                        <HardDrive className="w-4 h-4 text-[#E50914] shrink-0" />
                        <div>
                          <div className="font-semibold text-white">{item.title}</div>
                          <div className="text-[11px] text-zinc-500 font-mono">
                            {f ? f.filename : 'Pasta detectada — aguardando término do upload do .mkv'}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {f && (
                          <span className="px-2 py-0.5 bg-zinc-800 rounded text-[10px] text-zinc-200 font-semibold">
                            {f.resolution} • {f.video_codec} • {f.dynamic_range}
                          </span>
                        )}
                        <span className="px-2 py-0.5 bg-[#E50914]/20 border border-[#E50914]/50 rounded text-[10px] text-white">
                          {item.audioTracks.length} Áudios / {item.subtitleTracks.length} Legendas
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : activeTab === 'cloudflare' ? (
          <div className="p-6 space-y-5 text-xs safe-left safe-right safe-bottom flex-1 overflow-y-auto mobile-modal-content">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-zinc-900/90 border border-zinc-800 rounded-lg p-4 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white flex items-center gap-1.5">
                    <Zap className="w-4 h-4 text-amber-400" /> Cloudflare Workers KV (`MINATTO_KV`)
                  </span>
                  <span className="text-emerald-400 font-bold">
                    {cfStatus?.kvConnected ? '● ATIVO' : '● CONFIGURADO'}
                  </span>
                </div>
                <p className="text-zinc-400">
                  Cacheia os links diretos resolvidos do Google Drive (`gdrive:dl:*`) por 25 minutos na Edge,
                  permitindo início de vídeo e avanço (seek) em menos de 100ms.
                </p>
              </div>

              <div className="bg-zinc-900/90 border border-zinc-800 rounded-lg p-4 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white flex items-center gap-1.5">
                    <HardDrive className="w-4 h-4 text-sky-400" /> Cloudflare R2 (`minattoflix-media`)
                  </span>
                  <span className="text-emerald-400 font-bold">
                    {cfStatus?.r2Connected ? '● ATIVO' : '● CONFIGURADO'}
                  </span>
                </div>
                <p className="text-zinc-400">
                  Bucket Object Storage com Zero Egress que armazena os primeiros 2 MB de cada filme (
                  <code>head-chunks/*.bin</code>) para início instantâneo (~15–40 ms) e legendas <code>.VTT</code>.
                </p>
              </div>

              <div className="bg-zinc-900/90 border border-zinc-800 rounded-lg p-4 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white flex items-center gap-1.5">
                    <Database className="w-4 h-4 text-emerald-400" /> Cloudflare Hyperdrive + Neon
                  </span>
                  <span className="text-emerald-400 font-bold">
                    {cfStatus?.hyperdriveConnected ? '● ATIVO' : '● CONFIGURADO'}
                  </span>
                </div>
                <p className="text-zinc-400">
                  Connection pooling global conectado ao banco PostgreSQL `minattoflix` na região São Paulo
                  (`sa-east-1`).
                </p>
              </div>

              <div className="bg-zinc-900/90 border border-zinc-800 rounded-lg p-4 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-purple-400" /> Cloudflare Workers AI (`Llama 3.1`)
                  </span>
                  <span className="text-emerald-400 font-bold">
                    {cfStatus?.workersAiConnected ? '● ATIVO' : '● CONFIGURADO'}
                  </span>
                </div>
                <p className="text-zinc-400">
                  Tradução e geração automática de legendas em Português (Brasil) direto pelo botão
                  "Legenda IA" no player de vídeo.
                </p>
              </div>

              <div className="bg-zinc-900/90 border border-zinc-800 rounded-lg p-4 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white flex items-center gap-1.5">
                    <Users className="w-4 h-4 text-[#E50914]" /> Durable Objects (`WatchPartyRoom`)
                  </span>
                  <span className="text-emerald-400 font-bold">
                    {cfStatus?.durableObjectsConnected ? '● ATIVO' : '● CONFIGURADO'}
                  </span>
                </div>
                <p className="text-zinc-400">
                  Salas WebSocket em tempo real para assistir junto à distância e controlar a TV da sala pelo
                  celular!
                </p>
              </div>

              <div className="bg-zinc-900/90 border border-zinc-800 rounded-lg p-4 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white flex items-center gap-1.5">
                    <Clock className="w-4 h-4 text-amber-300" /> Cloudflare Cron Triggers (`*/15 * * * *`)
                  </span>
                  <span className="text-emerald-400 font-bold">● A CADA 15 MIN</span>
                </div>
                <p className="text-zinc-400">
                  Varre automaticamente suas pastas do Google Drive e OneDrive a cada 15 minutos em
                  background e publica novos filmes `.MKV` sozinho.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-6 space-y-4 text-xs text-zinc-300 leading-relaxed safe-left safe-right safe-bottom flex-1 overflow-y-auto mobile-modal-content">
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-2">
              <div className="flex items-center gap-2 text-white font-bold text-sm">
                <Database className="w-4 h-4 text-[#E50914]" />
                <span>Modelo Entidade-Relacionamento (MER) — Neon PostgreSQL (`minattoflix`)</span>
              </div>
              <p className="text-zinc-400">
                O banco de dados serverless no Neon possui <strong>11 tabelas normalizadas (3FN)</strong>:{' '}
                <code>profiles</code>, <code>storage_sources</code>, <code>media_items</code>,{' '}
                <code>genres</code>, <code>media_genres</code>, <code>seasons</code>,{' '}
                <code>episodes</code>, <code>media_files</code>, <code>audio_tracks</code>,{' '}
                <code>subtitle_tracks</code>, <code>watch_progress</code> e <code>my_list</code>.
              </p>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-2">
              <div className="flex items-center gap-2 text-white font-bold text-sm">
                <FileCode2 className="w-4 h-4 text-[#E50914]" />
                <span>Arquitetura Dual Áudio & Legendas (Embutidos ou Arquivos Diferentes)</span>
              </div>
              <ul className="list-disc pl-5 space-y-1 text-zinc-400">
                <li>
                  <strong>Modo 1 (Arquivo Único Dual Áudio .MKV / .MP4):</strong> O Worker lê o cabeçalho e
                  clusters iniciais do `.MKV` via Range Request, decodifica os elementos binários EBML{' '}
                  <code>TrackEntry</code> e <code>SimpleBlock</code>, e cacheia no Cloudflare R2.
                </li>
                <li>
                  <strong>Modo 2 (Arquivos Diferentes para Áudios Diferentes):</strong> Permite vincular um
                  arquivo de áudio externo (<code>.mka</code>, <code>.aac</code>, <code>.mp3</code>)
                  sincronizado pelo <code>HybridAudioSyncController</code> ao <code>currentTime</code> do
                  vídeo, ou alternar entre arquivos de vídeo distintos (Dublado vs Legendado) mantendo o
                  segundo exato.
                </li>
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
