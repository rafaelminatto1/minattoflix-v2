import { OperationsPanel } from './OperationsPanel';
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
  Download,
  Trash2,
  ArrowDownCircle,
  AlertCircle,
} from 'lucide-react';
import type { MediaItem, StorageSource, DownloadJob } from '../types';

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
  const [activeTab, setActiveTab] = useState<'sources' | 'downloads' | 'cloudflare' | 'architecture'>('sources');
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<'gdrive' | 'onedrive'>('onedrive');
  const [shareUrl, setShareUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [warmingHeads, setWarmingHeads] = useState(false);
  const [enrichingCovers, setEnrichingCovers] = useState(false);
  const [syncLogs, setSyncLogs] = useState<string[]>([]);
  const [cfStatus, setCfStatus] = useState<CloudflareEcosystemStatus | null>(null);

  // Estados da aba de downloads (Ingestão de Torrents)
  const [downloadJobs, setDownloadJobs] = useState<DownloadJob[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [downloadTitle, setDownloadTitle] = useState('');
  const [downloadMagnet, setDownloadMagnet] = useState('');
  const [downloadCategory, setDownloadCategory] = useState<'Filmes' | 'Séries'>('Filmes');
  const [requestingDownload, setRequestingDownload] = useState(false);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);

  const loadDownloads = async () => {
    setLoadingJobs(true);
    try {
      const res = await fetch(apiUrl('/api/downloads'));
      const data = await res.json();
      if (data && Array.isArray(data.jobs)) {
        setDownloadJobs(data.jobs);
      }
    } catch (err) {
      console.error('Falha ao carregar downloads', err);
    } finally {
      setLoadingJobs(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'downloads') {
      loadDownloads();
      const interval = setInterval(loadDownloads, 10000);
      return () => clearInterval(interval);
    }
  }, [activeTab]);

  const handleRequestDownload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!downloadTitle.trim() || !downloadMagnet.trim()) return;
    setRequestingDownload(true);
    setDownloadMessage(null);
    try {
      const res = await fetch(apiUrl('/api/downloads/request'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: downloadTitle.trim(),
          magnetUri: downloadMagnet.trim(),
          mediaType: downloadCategory === 'Séries' ? 'series' : 'movie',
          folderCategory: downloadCategory,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setDownloadTitle('');
        setDownloadMagnet('');
        setDownloadMessage('Download agendado! O runner do GitHub Actions iniciará o processamento.');
        await loadDownloads();
      } else {
        setDownloadMessage(data.error || 'Erro ao agendar download.');
      }
    } catch (err) {
      setDownloadMessage(err instanceof Error ? err.message : 'Erro ao conectar à API.');
    } finally {
      setRequestingDownload(false);
    }
  };

  const handleDeleteJob = async (id: string) => {
    try {
      await fetch(apiUrl(`/api/downloads/${id}`), { method: 'DELETE' });
      await loadDownloads();
    } catch (err) {
      console.error('Erro ao deletar job', err);
    }
  };

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

  const handleEnrichCovers = async () => {
    setEnrichingCovers(true);
    try {
      const res = await fetch(apiUrl('/api/scanner/enrich-covers'), { method: 'POST' });
      const data = await res.json();
      if (data && Array.isArray(data.logs)) {
        setSyncLogs([
          `🎨 Pesquisa de capas concluída: ${data.healedCount || 0} títulos atualizados com novas capas em HD!`,
          ...data.logs,
        ]);
      }
    } catch (error) {
      setSyncLogs([error instanceof Error ? error.message : 'Falha ao buscar capas faltantes.']);
    } finally {
      setEnrichingCovers(false);
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
                Workers + Neon PostgreSQL · serviços adicionais desativados
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
            onClick={() => setActiveTab('downloads')}
            className={`py-2.5 font-semibold border-b-2 transition cursor-pointer whitespace-nowrap tap-highlight flex items-center gap-1.5 ${
              activeTab === 'downloads'
                ? 'border-[#E50914] text-white'
                : 'border-transparent text-zinc-400 hover:text-white'
            }`}
          >
            <Download className="w-3.5 h-3.5" />
            Ingestão OneDrive (Torrents)
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
                    onClick={handleEnrichCovers}
                    disabled={enrichingCovers || isSyncing}
                    className="flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 border border-purple-500/40 text-purple-300 text-xs font-bold px-3.5 py-2.5 rounded transition cursor-pointer touch-target tap-highlight"
                    title="Pesquisa e atualiza pôsteres em HD para filmes que ainda não têm capa"
                  >
                    <Sparkles className={`w-4 h-4 ${enrichingCovers ? 'animate-spin text-purple-400' : 'text-purple-400'}`} />
                    <span>{enrichingCovers ? 'Pesquisando Capas...' : 'Buscar Capas Faltantes'}</span>
                  </button>
                  <button
                    onClick={handleWarmHeads}
                    disabled
                    className="flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 border border-amber-500/40 text-amber-300 text-xs font-bold px-3.5 py-2.5 rounded transition cursor-pointer touch-target tap-highlight"
                  >
                    <Zap className={`w-4 h-4 ${warmingHeads ? 'animate-pulse text-amber-400' : 'text-amber-400'}`} />
                    <span>Cache R2 desativado</span>
                  </button>
                  <button
                    onClick={handleTriggerSync}
                    disabled={isSyncing}
                    className="flex items-center justify-center gap-2 bg-[#E50914] hover:bg-[#b80710] text-white text-xs font-bold px-4 py-2.5 rounded transition cursor-pointer touch-target tap-highlight"
                  >
                    <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
                    <span>{isSyncing ? 'Agendando sincronização…' : 'Agendar sincronização'}</span>
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
                          ● Auto-Sync 5m Ativo
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
        ) : activeTab === 'downloads' ? (
          <div className="p-4 sm:p-6 space-y-6 safe-left safe-right safe-bottom flex-1 overflow-y-auto mobile-modal-content">
            {/* Header info */}
            <div className="bg-gradient-to-r from-red-950/40 via-zinc-900 to-zinc-900 border border-red-900/30 rounded-xl p-4 sm:p-5 space-y-2">
              <div className="flex items-center gap-2.5 text-white font-bold text-sm sm:text-base">
                <ArrowDownCircle className="w-5 h-5 text-[#E50914]" />
                <span>Ingestão Automática de Torrents para o OneDrive (Custo Zero)</span>
              </div>
              <p className="text-xs text-zinc-300 leading-relaxed">
                Cole o Magnet Link de qualquer filme ou série. O runner da nuvem (GitHub Actions 1 Gbps)
                baixa o arquivo de vídeo via P2P e o <code>rclone</code> transfere diretamente para a pasta do
                seu OneDrive. Assim que terminar, o scanner do MinattoFlix indexa o título automaticamente!
              </p>
            </div>

            {/* Form */}
            <form onSubmit={handleRequestDownload} className="bg-zinc-900/60 border border-zinc-800 rounded-lg p-5 space-y-4">
              <div className="flex items-center gap-2 text-sm font-bold text-white">
                <Download className="w-4 h-4 text-[#E50914]" />
                <span>Adicionar Novo Torrent para Download</span>
              </div>

              {downloadMessage && (
                <div
                  className={`p-3 rounded-lg text-xs flex items-center gap-2 ${
                    downloadMessage.includes('sucesso') || downloadMessage.includes('agendado')
                      ? 'bg-emerald-950/50 border border-emerald-800/60 text-emerald-300'
                      : 'bg-red-950/50 border border-red-800/60 text-red-300'
                  }`}
                >
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{downloadMessage}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
                <div className="sm:col-span-3 space-y-1">
                  <label className="text-[11px] font-semibold text-zinc-400">Título / Nome da Pasta</label>
                  <input
                    type="text"
                    value={downloadTitle}
                    onChange={(e) => setDownloadTitle(e.target.value)}
                    placeholder="Ex: Interestelar (2014) Dual Áudio 1080p"
                    required
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2.5 text-white outline-none focus:border-[#E50914]"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-zinc-400">Categoria</label>
                  <select
                    value={downloadCategory}
                    onChange={(e) => setDownloadCategory(e.target.value as 'Filmes' | 'Séries')}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2.5 text-white outline-none focus:border-[#E50914]"
                  >
                    <option value="Filmes">Filmes</option>
                    <option value="Séries">Séries</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1 text-xs">
                <label className="text-[11px] font-semibold text-zinc-400">Magnet Link</label>
                <textarea
                  value={downloadMagnet}
                  onChange={(e) => setDownloadMagnet(e.target.value)}
                  placeholder="magnet:?xt=urn:btih:..."
                  rows={2}
                  required
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-white font-mono text-[11px] outline-none focus:border-[#E50914]"
                />
              </div>

              <button
                type="submit"
                disabled={requestingDownload}
                className="w-full sm:w-auto px-5 py-2.5 bg-[#E50914] hover:bg-red-700 text-white rounded font-bold text-xs flex items-center justify-center gap-2 cursor-pointer transition disabled:opacity-50"
              >
                {requestingDownload ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Agendando...</span>
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    <span>Iniciar Download & Ingestão no OneDrive</span>
                  </>
                )}
              </button>
            </form>

            {/* Jobs List */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-300">
                  Fila e Histórico de Downloads ({downloadJobs.length})
                </h4>
                <button
                  type="button"
                  onClick={loadDownloads}
                  disabled={loadingJobs}
                  className="px-2.5 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingJobs ? 'animate-spin' : ''}`} />
                  <span>Atualizar</span>
                </button>
              </div>

              {downloadJobs.length === 0 ? (
                <div className="p-8 text-center text-zinc-500 bg-zinc-900/40 border border-zinc-800 rounded-lg text-xs">
                  Nenhum download agendado no momento. Cole um magnet link acima para iniciar!
                </div>
              ) : (
                <div className="border border-zinc-800 rounded-lg divide-y divide-zinc-800 text-xs">
                  {downloadJobs.map((job) => {
                    const statusColor =
                      job.status === 'completed'
                        ? 'text-emerald-400 bg-emerald-950/60 border-emerald-800/60'
                        : job.status === 'failed'
                        ? 'text-red-400 bg-red-950/60 border-red-800/60'
                        : job.status === 'downloading' || job.status === 'uploading_to_onedrive'
                        ? 'text-sky-400 bg-sky-950/60 border-sky-800/60'
                        : 'text-amber-400 bg-amber-950/60 border-amber-800/60';

                    const statusLabel =
                      job.status === 'completed'
                        ? '✓ Concluído & Indexado'
                        : job.status === 'failed'
                        ? '✕ Falha'
                        : job.status === 'downloading'
                        ? '📥 Baixando (1 Gbps)'
                        : job.status === 'uploading_to_onedrive'
                        ? '☁️ Enviando ao OneDrive'
                        : job.status === 'dispatching'
                        ? '⚡ Disparando Action'
                        : '🕒 Na Fila';

                    return (
                      <div key={job.id} className="p-3.5 bg-zinc-950/50 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-semibold text-white truncate">{job.title}</div>
                            <div className="text-[11px] text-zinc-500 font-mono">
                              {job.media_type === 'series' ? 'Série' : 'Filme'} •{' '}
                              {new Date(job.created_at).toLocaleString('pt-BR')}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className={`px-2.5 py-1 rounded text-[11px] font-semibold border ${statusColor}`}>
                              {statusLabel}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleDeleteJob(job.id)}
                              className="p-1 text-zinc-500 hover:text-red-400 transition cursor-pointer"
                              title="Remover job do histórico"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        {/* Progress Bar */}
                        <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
                          <div
                            className={`h-full transition-all duration-500 ${
                              job.status === 'completed'
                                ? 'bg-emerald-500'
                                : job.status === 'failed'
                                ? 'bg-red-500'
                                : 'bg-[#E50914]'
                            }`}
                            style={{ width: `${job.progress_percent || (job.status === 'completed' ? 100 : 5)}%` }}
                          />
                        </div>

                        {job.download_speed && (
                          <div className="text-[11px] text-zinc-400 flex items-center justify-between">
                            <span>{job.download_speed}</span>
                            <span>{job.progress_percent}%</span>
                          </div>
                        )}

                        {job.error_message && (
                          <div className="text-[11px] text-red-400 bg-red-950/30 p-2 rounded border border-red-900/40">
                            {job.error_message}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Instruction Accordion / Guide */}
            <div className="bg-zinc-900/70 border border-zinc-800 rounded-lg p-4 space-y-2 text-xs text-zinc-300">
              <div className="font-bold text-white flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span>Configuração Rápida do OneDrive no GitHub (Custo Zero)</span>
              </div>
              <p className="text-zinc-400 text-[11px]">
                Para que o runner envie o arquivo diretamente para o seu OneDrive, adicione o secret{' '}
                <code className="text-white bg-zinc-800 px-1.5 py-0.5 rounded">RCLONE_ONEDRIVE_CONF</code> no seu repositório GitHub{' '}
                <code className="text-white bg-zinc-800 px-1.5 py-0.5 rounded">rafaelminatto1/minattoflix-v2</code> com a configuração do seu token OneDrive gerado pelo Rclone.
              </p>
            </div>
          </div>
        ) : activeTab === 'cloudflare' ? (
          <OperationsPanel />
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
