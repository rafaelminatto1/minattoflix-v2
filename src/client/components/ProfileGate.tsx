import React, { useState } from 'react';
import { Plus, Shield, Sparkles } from 'lucide-react';
import type { Profile } from '../types';

interface ProfileGateProps {
  profiles: Profile[];
  onSelectProfile: (profile: Profile) => void;
  onCreateProfile: (data: {
    name: string;
    isKids: boolean;
    preferredAudioLang: string;
    preferredSubtitleLang: string;
  }) => Promise<void>;
}

export const ProfileGate: React.FC<ProfileGateProps> = ({
  profiles,
  onSelectProfile,
  onCreateProfile,
}) => {
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [isKids, setIsKids] = useState(false);
  const [preferredAudioLang, setPreferredAudioLang] = useState('pt-BR');
  const [preferredSubtitleLang, setPreferredSubtitleLang] = useState('off');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onCreateProfile({
        name: name.trim(),
        isKids,
        preferredAudioLang,
        preferredSubtitleLang,
      });
      setName('');
      setShowCreate(false);
    } catch {
      // The parent displays the error; keep the form and values available for retry.
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen dvh-100 bg-[#141414] flex flex-col justify-between items-center px-4 sm:px-6 py-6 relative select-none safe-top safe-bottom safe-left safe-right">
      {/* Top Logo */}
      <div className="w-full max-w-6xl flex items-center justify-center sm:justify-start pt-2">
        <span className="font-netflix-logo text-4xl md:text-5xl text-[#E50914] tracking-wider drop-shadow-[0_4px_12px_rgba(229,9,20,0.45)]">
          MINATTOFLIX
        </span>
      </div>

      {!showCreate ? (
        <div className="max-w-4xl w-full my-auto py-8 flex flex-col items-center animate-fadeIn">
          <h1 className="text-2xl sm:text-3xl md:text-5xl font-medium text-white mb-8 md:mb-14 text-center tracking-tight">
            Quem está assistindo?
          </h1>

          <div className="flex flex-wrap items-center justify-center gap-5 sm:gap-6 md:gap-10">
            {profiles.map((profile) => (
              <button
                key={profile.id}
                onClick={() => onSelectProfile(profile)}
                className="group flex flex-col items-center gap-2.5 sm:gap-3 focus:outline-none cursor-pointer touch-target tap-highlight"
              >
                <div className="relative w-24 h-24 sm:w-28 sm:h-28 md:w-36 md:h-36 rounded-md overflow-hidden ring-2 ring-transparent group-hover:ring-white transition-all duration-200 group-hover:scale-105 shadow-xl bg-zinc-800">
                  <img
                    src={profile.avatar_url}
                    alt={profile.name}
                    className="w-full h-full object-cover"
                  />
                  {profile.is_kids && (
                    <span className="absolute bottom-1.5 right-1.5 bg-amber-400 text-black text-[10px] font-extrabold px-1.5 py-0.5 rounded uppercase tracking-wider shadow">
                      KIDS
                    </span>
                  )}
                </div>
                <span className="text-zinc-300 group-hover:text-white text-sm sm:text-base md:text-lg font-medium transition-colors">
                  {profile.name}
                </span>
                <span className="text-[11px] text-zinc-500 -mt-1.5">
                  Áudio: {profile.preferred_audio_lang === 'pt-BR' ? 'Português' : 'Original'}
                </span>
              </button>
            ))}

            {/* Add Profile Button */}
            <button
              onClick={() => setShowCreate(true)}
              className="group flex flex-col items-center gap-2.5 sm:gap-3 focus:outline-none cursor-pointer touch-target tap-highlight"
            >
              <div className="w-24 h-24 sm:w-28 sm:h-28 md:w-36 md:h-36 rounded-md flex items-center justify-center bg-zinc-900/70 border-2 border-zinc-700 group-hover:bg-zinc-200 group-hover:border-white transition-all duration-200 group-hover:scale-105">
                <Plus className="w-10 h-10 sm:w-12 sm:h-12 text-zinc-400 group-hover:text-zinc-900 transition-colors" />
              </div>
              <span className="text-zinc-300 group-hover:text-white text-sm sm:text-base md:text-lg font-medium transition-colors">
                Adicionar perfil
              </span>
              <span className="text-[11px] text-transparent -mt-1.5">.</span>
            </button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={handleSubmit}
          className="max-w-lg w-full my-6 bg-[#181818] border border-zinc-800 rounded-xl p-5 sm:p-8 shadow-2xl space-y-5 sm:space-y-6"
        >
          <div>
            <h2 className="text-2xl sm:text-3xl font-semibold text-white">Adicionar perfil</h2>
            <p className="text-xs sm:text-sm text-zinc-400 mt-1">
              Adicione um perfil com preferências próprias de Dual Áudio e Legendas no MinattoFlix.
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-xs uppercase tracking-wider text-zinc-400 mb-1.5">
                Nome do Perfil
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex: Cinema Sala, Rafa..."
                required
                className="w-full bg-zinc-800 border border-zinc-700 focus:border-white rounded px-4 py-3 text-white outline-none touch-target tap-highlight"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 sm:gap-4">
              <div>
                <label className="block text-xs uppercase tracking-wider text-zinc-400 mb-1.5">
                  Áudio Padrão Preferido
                </label>
                <select
                  value={preferredAudioLang}
                  onChange={(e) => setPreferredAudioLang(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-3 text-sm text-white outline-none touch-target tap-highlight"
                >
                  <option value="pt-BR">Português (Dublado 5.1)</option>
                  <option value="en-US">Inglês (Original 5.1)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wider text-zinc-400 mb-1.5">
                  Legenda Padrão
                </label>
                <select
                  value={preferredSubtitleLang}
                  onChange={(e) => setPreferredSubtitleLang(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-3 text-sm text-white outline-none touch-target tap-highlight"
                >
                  <option value="off">Desativada (ou Forçada)</option>
                  <option value="pt-BR">Português (Completa)</option>
                  <option value="en-US">Inglês [CC]</option>
                </select>
              </div>
            </div>

            <label className="flex items-start sm:items-center gap-3 pt-2 cursor-pointer touch-target tap-highlight">
              <input
                type="checkbox"
                checked={isKids}
                onChange={(e) => setIsKids(e.target.checked)}
                className="w-5 h-5 mt-0.5 sm:mt-0 accent-[#E50914] rounded shrink-0"
              />
              <div>
                <span className="text-sm font-medium text-white flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-amber-400 shrink-0" /> Perfil Infantil (Kids)?
                </span>
                <span className="block text-xs text-zinc-400">
                  Exibe apenas animações e filmes com classificação Livre (L) ou 10 anos.
                </span>
              </div>
            </label>
          </div>

          <div className="flex items-center gap-3 sm:gap-4 pt-4 border-t border-zinc-800">
            <button
              type="submit"
              disabled={saving}
              className="flex-1 sm:flex-initial bg-[#E50914] hover:bg-[#b80710] text-white font-semibold px-6 py-3 rounded transition cursor-pointer touch-target tap-highlight"
            >
              {saving ? 'Salvando...' : 'Continuar'}
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="flex-1 sm:flex-initial border border-zinc-600 hover:border-white text-zinc-300 hover:text-white px-6 py-3 rounded transition cursor-pointer touch-target tap-highlight"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      <div className="flex items-center justify-center gap-2 text-[11px] sm:text-xs text-zinc-500 text-center pb-1">
        <Shield className="w-3.5 h-3.5 text-[#E50914] shrink-0" />
        <span>Streaming em Alta Definição • Dual Áudio 5.1 & Legendas</span>
      </div>
    </div>
  );
};

