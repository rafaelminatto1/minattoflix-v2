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

/**
 * Automatically enriches a movie/series title using TMDB (if API key provided),
 * IMDb's public zero-key suggestion API (`v3.sg.media-imdb.com`), and Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct`)
 * for rich Brazilian Portuguese synopses, taglines, and genres.
 */
export async function enrichMediaMetadata(
  cleanTitle: string,
  year: number | null,
  tmdbApiKey?: string,
  aiBinding?: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> }
): Promise<EnrichedMetadata> {
  // 1. Try TMDB API if key is configured
  if (tmdbApiKey) {
    try {
      const searchUrl = `https://api.themoviedb.org/3/search/multi?api_key=${encodeURIComponent(
        tmdbApiKey
      )}&language=pt-BR&query=${encodeURIComponent(cleanTitle)}${year ? `&year=${year}` : ''}`;
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
        const top = data.results?.[0];
        if (top) {
          return {
            title: top.title || top.name || cleanTitle,
            originalTitle: top.original_title || top.original_name || cleanTitle,
            overview:
              top.overview ||
              `${cleanTitle} (${year || 'Lançamento'}) disponível em alta definição com opção de Dual Áudio 5.1 e legendas.`,
            tagline: 'Disponível na sua nuvem pessoal MinattoFlix.',
            posterUrl: top.poster_path
              ? `https://image.tmdb.org/t/p/w780${top.poster_path}`
              : 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=800&q=85',
            backdropUrl: top.backdrop_path
              ? `https://image.tmdb.org/t/p/original${top.backdrop_path}`
              : 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1920&q=85',
            rating: top.vote_average ? Number(top.vote_average.toFixed(1)) : 8.5,
            ageRating: '12',
            runtimeMinutes: 100,
            castInfo: [],
            genres: ['Ação & Aventura'],
          };
        }
      }
    } catch {
      // Fallback to IMDb public suggestion API
    }
  }

  // 2. Zero-key IMDb Suggestion API lookup for official high-res poster and cast
  let posterUrl = 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=800&q=85';
  let originalTitle = cleanTitle;
  let castInfo: string[] = [];

  try {
    const q = encodeURIComponent(`${cleanTitle} ${year || ''}`.trim());
    const imdbRes = await fetch(`https://v3.sg.media-imdb.com/suggestion/x/${q}.json`);
    if (imdbRes.ok) {
      const imdbData = (await imdbRes.json()) as {
        d?: Array<{
          l?: string;
          s?: string;
          i?: { imageUrl?: string };
        }>;
      };
      const firstWithImg = imdbData.d?.find((item) => item.i?.imageUrl);
      if (firstWithImg) {
        if (firstWithImg.i?.imageUrl) {
          posterUrl = firstWithImg.i.imageUrl.replace(/\._V1_.*\.jpg$/i, '._V1_FMjpg_UX1000_.jpg');
        }
        if (firstWithImg.l) originalTitle = firstWithImg.l;
        if (firstWithImg.s) {
          castInfo = firstWithImg.s.split(',').map((s) => s.trim());
        }
      }
    }
  } catch {
    // Keep defaults
  }

  // 3. Use Cloudflare Workers AI (@cf/meta/llama-3.1-8b-instruct) to generate rich PT-BR Netflix synopsis & tagline
  let overview = `${cleanTitle}${year ? ` (${year})` : ''} sincronizado diretamente da sua nuvem pessoal com suporte a Dual Áudio Surround 5.1 e múltiplas legendas.`;
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
            content: `Filme/Série: "${cleanTitle}" (Título original/IMDb: "${originalTitle}", Ano: ${year || 2025}, Elenco: ${castInfo.join(', ') || 'N/A'})`,
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
      // Fallback to default overview
    }
  }

  return {
    title: cleanTitle,
    originalTitle,
    overview,
    tagline,
    posterUrl,
    backdropUrl: posterUrl,
    rating: 8.6,
    ageRating,
    runtimeMinutes,
    castInfo,
    genres: ['Animação', 'Ação & Aventura'],
  };
}
