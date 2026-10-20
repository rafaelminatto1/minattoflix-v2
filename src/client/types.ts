export interface Profile {
  id: string;
  name: string;
  avatar_url: string;
  is_kids: boolean;
  preferred_audio_lang: string;
  preferred_subtitle_lang: string;
  pin_code?: string | null;
}

export interface StorageSource {
  id: string;
  name: string;
  provider: 'gdrive' | 'onedrive';
  root_folder_id: string;
  share_url: string;
  is_active: boolean;
  last_synced_at: string | null;
}

export interface Genre {
  id: number;
  name: string;
  slug: string;
}

export interface AudioTrack {
  id: string;
  media_file_id: string;
  source_type: 'embedded' | 'external_file' | 'alternate_video';
  track_index: number;
  external_file_id?: string | null;
  externalStreamUrl?: string | null;
  language_code: string;
  label: string;
  codec: string;
  channels: string;
  is_default: boolean;
}

export interface SubtitleTrack {
  id: string;
  media_file_id: string;
  source_type: 'embedded' | 'external_file';
  track_index: number;
  external_file_id?: string | null;
  language_code: string;
  label: string;
  format: string;
  is_forced: boolean;
  is_default: boolean;
  vttUrl: string;
}

export interface MediaFile {
  id: string;
  media_item_id: string;
  storage_source_id: string;
  provider: 'gdrive' | 'onedrive';
  storage_name: string;
  external_file_id: string;
  parent_folder_id: string;
  filename: string;
  file_role: 'primary_video' | 'dub_video' | 'sub_video' | 'backup_mirror';
  container: string;
  size_bytes: number;
  resolution: string;
  video_codec: string;
  dynamic_range: string;
  audio_channels: string;
  is_dual_audio: boolean;
  tracks_probed: boolean;
  streamUrl: string;
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
}

export interface WatchProgress {
  id: string;
  profile_id: string;
  media_item_id: string;
  position_seconds: number;
  duration_seconds: number;
  is_completed: boolean;
  selected_audio_id?: string | null;
  selected_subtitle_id?: string | null;
  updated_at: string;
}

export interface EpisodeItem {
  id: string;
  season_id: string;
  media_item_id: string;
  episode_number: number;
  title: string;
  overview: string;
  still_url?: string;
  runtime_minutes: number;
  startOffsetSec?: number;
  files: MediaFile[];
}

export interface SeasonItem {
  id: string;
  media_item_id: string;
  season_number: number;
  title: string;
  overview?: string;
  episodes: EpisodeItem[];
}

export interface MediaItem {
  intro_start_seconds?: number | null;
  intro_end_seconds?: number | null;
  credits_start_seconds?: number | null;
  id: string;
  type: 'movie' | 'series';
  created_at?: string;
  detailsLoaded?: boolean;
  title: string;
  original_title?: string;
  slug: string;
  release_year: number;
  overview: string;
  tagline?: string;
  poster_url: string;
  backdrop_url: string;
  logo_url?: string;
  trailer_youtube_key?: string;
  rating: number;
  age_rating: string;
  runtime_minutes: number;
  is_featured: boolean;
  cast_info: string[];
  genres: Genre[];
  files: MediaFile[];
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
  seasons?: SeasonItem[];
  progress: WatchProgress | null;
  inMyList: boolean;
  isAvailable: boolean;
}

export interface BootstrapResponse {
  profiles: Profile[];
  activeProfileId: string;
  storageSources: StorageSource[];
  genres: Genre[];
  catalog: MediaItem[];
}

export interface DownloadJob {
  id: string;
  title: string;
  media_type: 'movie' | 'series';
  tmdb_id?: number | null;
  file_name?: string | null;
  file_size_bytes?: number | null;
  status: 'queued' | 'dispatching' | 'downloading' | 'uploading_to_onedrive' | 'completed' | 'failed' | string;
  progress_percent: number;
  download_speed?: string | null;
  github_run_id?: number | null;
  error_message?: string | null;
  created_at: string;
  updated_at: string;
}

