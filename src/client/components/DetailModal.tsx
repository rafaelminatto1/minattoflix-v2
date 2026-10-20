import { prewarmStream, requestResponse } from '../services/catalog';
import { useDialog } from '../hooks/useDialog';
import React, { useEffect, useState } from 'react';
import {
  X,
  Play,
  Plus,
  Check,
  Languages,
  Subtitles,
  HardDrive,
  Cpu,
  Upload,
  Link2,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import type { AudioTrack, EpisodeItem, MediaItem, SubtitleTrack } from '../types';

interface DetailModalProps {
  item: MediaItem;
  onClose: () => void;
  onPlay: (item: MediaItem, preferredAudioId?: string, preferredSubtitleId?: string, episode?: EpisodeItem, fileId?: string) => void;
  onToggleMyList: (item: MediaItem) => void;
  onRefreshCatalog: () => Promise<void>;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return 'Tamanho não informado';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

export const DetailModal: React.FC<DetailModalProps> = ({
  item,
  onClose,
  onPlay,
  onToggleMyList,
  onRefreshCatalog,
}) => {
  // Guard: Movie has no files available
  if (!item.files?.length) {
    return (
      <div className="fixed inset-0 bg-black/95 flex flex-col items-center justify-center gap-6 p-6 z-50">
        <AlertTriangle className="w-16 h-16 text-amber-400" />
        <div className="text-center max-w-md">
          <h2 className="text-2xl font-bold text-white mb-2">Arquivo não disponível</h2>
          <p className="text-zinc-400 mb-6">
            Este título ainda não tem um arquivo de vídeo sincronizado.
            <br />Execute a sincronização na nuvem ou verifique se o arquivo existe no Google Drive/OneDrive.
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={onClose}
              className="bg-[#E50914] text-white font-bold px-6 py-3 rounded cursor-pointer"
            >
              Fechar
            </button>
            <button
              onClick={onRefreshCatalog}
              className="bg-zinc-800 text-white font-bold px-6 py-3 rounded cursor-pointer"
            >
              Sincronizar Catálogo
            </button>
          </div>
        </div>
      </div>
    );
  }

  const initialFile = item.files.find((f) => f.provider === 'onedrive') || item.files[0];
  const [selectedFileId, setSelectedFileId] = useState<string>(initialFile?.id || '');
  const primaryFile = item.files.find((f) => f.id === selectedFileId) || initialFile;

  useEffect(() => {
    if (primaryFile?.id) prewarmStream(item, primaryFile.id);
  }, [item, primaryFile?.id]);
  const [selectedSeasonNumber, setSelectedSeasonNumber] = useState<number>(
    item.seasons?.[0]?.season_number || 1
  );

  const visibleAudioTracks = React.useMemo(() => {
    if (!primaryFile) return item.audioTracks;
    const list = item.audioTracks.filter(
      (a) => a.media_file_id === primaryFile.id || a.source_type !== 'embedded'
    );
    return list.length > 0 ? list : item.audioTracks;
  }, [item.audioTracks, primaryFile]);

  const visibleSubtitleTracks = React.useMemo(() => {
    if (!primaryFile) return item.subtitleTracks;
    const list = item.subtitleTracks.filter(
      (s) => s.media_file_id === primaryFile.id || s.source_type !== 'embedded'
    );
    return list.length > 0 ? list : item.subtitleTracks;
  }, [item.subtitleTracks, primaryFile]);

  const [selectedAudioId, setSelectedAudioId] = useState<string>(
    visibleAudioTracks[0]?.id || item.audioTracks[0]?.id || ''
  );
  const [selectedSubtitleId, setSelectedSubtitleId] = useState<string>(
    item.subtitleTracks[0]?.id || 'off'
  );

  const [probing, setProbing] = useState(false);
  const [fetchingOpenSubs, setFetchingOpenSubs] = useState(false);
  const [probeMessage, setProbeMessage] = useState<string | null>(null);

  // Add separate external audio/video form state
  const [showAddAudio, setShowAddAudio] = useState(false);
  const [extAudioLabel, setExtAudioLabel] = useState('');
  const [extAudioLang, setExtAudioLang] = useState('pt-BR');
  const [extAudioType, setExtAudioType] = useState<'external_file' | 'alternate_video'>('external_file');
  const [extAudioFileId, setExtAudioFileId] = useState('');
  const [savingAudio, setSavingAudio] = useState(false);

  const handleAutoFetchSubtitles = async () => {
    setFetchingOpenSubs(true);
    setProbeMessage(null);
    try {
      const res = await requestResponse(`/api/subtitles/auto-fetch/${item.id}`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        await onRefreshCatalog();
        if (data.tracks?.[0]?.id) {
          setSelectedSubtitleId(data.tracks[0].id);
        }
        setProbeMessage(
          `Legendas oficiais (${data.count || 1} faixas • IMDb ${
            data.imdbId || 'Cloud'
          }) sincronizadas via OpenSubtitles/Workers AI e salvas no Cloudflare R2!`
        );
      }
    } catch (error) {
      setProbeMessage(error instanceof Error ? error.message : 'Não foi possível concluir a operação.');
    } finally {
      setFetchingOpenSubs(false);
    }
  };

  const handleProbeMkv = async () => {
    if (!primaryFile) return;
    setProbing(true);
    setProbeMessage(null);
    try {
      const res = await requestResponse(`/api/probe/${primaryFile.id}`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setProbeMessage(
          `Cabeçalho EBML (.mkv) inspecionado via HTTP Range: ${
            data.audioTracks?.length || 0
          } faixas de áudio e ${data.subtitleTracks?.length || 0} legendas mapeadas.`
        );
        await onRefreshCatalog();
      } else {
        setProbeMessage(data.error || 'Não foi possível ler o cabeçalho agora.');
      }
    } catch (error) {
      setProbeMessage(error instanceof Error ? error.message : 'Não foi possível concluir a operação.');
    } finally {
      setProbing(false);
    }
  };

  const handleUploadSubtitleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !primaryFile) return;

    try {
    const rawText = await file.text();
    const ext = file.name.split('.').pop()?.toLowerCase() || 'srt';
    const isEn = /\b(en|eng|english)\b/i.test(file.name);

    const res = await requestResponse('/api/subtitles/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mediaFileId: primaryFile.id,
        label: `Legenda Externa — ${file.name}`,
        languageCode: isEn ? 'en-US' : 'pt-BR',
        format: ext,
        rawContent: rawText,
      }),
    });

    if (res.ok) {
      await onRefreshCatalog();
      setProbeMessage(`Legenda "${file.name}" convertida para WebVTT e vinculada ao filme!`);
    }
    } catch (error) { setProbeMessage(error instanceof Error ? error.message : 'Falha ao enviar legenda.'); }
    finally { e.target.value = ''; }
  };

  // Mobile detection
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 640);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const handleAddExternalAudio = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!primaryFile || !extAudioFileId.trim()) return;
    setSavingAudio(true);
    try {
      const res = await requestResponse('/api/audio-tracks/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mediaFileId: primaryFile.id,
          sourceType: extAudioType,
          externalFileId: extAudioFileId.trim(),
          languageCode: extAudioLang,
          label:
            extAudioLabel.trim() ||
            (extAudioType === 'alternate_video'
              ? 'Vídeo Alternativo (Dublado/Legendado)'
              : 'Áudio Externo Separado (.MKA/.AAC)'),
        }),
      });
      if (res.ok) {
        setExtAudioFileId('');
        setExtAudioLabel('');
        setShowAddAudio(false);
        await onRefreshCatalog();
        setProbeMessage('Faixa de áudio/vídeo separada vinculada com sucesso!');
      }
    } catch (error) {
      setProbeMessage(error instanceof Error ? error.message : 'Não foi possível concluir a operação.');
    } finally {
      setSavingAudio(false);
    }
  };

  const [enrichingAi, setEnrichingAi] = useState(false);

  const handleEnrichWithAi = async () => {
    setEnrichingAi(true);
    setProbeMessage(null);
    try {
      const res = await requestResponse(`/api/media/${item.id}/enrich-ai`, { method: 'POST' });
      if (res.ok) {
        await onRefreshCatalog();
        setProbeMessage('Sinopse e frase de impacto atualizadas via Cloudflare Workers AI (Llama 3.1)!');
      }
    } catch (error) {
      setProbeMessage(error instanceof Error ? error.message : 'Não foi possível concluir a operação.');
    } finally {
      setEnrichingAi(false);
    }
  };

  const dialogRef = useDialog(onClose);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Detalhes de ${item.title}`}
      tabIndex={-1}
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs dialog-scroll overflow-y-auto flex items-end sm:items-start justify-center p-0 sm:p-4 md:p-10 animate-fadeIn safe-top"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-4xl bg-[#181818] rounded-t-2xl sm:rounded-xl overflow-y-auto sm:overflow-hidden shadow-[0_25px_70px_rgba(0,0,0,0.95)] border-t sm:border border-zinc-800 sm:my-auto max-h-[94dvh] sm:max-h-[calc(100dvh-2rem)] flex flex-col mobile-modal-content"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close Button */}
        <button
          onClick={onClose}
          aria-label="Fechar painel"
          className="detail-close fixed sm:absolute top-3 right-3 sm:top-4 sm:right-4 z-30 w-10 h-10 sm:w-11 sm:h-11 rounded-full bg-black/80 sm:bg-[#181818]/90 hover:bg-zinc-800 text-white flex items-center justify-center border border-zinc-700 cursor-pointer touch-target-sm tap-highlight"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Top Hero Banner inside Modal */}
        <div className="relative min-h-[240px] sm:min-h-[288px] md:min-h-[384px] w-full bg-black overflow-hidden flex-shrink-0 flex flex-col justify-end">
          <img
            src={item.backdrop_url || item.poster_url}
            alt={item.title}
            className="absolute inset-0 w-full h-full object-cover object-center"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#181818] via-[#181818]/55 to-black/30" />

          <div className="relative z-10 p-4 sm:p-6 pt-16 flex flex-col gap-3 sm:gap-4 safe-left safe-right">
            <h2 className="font-netflix-logo text-3xl sm:text-4xl md:text-6xl text-white leading-none drop-shadow-lg pr-10">
              {item.title}
            </h2>

            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <button
                disabled={!primaryFile}
                onClick={() => onPlay(item, selectedAudioId, selectedSubtitleId, undefined, selectedFileId)}
                className="flex-1 sm:flex-initial flex items-center justify-center gap-2 bg-white hover:bg-zinc-200 text-black font-bold text-sm sm:text-base px-5 sm:px-6 py-2.5 rounded transition cursor-pointer touch-target tap-highlight"
              >
                <Play className="w-5 h-5 fill-black shrink-0" />
                <span>Assistir Agora</span>
              </button>

              <button
                onClick={() => onToggleMyList(item)}
                className="flex items-center justify-center gap-2 bg-zinc-800/90 hover:bg-zinc-700 border border-zinc-600 text-white text-sm font-medium px-4 py-2.5 rounded transition cursor-pointer touch-target tap-highlight"
              >
                {item.inMyList ? (
                  <>
                    <Check className="w-4 h-4 text-[#46D369] shrink-0" />
                    <span>Na Minha Lista</span>
                  </>
                ) : (
                  <>
                    <Plus className="w-4 h-4 shrink-0" />
                    <span>Minha Lista</span>
                  </>
                )}
              </button>

              {primaryFile && (
                <button
                  onClick={handleProbeMkv}
                  disabled={probing}
                  className="flex items-center gap-1.5 bg-[#E50914]/20 hover:bg-[#E50914]/30 border border-[#E50914]/60 text-white text-xs font-semibold px-3 py-2 rounded transition cursor-pointer touch-target-sm tap-highlight"
                  title="Lê os primeiros 1 MB do arquivo .MKV via HTTP Range para detectar faixas embutidas"
                >
                  <Cpu className={`w-4 h-4 text-[#E50914] shrink-0 ${probing ? 'animate-spin' : ''}`} />
                  <span>{probing ? 'Lendo EBML (.MKV)...' : 'Inspecionar Faixas MKV'}</span>
                </button>
              )}

              <button
                onClick={handleEnrichWithAi}
                disabled={enrichingAi}
                className="flex items-center gap-1.5 bg-purple-600/25 hover:bg-purple-600/40 border border-purple-500/60 text-purple-200 text-xs font-semibold px-3 py-2 rounded transition cursor-pointer touch-target-sm tap-highlight"
                title="Enriquece sinopse e frase de impacto usando Cloudflare Workers AI (Llama 3.1)"
              >
                <Sparkles className={`w-4 h-4 text-purple-300 shrink-0 ${enrichingAi ? 'animate-spin' : ''}`} />
                <span>{enrichingAi ? 'Gerando Sinopse IA...' : 'Curadoria IA'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-4 sm:p-6 md:p-8 space-y-6 sm:space-y-8 flex-1 sm:overflow-y-auto mobile-modal-content safe-left safe-right safe-bottom">
          {probeMessage && (
            <div className="bg-emerald-950/60 border border-emerald-600/50 text-emerald-200 text-xs px-4 py-3 rounded-lg flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{probeMessage}</span>
            </div>
          )}

          {/* Grid: Synopsis + Technical Specs */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 sm:gap-6">
            <div className="md:col-span-2 space-y-3 sm:space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm font-semibold">
                <span className="text-[#46D369]">Nota {item.rating.toFixed(1)}/10</span>
                <span className="text-zinc-300">{item.release_year}</span>
                <span className="px-2 py-0.5 bg-zinc-800 border border-zinc-600 rounded text-xs">
                  {item.age_rating === 'L' ? 'LIVRE' : `${item.age_rating} ANOS`}
                </span>
                <span className="text-zinc-300">{item.runtime_minutes} min</span>
                {primaryFile && (
                  <>
                    <span className="border border-zinc-500 px-1.5 py-0.5 rounded text-xs text-white">
                      {primaryFile.resolution}
                    </span>
                    <span className="border border-zinc-500 px-1.5 py-0.5 rounded text-xs text-amber-300">
                      {primaryFile.dynamic_range}
                    </span>
                    <span className="border border-zinc-500 px-1.5 py-0.5 rounded text-xs text-zinc-200">
                      {primaryFile.audio_channels}
                    </span>
                  </>
                )}
              </div>

              <p className="text-zinc-200 text-sm sm:text-base leading-relaxed">{item.overview}</p>
            </div>

            <div className="text-xs space-y-2.5 text-zinc-400 bg-zinc-900/60 p-3.5 sm:p-4 rounded-lg border border-zinc-800">
              {item.original_title && (
                <div>
                  <span className="text-zinc-500">Título original: </span>
                  <span className="text-zinc-200 font-medium">{item.original_title}</span>
                </div>
              )}
              {item.cast_info && item.cast_info.length > 0 && (
                <div>
                  <span className="text-zinc-500">Elenco / Estúdio: </span>
                  <span className="text-zinc-200">{item.cast_info.join(', ')}</span>
                </div>
              )}
              {item.genres && item.genres.length > 0 && (
                <div>
                  <span className="text-zinc-500">Gêneros: </span>
                  <span className="text-zinc-200">{item.genres.map((g) => g.name).join(', ')}</span>
                </div>
              )}
              {primaryFile && (
                <>
                  <div className="pt-2 border-t border-zinc-800">
                    <span className="text-zinc-500">Tamanho / Codec: </span>
                    <span className="text-zinc-200 font-semibold">
                      {formatBytes(primaryFile.size_bytes)} • {primaryFile.video_codec?.toUpperCase() || 'Codec a verificar'} •{' '}
                      {primaryFile.container?.toUpperCase() || 'Formato a verificar'}
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Multiple File Source Mirrors Switcher */}
          {item.files.length > 1 && (
            <div className="bg-zinc-900/80 border border-zinc-800 rounded-lg p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
              <span className="text-zinc-300 font-semibold flex items-center gap-1.5">
                <HardDrive className="w-4 h-4 text-[#E50914]" /> Servidores / Espelhos Disponíveis ({item.files.length}):
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {item.files.map((f, idx) => (
                  <button
                    key={f.id}
                    onClick={() => setSelectedFileId(f.id)}
                    className={`px-3 py-1.5 rounded text-xs font-medium transition cursor-pointer ${
                      f.id === primaryFile?.id
                        ? 'bg-[#E50914] text-white font-bold shadow'
                        : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                    }`}
                  >
                    {f.provider === 'onedrive' ? 'OneDrive Direct' : 'Google Drive'} #{idx + 1} ({f.resolution})
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Dual Audio & Subtitles Configuration Section */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6 pt-4 border-t border-zinc-800">
            {/* Left Column: Audio Tracks (Embedded MKV + Separate Files) */}
            <div className="bg-zinc-900/70 border border-zinc-800 rounded-lg p-4 sm:p-5 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Languages className="w-5 h-5 text-[#E50914] shrink-0" />
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-white">
                      Faixas de Áudio (Dual Áudio / Separados)
                    </h3>
                    <p className="text-[11px] text-zinc-400">
                      Faixas embutidas no .MKV ou arquivos de áudio/vídeo separados
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setShowAddAudio((s) => !s)}
                  className="text-xs text-[#E50914] hover:underline flex items-center gap-1 font-semibold cursor-pointer py-1 shrink-0"
                >
                  <Link2 className="w-3.5 h-3.5" />
                  <span>+ Vincular Áudio</span>
                </button>
              </div>

              {showAddAudio && (
                <form
                  onSubmit={handleAddExternalAudio}
                  className="bg-black/60 border border-zinc-700 rounded p-3.5 space-y-3 text-xs"
                >
                  <div className="font-semibold text-zinc-200">
                    Vincular arquivo diferente para outro idioma
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <select
                      value={extAudioType}
                      onChange={(e) =>
                        setExtAudioType(e.target.value as 'external_file' | 'alternate_video')
                      }
                      className="bg-zinc-800 border border-zinc-700 rounded px-2.5 py-2 text-white"
                    >
                      <option value="external_file">Arquivo de Áudio (.MKA/.MP3/.AAC)</option>
                      <option value="alternate_video">Outro Vídeo (Dublado / Legendado)</option>
                    </select>
                    <select
                      value={extAudioLang}
                      onChange={(e) => setExtAudioLang(e.target.value)}
                      className="bg-zinc-800 border border-zinc-700 rounded px-2.5 py-2 text-white"
                    >
                      <option value="pt-BR">Português (Brasil)</option>
                      <option value="en-US">Inglês (Original)</option>
                      <option value="es-ES">Espanhol</option>
                      <option value="ja-JP">Japonês</option>
                    </select>
                  </div>
                  <input
                    type="text"
                    value={extAudioLabel}
                    onChange={(e) => setExtAudioLabel(e.target.value)}
                    placeholder="Nome da faixa (Ex: Português AAC 2.0 ou Versão Legendada)"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2.5 py-2 text-white"
                  />
                  <input
                    type="text"
                    value={extAudioFileId}
                    onChange={(e) => setExtAudioFileId(e.target.value)}
                    placeholder="Cole o Link ou ID do arquivo de áudio/vídeo"
                    required
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2.5 py-2 text-white"
                  />
                  <button
                    type="submit"
                    disabled={savingAudio}
                    className="w-full bg-[#E50914] hover:bg-[#b80710] text-white font-semibold py-2 rounded cursor-pointer touch-target-sm"
                  >
                    {savingAudio ? 'Vinculando...' : 'Salvar Faixa de Áudio'}
                  </button>
                </form>
              )}

              <div className="space-y-2">
                {visibleAudioTracks.map((track: AudioTrack) => {
                  const active = selectedAudioId === track.id;
                  return (
                    <button
                      key={track.id}
                      onClick={() => setSelectedAudioId(track.id)}
                      className={`w-full text-left px-3.5 py-2.5 rounded border text-xs flex items-center justify-between gap-2 transition cursor-pointer ${
                        active
                          ? 'bg-[#E50914]/15 border-[#E50914] text-white font-semibold'
                          : 'bg-zinc-950/60 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 truncate">
                          <span className="truncate">{track.label}</span>
                        </div>
                        <span className="text-[10px] text-zinc-500 block truncate">
                          {track.source_type === 'embedded'
                            ? `Embutido no .MKV (Faixa #${track.track_index + 1} • ${track.codec} ${track.channels})`
                            : track.source_type === 'alternate_video'
                              ? 'Arquivo de Vídeo Alternativo Sincronizado'
                              : 'Arquivo de Áudio Separado Sincronizado'}
                        </span>
                      </div>
                      {active && <Check className="w-4 h-4 text-[#E50914] shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Right Column: Subtitles (Embedded MKV + External .SRT/.VTT/.ASS) */}
            <div className="bg-zinc-900/70 border border-zinc-800 rounded-lg p-4 sm:p-5 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Subtitles className="w-5 h-5 text-[#E50914] shrink-0" />
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-white">Legendas Disponíveis ({visibleSubtitleTracks.length})</h3>
                    <p className="text-[11px] text-zinc-400">
                      Embutidas no .MKV ou arquivos .SRT / .VTT / .ASS externos
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={handleAutoFetchSubtitles}
                    disabled={fetchingOpenSubs}
                    className="text-[11px] bg-emerald-600/25 hover:bg-emerald-600/40 border border-emerald-500/60 text-emerald-200 font-semibold px-2.5 py-1.5 rounded flex items-center gap-1 cursor-pointer"
                    title="Busca legendas completas no OpenSubtitles/SubDL + Workers AI e armazena no Cloudflare R2"
                  >
                    <Sparkles className={`w-3 h-3 shrink-0 ${fetchingOpenSubs ? 'animate-spin' : ''}`} />
                    <span>{fetchingOpenSubs ? 'Buscando R2...' : 'OpenSubtitles R2'}</span>
                  </button>

                  <label className="text-xs text-[#E50914] hover:underline flex items-center gap-1 font-semibold cursor-pointer py-1">
                    <Upload className="w-3.5 h-3.5 shrink-0" />
                    <span>+ .SRT/.VTT</span>
                    <input
                      type="file"
                      accept=".srt,.vtt,.ass,.ssa"
                      onChange={handleUploadSubtitleFile}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>

              <div className="space-y-2 ">
                <button
                  onClick={() => setSelectedSubtitleId('off')}
                  className={`w-full text-left px-3.5 py-2 rounded border text-xs flex items-center justify-between transition cursor-pointer ${
                    selectedSubtitleId === 'off'
                      ? 'bg-[#E50914]/15 border-[#E50914] text-white font-semibold'
                      : 'bg-zinc-950/60 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                  }`}
                >
                  <span>Desativada</span>
                  {selectedSubtitleId === 'off' && <Check className="w-4 h-4 text-[#E50914]" />}
                </button>

                {visibleSubtitleTracks.map((sub: SubtitleTrack) => {
                  const active = selectedSubtitleId === sub.id;
                  return (
                    <button
                      key={sub.id}
                      onClick={() => setSelectedSubtitleId(sub.id)}
                      className={`w-full text-left px-3.5 py-2.5 rounded border text-xs flex items-center justify-between transition cursor-pointer ${
                        active
                          ? 'bg-[#E50914]/15 border-[#E50914] text-white font-semibold'
                          : 'bg-zinc-950/60 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                      }`}
                    >
                      <div>
                        <div>{sub.label}</div>
                        <span className="text-[10px] text-zinc-500">
                          {sub.source_type === 'embedded'
                            ? `Legenda do container (${sub.format.toUpperCase()})`
                            : `WebVTT em Cache (Cloudflare R2 + Neon)`}
                        </span>
                      </div>
                      {active && <Check className="w-4 h-4 text-[#E50914]" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Netflix Authentic Seasons & Episodes Section */}
          {item.seasons && item.seasons.length > 0 && (
            <div className="pt-6 border-t border-zinc-800 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h3 className="text-xl font-bold text-white">Episódios & Capítulos</h3>
                  <p className="text-xs text-zinc-400">
                    Selecione um episódio para assistir com Dual Áudio 5.1 (WASM AC3/EAC3) e Legendas R2
                  </p>
                </div>

                {item.seasons.length > 1 ? (
                  <select
                    value={selectedSeasonNumber}
                    onChange={(e) => setSelectedSeasonNumber(Number(e.target.value))}
                    className="bg-zinc-900 border border-zinc-700 rounded px-4 py-2 text-sm font-semibold text-white outline-none"
                  >
                    {item.seasons.map((s) => (
                      <option key={s.id} value={s.season_number}>
                        {s.title || `Temporada ${s.season_number}`} ({s.episodes.length} episódios)
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-sm font-semibold text-zinc-300 bg-zinc-900 border border-zinc-800 px-3.5 py-1.5 rounded">
                    {item.seasons[0].title || 'Temporada 1'} ({item.seasons[0].episodes.length} episódios)
                  </span>
                )}
              </div>

              <div className="divide-y divide-zinc-800 border border-zinc-800 rounded-xl overflow-hidden bg-zinc-950/40">
                {(
                  item.seasons.find((s) => s.season_number === selectedSeasonNumber) ||
                  item.seasons[0]
                )?.episodes.map((ep) => (
                  <button type="button" disabled={!ep.files.length} aria-label={`Assistir episódio ${ep.episode_number}: ${ep.title}`}
                    key={ep.id}
                    onClick={() => onPlay(item, selectedAudioId, selectedSubtitleId, ep)}
                    className="w-full text-left group p-4 sm:p-5 hover:bg-zinc-900/90 transition flex flex-col sm:flex-row items-start sm:items-center gap-4 cursor-pointer"
                  >
                    <div className="text-xl font-bold text-zinc-500 group-hover:text-white w-8 text-center shrink-0 hidden sm:block">
                      {ep.episode_number}
                    </div>

                    <div className="relative w-full sm:w-40 aspect-video rounded overflow-hidden bg-zinc-900 shrink-0 border border-zinc-800">
                      <img
                        src={ep.still_url || item.backdrop_url || item.poster_url}
                        alt={ep.title}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      />
                      <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                        <div className="w-10 h-10 rounded-full bg-white/95 text-black flex items-center justify-center shadow-lg">
                          <Play className="w-5 h-5 fill-black ml-0.5" />
                        </div>
                      </div>
                    </div>

                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <h4 className="text-sm sm:text-base font-bold text-white group-hover:text-[#E50914] transition">
                          {ep.title}
                        </h4>
                        <span className="text-xs font-mono text-zinc-400 shrink-0">
                          {ep.files.length ? `${ep.runtime_minutes} min` : 'Arquivo não vinculado'}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-400 line-clamp-2 leading-relaxed">
                        {ep.overview}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
