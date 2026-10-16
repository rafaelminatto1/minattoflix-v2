export interface EnrichedMetadata {
  title: string;
  originalTitle: string;
  overview: string;
  tagline: string;
  posterUrl: string;
  backdropUrl: string;
  rating: number;
  ageRating: string;
  runtimeMinutes: number;
  castInfo: string[];
  genres: string[];
}

export function cleanTitleForEnrichment(raw: string): string {
  let s = raw;
  s = s.replace(/^(?:www[\.\s_-].*?(?:org|com|net|to|me|info)|https?:\/\/[^\s]+)[:\s_-]*/i, '');
  s = s.replace(/:\s*EPISÓDIO COMPLETO.*$/i, '');
  s = s.replace(/EPISÓDIO COMPLETO.*$/i, '');
  s = s.replace(/\b(\d+ª?\s+temporada|temporada\s+\d+|season\s+\d+)\b.*$/i, '');
  s = s.replace(/\b(2160p|1080p|720p|480p|web-?dl|webrip|bluray|bdrip|hdrip|x264|x265|hevc|dual|dub|leg)\b.*$/i, '');
  s = s.replace(/\b(19\d\d|20[2-3]\d)\b.*$/i, '');
  s = s.replace(/[\(\[\{].*?[\)\]\}]/g, ' ');
  s = s.replace(/[\(\[\{]/g, ' ');
  s = s.replace(/[\)\]\}]/g, ' ');
  s = s.replace(/[-:_.\s]+$/, '');
  return s.trim();
}

interface ImdbMatch {
  id: string;
  title: string;
  year?: number;
  poster: string;
  cast: string[];
  isSeries: boolean;
}

async function searchImdbSuggestion(query: string, referenceWords: string[]): Promise<ImdbMatch | null> {
  try {
    const q = encodeURIComponent(query.toLowerCase().trim());
    const res = await fetch(`https://v3.sg.media-imdb.com/suggestion/x/${q}.json`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      d?: Array<{
        id?: string;
        l?: string;
        s?: string;
        y?: number;
        q?: string;
        i?: { imageUrl?: string };
      }>;
    };

    const validItems = (data.d || []).filter(
      (item) => item.id && item.id.startsWith('tt') && item.i?.imageUrl
    );
    if (validItems.length === 0) return null;

    if (referenceWords.length > 0) {
      validItems.sort((a, b) => {
        const aMatches = referenceWords.filter((w) => (a.l || '').toLowerCase().includes(w)).length;
        const bMatches = referenceWords.filter((w) => (b.l || '').toLowerCase().includes(w)).length;
        return bMatches - aMatches;
      });
    }

    const top = validItems[0];
    if (!top || !top.i?.imageUrl || !top.id) return null;

    const poster = top.i.imageUrl.replace(/\._V1_.*\.jpg$/i, '._V1_FMjpg_UX1000_.jpg');
    return {
      id: top.id,
      title: top.l || query,
      year: top.y,
      poster,
      cast: top.s ? top.s.split(',').map((s) => s.trim()) : [],
      isSeries: top.q?.toLowerCase().includes('tv') || top.q?.toLowerCase().includes('series') || false,
    };
  } catch {
    return null;
  }
}

