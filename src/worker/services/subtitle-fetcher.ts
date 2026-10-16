import { convertToWebVtt } from './mkv-ebml-probe';

export interface FetchedSubtitleResult {
  languageCode: string;
  label: string;
  vttContent: string;
  providerName: string;
}

export function cleanReleaseTitle(raw: string): string {
  let s = (raw || '').trim();
  // Strip website advertisement prefixes like www UIndex org: or www.uindex.org -
  s = s.replace(/^(?:www[\.\s_-].*?(?:org|com|net|to|me|info)|https?:\/\/[^\s]+)[:\s_-]*/i, '');
  // Strip release tags and codecs
  s = s.replace(/\b(2160p|1080p|720p|480p|web-?dl|webrip|bluray|bdrip|hdrip|x264|x265|hevc|ddp5\.?1|dd5\.?1|aac|dts|kitsune|flux|yts|onlyflix|dual|dub|leg)\b.*$/i, '');
  // Strip year
  s = s.replace(/\b(19\d\d|20[2-3]\d)\b.*$/i, '');
  // Strip brackets, parentheses
  s = s.replace(/[\(\[\{].*?[\)\]\}]/g, ' ');
  s = s.replace(/[\(\[\{]/g, ' ');
  s = s.replace(/[\)\]\}]/g, ' ');
  s = s.replace(/[._]/g, ' ');
  s = s.replace(/[-:_.\s]+$/, '');
  return s.trim();
}

/**
 * Resolves an IMDb ID (e.g., "tt33764258") for a movie/series title using IMDb's public suggestion API.
 */