async function searchTvMazeShow(query: string): Promise<{
  title: string;
  poster: string;
  overview?: string;
  rating?: number;
  genres?: string[];
} | null> {
  try {
    const res = await fetch(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(query.trim())}`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      name?: string;
      image?: { original?: string; medium?: string };
      summary?: string;
      rating?: { average?: number };
      genres?: string[];
    };
    if (data.image?.original || data.image?.medium) {
      return {
        title: data.name || query,
        poster: data.image.original || data.image.medium || '',
        overview: data.summary ? data.summary.replace(/<[^>]*>/g, '').trim() : undefined,
        rating: data.rating?.average || 8.0,
        genres: data.genres || ['Animação', 'Aventura'],
      };
    }
  } catch {
    // Keep fallback
  }
  return null;
}

async function fetchCinemetaBackdrop(imdbId: string, isSeries: boolean): Promise<string | null> {
  try {
    const type = isSeries ? 'series' : 'movie';
    const res = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);
    if (res.ok) {
      const data = (await res.json()) as { meta?: { background?: string } };
      if (data.meta?.background && data.meta.background.startsWith('http')) {
        return data.meta.background;
      }
    }
  } catch {
    // Ignore error
  }
  return null;
}

/**
 * Automatically enriches a movie/series title using TMDB (if API key provided),
 * IMDb suggestion API with multi-candidate scoring, TVMaze for series, Cinemeta for backdrops,
 * and Cloudflare Workers AI for PT-BR synopsis and tagline.
 */
export async function enrichMediaMetadata(
  cleanTitle: string,
  year: number | null,
  tmdbApiKey?: string,
  aiBinding?: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> }
): Promise<EnrichedMetadata> {
  const sanitizedTitle = cleanTitleForEnrichment(cleanTitle);

  // 1. Try TMDB API if key is configured
  if (tmdbApiKey) {
    try {
      const searchUrl = `https://api.themoviedb.org/3/search/multi?api_key=${encodeURIComponent(
        tmdbApiKey
      )}&language=pt-BR&query=${encodeURIComponent(sanitizedTitle || cleanTitle)}${year ? `&year=${year}` : ''}`;
      const res = await fetch(searchUrl);
      if (res.ok) {
        const data = (await res.json()) as {
          results?: Array<{
            id: number;
            title?: string;
            name?: string;
            original_title?: string;
            original_name?: string;
            overview?: string;
            poster_path?: string;
            backdrop_path?: string;
            vote_average?: number;
          }>;
        };
        const top = data.results?.find((r) => r.poster_path);
        if (top) {
          const posterUrl = `https://image.tmdb.org/t/p/w780${top.poster_path}`;
          const backdropUrl = top.backdrop_path
            ? `https://image.tmdb.org/t/p/original${top.backdrop_path}`
            : posterUrl;
          return {
            title: top.title || top.name || sanitizedTitle || cleanTitle,
            originalTitle: top.original_title || top.original_name || sanitizedTitle || cleanTitle,
            overview:
              top.overview ||
              `${sanitizedTitle || cleanTitle} (${year || 'Lançamento'}) disponível em alta definição com opção de Dual Áudio 5.1 e legendas.`,
            tagline: 'Disponível na sua nuvem pessoal MinattoFlix.',
            posterUrl,
            backdropUrl,
            rating: top.vote_average ? Number(top.vote_average.toFixed(1)) : 8.5,
            ageRating: '12',
            runtimeMinutes: 100,
            castInfo: [],
            genres: ['Ação & Aventura'],
          };
        }
      }
    } catch {
      // Fallback
    }
  }

  // 2. Build prioritized candidate queries for IMDb / TVMaze
  const lowerTitle = cleanTitle.toLowerCase();
  const candidateQueries: string[] = [];

  // Known franchise mappings
  if (/patrulha canina|paw patrol|filhotes salvam|filhotes e o tesouro|filhotes conhecem/i.test(lowerTitle)) {
    candidateQueries.push('PAW Patrol', 'Patrulha Canina');
  }
  if (/yellow mirror|homer/i.test(lowerTitle)) {
    candidateQueries.push('The Simpsons');
  }
  if (/mestres do universo/i.test(lowerTitle)) {
    candidateQueries.push('Masters of the Universe: Revolution', 'Masters of the Universe');
  }
  if (/south park/i.test(lowerTitle)) {
    candidateQueries.push('South Park: The End of Obesity', 'South Park');
  }
  if (/robo selvagem/i.test(lowerTitle)) {
    candidateQueries.push('The Wild Robot', 'Robô Selvagem');
  }
  if (/pets em acao/i.test(lowerTitle)) {
    candidateQueries.push('Gracie and Pedro: Pets to the Rescue', 'Pets em Ação');
  }
  if (/snoopy/i.test(lowerTitle)) {
    candidateQueries.push('Snoopy Presents: A Summer Musical', 'The Peanuts Movie', 'Snoopy');
  }
  if (/coyote/i.test(lowerTitle)) {
    candidateQueries.push('Coyote vs. Acme');
  }
  if (/devil may cry/i.test(lowerTitle)) {
    candidateQueries.push('Devil May Cry');
  }
  if (/dead city/i.test(lowerTitle)) {
    candidateQueries.push('The Walking Dead: Dead City');
  }

  if (sanitizedTitle) {
    if (year) candidateQueries.push(`${sanitizedTitle} ${year}`);
    candidateQueries.push(sanitizedTitle);
  }
  if (cleanTitle !== sanitizedTitle) {
    candidateQueries.push(cleanTitle);
  }

  const referenceWords = (sanitizedTitle || cleanTitle)
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  let posterUrl = '';
  let backdropUrl = '';
  let originalTitle = sanitizedTitle || cleanTitle;
  let castInfo: string[] = [];
  let rating = 8.5;
  let genres = ['Animação', 'Ação & Aventura'];

  // Try IMDb suggestion candidates
  for (const query of candidateQueries) {
    const match = await searchImdbSuggestion(query, referenceWords);
    if (match) {
      posterUrl = match.poster;
      originalTitle = match.title;
      castInfo = match.cast;
      const bg = await fetchCinemetaBackdrop(match.id, match.isSeries);
      backdropUrl = bg || posterUrl;
      break;
    }
  }

  // If not found, try TVMaze
  if (!posterUrl) {
    for (const query of candidateQueries) {
      const tvMatch = await searchTvMazeShow(query);
      if (tvMatch) {
        posterUrl = tvMatch.poster;
        backdropUrl = tvMatch.poster;
        originalTitle = tvMatch.title;
        if (tvMatch.rating) rating = tvMatch.rating;
        if (tvMatch.genres && tvMatch.genres.length > 0) genres = tvMatch.genres;
        break;
      }
    }
  }

  // Fallback placeholder if all zero-key searches failed
  if (!posterUrl) {
    posterUrl = 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=800&q=85';
    backdropUrl = posterUrl;
  }

  // 3. Workers AI for Brazilian Portuguese synopsis and tagline
  let overview = `${sanitizedTitle || cleanTitle}${year ? ` (${year})` : ''} sincronizado diretamente da sua nuvem pessoal com suporte a Dual Áudio Surround 5.1 e múltiplas legendas.`;
  let tagline = 'Streaming direto da sua nuvem em alta definição.';
  let ageRating = 'L';
  let runtimeMinutes = 95;

  if (aiBinding) {
    try {
      const aiRes = (await aiBinding.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          {
            role: 'system',
            content:
              'Você é um curador de catálogo da Netflix Brasil. Responda APENAS com um JSON válido contendo: {"titlePt": "...", "overview": "sinopse envolvente em português com 2 frases", "tagline": "frase de impacto curta", "ageRating": "L"|"10"|"12"|"14"|"16", "runtimeMinutes": 98}.',
          },
          {
            role: 'user',
            content: `Filme/Série: "${sanitizedTitle || cleanTitle}" (Título original/IMDb: "${originalTitle}", Ano: ${year || 2025}, Elenco: ${castInfo.join(', ') || 'N/A'})`,
          },
        ],
        max_tokens: 350,
      })) as { response?: string };

      if (aiRes?.response) {
        const jsonMatch = aiRes.response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as {
            titlePt?: string;
            overview?: string;
            tagline?: string;
            ageRating?: string;
            runtimeMinutes?: number;
          };
          if (parsed.overview && parsed.overview.length > 20) overview = parsed.overview;
          if (parsed.tagline && parsed.tagline.length > 5) tagline = parsed.tagline;
          if (parsed.ageRating) ageRating = parsed.ageRating;
          if (parsed.runtimeMinutes && Number(parsed.runtimeMinutes) > 20) {
            runtimeMinutes = Number(parsed.runtimeMinutes);
          }
        }
      }
    } catch {
      // Fallback
    }
  }

  return {
    title: sanitizedTitle || cleanTitle,
    originalTitle,
    overview,
    tagline,
    posterUrl,
    backdropUrl,
    rating,
    ageRating,
    runtimeMinutes,
    castInfo,
    genres,
  };
}