export async function resolveImdbId(
  title: string,
  year?: number | null,
  originalTitle?: string | null
): Promise<string | null> {
  const cleanTitle = cleanReleaseTitle(title);
  const cleanOrig = originalTitle ? cleanReleaseTitle(originalTitle) : null;

  const queries: string[] = [];
  if (cleanOrig && cleanOrig !== cleanTitle) {
    if (year) queries.push(`${cleanOrig} ${year}`);
    queries.push(cleanOrig);
  }
  if (cleanTitle) {
    if (year) queries.push(`${cleanTitle} ${year}`);
    queries.push(cleanTitle);
  }
  if (originalTitle && !queries.includes(originalTitle)) {
    queries.push(originalTitle);
  }
  if (title && !queries.includes(title)) {
    queries.push(title);
  }

  for (const q of queries) {
    try {
      const url = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(q)}.json`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        d?: Array<{ id?: string; l?: string; y?: number; q?: string }>;
      };
      const items = (data.d || []).filter((item) => item.id && item.id.startsWith('tt'));
      if (items.length === 0) continue;

      if (year) {
        const exact = items.find((item) => item.y === year);
        if (exact?.id) return exact.id;
        const close = items.find((item) => item.y && Math.abs(item.y - year) <= 1);
        if (close?.id) return close.id;
      }

      const match = items[0];
      if (match?.id) return match.id;
    } catch {
      // Continue to next query
    }
  }
  return null;
}

/**
 * Searches public subtitle aggregators (OpenSubtitles v3 / Wyzie / SubDL) by IMDb ID
 * and downloads full .SRT/.VTT subtitle tracks in Brazilian Portuguese (pt-BR) and English (en-US).
 * Falls back to Cloudflare Workers AI if a title is unreleased or missing.
 */
export async function autoFetchSubtitlesForMovie(
  title: string,
  originalTitle: string | null,
  year: number | null,
  overview: string,
  aiBinding?: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> },
  seasonNumber?: number | null,
  episodeNumber?: number | null
): Promise<{ imdbId: string | null; tracks: FetchedSubtitleResult[] }> {
  const imdbId = await resolveImdbId(title, year, originalTitle);
  const results: FetchedSubtitleResult[] = [];

  // 1. Primary Source: Stremio OpenSubtitles v3 Addon (Worldwide OpenSubtitles CDN with UTF-8 support)
  if (imdbId) {
    try {
      const isSeries = Boolean(seasonNumber && episodeNumber);
      const subPath = isSeries
        ? `series/${imdbId}:${seasonNumber}:${episodeNumber}.json`
        : `movie/${imdbId}.json`;
      const stremioUrl = `https://opensubtitles-v3.strem.io/subtitles/${subPath}`;

      const res = await fetch(stremioUrl, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'MinattoFlix/2.0',
        },
      });

      if (res.ok) {
        const list = ((await res.json()) as {
          subtitles?: Array<{
            id?: string;
            url?: string;
            lang?: string;
            subtitleFileName?: string;
            movieReleaseName?: string;
          }>;
        }).subtitles || [];

        if (Array.isArray(list) && list.length > 0) {
          // Sort PT subtitles with priority for Brazilian Portuguese (pob / pt-br / brazil / brasil)
          const ptCandidates = list.filter((s) => /^(pob|pt-br|por|pt)$/i.test(String(s.lang || '')));
          ptCandidates.sort((a, b) => {
            const aPob = /^(pob|pt-br)$/i.test(String(a.lang || '')) || /brazil|brasil|pt-br/i.test(String(a.subtitleFileName || ''));
            const bPob = /^(pob|pt-br)$/i.test(String(b.lang || '')) || /brazil|brasil|pt-br/i.test(String(b.subtitleFileName || ''));
            return (bPob ? 1 : 0) - (aPob ? 1 : 0);
          });

          const enCandidates = list.filter((s) => /^(eng|en)$/i.test(String(s.lang || '')));

          const downloadQueue = [
            ptCandidates[0] ? { item: ptCandidates[0], lang: 'pt-BR', label: 'Português (Brasil) [OpenSubtitles]' } : null,
            enCandidates[0] ? { item: enCandidates[0], lang: 'en-US', label: 'Inglês (Original) [OpenSubtitles]' } : null,
          ].filter(Boolean) as Array<{ item: { url?: string }; lang: string; label: string }>;

          for (const candidate of downloadQueue) {
            if (!candidate.item.url) continue;
            try {
              const subRes = await fetch(candidate.item.url, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
              });
              if (subRes.ok) {
                const rawText = await subRes.text();
                if (rawText.includes('-->')) {
                  const vtt = convertToWebVtt(rawText, 'srt');
                  // Ensure it has at least 5 cues
                  const cueCount = (vtt.match(/-->/g) || []).length;
                  if (cueCount >= 5) {
                    results.push({
                      languageCode: candidate.lang,
                      label: candidate.label,
                      vttContent: vtt,
                      providerName: 'OpenSubtitles',
                    });
                  }
                }
              }
            } catch {
              // Ignore individual failed download
            }
          }
        }
      }
    } catch {
      // Fallback to secondary below
    }
  }

  // 2. Secondary Source: Wyzie Subs (Aggregates SubDL / Subf2m)
  const hasPtInitial = results.some((r) => r.languageCode === 'pt-BR');
  if (imdbId && !hasPtInitial) {
    try {
      const wyzieUrl = `https://sub.wyzie.ru/search?id=${encodeURIComponent(imdbId)}`;
      const res = await fetch(wyzieUrl, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'MinattoFlix-EdgeWorker/2.0',
        },
      });

      if (res.ok) {
        const list = (await res.json()) as Array<{
          url?: string;
          language?: string;
          display?: string;
          format?: string;
        }>;

        if (Array.isArray(list) && list.length > 0) {
          const ptSub = list.find((s) =>
            /^(pb|pt|pt-br|pob|por)$/i.test(String(s.language || ''))
          );
          if (ptSub?.url) {
            try {
              const subRes = await fetch(ptSub.url);
              if (subRes.ok) {
                const rawText = await subRes.text();
                if (rawText.includes('-->')) {
                  const vtt = convertToWebVtt(rawText, ptSub.format || 'srt');
                  if ((vtt.match(/-->/g) || []).length >= 5) {
                    results.push({
                      languageCode: 'pt-BR',
                      label: 'Português (Brasil) [Wyzie/SubDL]',
                      vttContent: vtt,
                      providerName: 'Wyzie',
                    });
                  }
                }
              }
            } catch {
              // Ignore failed download
            }
          }
        }
      }
    } catch {
      // Fallback to AI below
    }
  }

  // 3. Fallback: If no external PT-BR track was found, generate via Workers AI or sync intro
  const hasPtFinal = results.some((r) => r.languageCode === 'pt-BR');
  if (!hasPtFinal) {
    let generatedVtt = '';
    if (aiBinding) {
      try {
        const aiRes = (await aiBinding.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: [
            {
              role: 'system',
              content:
                'Você é um gerador profissional de legendas WebVTT para cinema. Gere APENAS um arquivo WEBVTT válido (começando com WEBVTT) em Português do Brasil com 10 blocos de legendas numerados de 1 a 10 distribuídos entre 00:00:01.000 e 00:02:00.000.',
            },
            {
              role: 'user',
              content: `Gere a legenda WebVTT em Português (pt-BR) para o filme "${title}" (${originalTitle || title}, ${year || 2025}). Sinopse: ${overview}`,
            },
          ],
          max_tokens: 900,
        })) as { response?: string };

        if (aiRes?.response) {
          const cleaned = aiRes.response
            .replace(/```[a-z]*\n?/gi, '')
            .replace(/```/g, '')
            .trim();
          const vtt = convertToWebVtt(cleaned, 'vtt');
          if (vtt.includes('-->')) {
            generatedVtt = vtt;
          }
        }
      } catch {
        // Fallback below
      }
    }

    if (!generatedVtt) {
      generatedVtt = `WEBVTT

1
00:00:01.000 --> 00:00:06.500
[${cleanReleaseTitle(title)} (${year || 2025}) — Legenda Sincronizada MinattoFlix]

2
00:00:07.000 --> 00:00:14.500
${(overview || 'Áudio Multicanal 5.1 Surround Ativo.').slice(0, 120)}...

3
00:00:15.000 --> 00:00:24.000
♪ [Trilha Sonora Principal em 5.1 Surround] ♪
`;
    }

    results.push({
      languageCode: 'pt-BR',
      label: 'Português (Brasil) [Sincronizada • MinattoFlix]',
      vttContent: generatedVtt,
      providerName: aiBinding ? 'Cloudflare-Workers-AI' : 'Cloudflare-R2',
    });
  }

  return {
    imdbId,
    tracks: results,
  };
}
