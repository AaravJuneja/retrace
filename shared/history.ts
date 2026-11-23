export const DAY = 86_400
export const BATCH_SIZE = 64
export const TRACK_ID = /^[A-Za-z0-9]{22}$/
export const ARCHIVE_AUDIO = /^(?:Streaming_History_Audio(?:_.*)?|endsong(?:_\d+)?)\.json$/i

export type Play = [id: string, time: number, title: string, artist: string, album: string, ms: number | null, credits?: string[]]
export type Mode = 'forgotten' | 'deep-cuts' | 'era'
export type EraRange = [start: number, end: number]
export type Filters = {
  mode: Mode
  artist: string
  album: string
  from: string
  to: string
  quiet: number
  min: number
  max: number | null
  perArtist: number | null
  limit: number
}
export type Track = { id: string; title: string; artist: string; album: string; plays: number; last: number }
export type Artist = { key: string; name: string }
export type Summary = { n: number; first: number | null; last: number | null }
export type Status = {
  archive: Summary
  live: Summary
  coverage: { first: number; last: number }[]
  feed: { enabled: boolean; synced: number | null; error: boolean; pending: boolean }
}
export type Preview = { id: string; count: number; first: number; last: number; files: number; private: number; skipped: number }
export type Manifest = Pick<Preview, 'id' | 'count' | 'first' | 'last'> & { full: boolean }
export type Requester = (url: string, init?: RequestInit) => Promise<Response>

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function text(value: unknown, max = 300): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : ''
}

export function key(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

export function spotifyId(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value.match(/^(?:spotify:track:|https?:\/\/open\.spotify\.com\/track\/)([A-Za-z0-9]{22})(?:[?#][^\s]*)?$/)?.[1]
    : undefined
}

export function int(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

export function parsePlay(value: unknown, now: number, live = false): Play | undefined {
  if (!Array.isArray(value) || value.length !== (live ? 7 : 6)) return
  const [id, time, title, artist, album, ms, credits] = value as unknown[]
  if (typeof id !== 'string' || !TRACK_ID.test(id) || !int(time, 0, now + DAY)) return
  if (![title, artist, album].every((s) => typeof s === 'string' && s.length <= 300)) return
  if (!(int(ms, 1, 86_400_000) || (live && ms === null))) return
  if (live && (!Array.isArray(credits) || credits.length > 24 || credits.some((s) => typeof s !== 'string' || s.length > 300))) return
  const play: Play = [id, time, title as string, artist as string, album as string, ms]
  if (live) play.push(credits as string[])
  return play
}

export function archiveRow(value: unknown): Play | 'private' | undefined {
  const row = object(value)
  if (!row) return
  if (row.incognito_mode === true) return 'private'
  const id = spotifyId(row.spotify_track_uri)
  if (!id || !int(row.ms_played, 1, 86_400_000) || typeof row.ts !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/i.test(row.ts)) return
  const time = Math.floor(Date.parse(row.ts) / 1000)
  if (!int(time, 0, Math.floor(Date.now() / 1000) + DAY)) return
  return [id, time, text(row.master_metadata_track_name), text(row.master_metadata_album_artist_name), text(row.master_metadata_album_name), row.ms_played]
}

export function listenRow(value: unknown): Play | undefined {
  const row = object(value)
  const track = object(row?.track_metadata)
  const extra = object(track?.additional_info)
  if (!row || !track || !extra) return
  const spotify = extra.music_service === 'spotify.com' && extra.submission_client === 'listenbrainz'
  const legacy = extra.music_service == null && extra.submission_client == null && extra.listening_from === 'spotify'
  if (!spotify && !legacy) return
  const id = spotifyId(extra.spotify_id) ?? spotifyId(extra.origin_url)
  if (!id || !int(row.listened_at, 0, Math.floor(Date.now() / 1000) + DAY)) return
  const artist = text(track.artist_name)
  const credits = Array.isArray(extra.artist_names) ? extra.artist_names.slice(0, 24).map((name) => text(name)).filter(Boolean) : []
  return [id, row.listened_at, text(track.track_name), artist, text(track.release_name), null, credits.length ? credits : [artist].filter(Boolean)]
}

export function defaults(mode: Mode): Filters {
  return { mode, artist: '', album: '', from: '', to: '', quiet: mode === 'era' ? 0 : 180, min: mode === 'forgotten' ? 2 : 1, max: mode === 'deep-cuts' ? 2 : null, perArtist: null, limit: 40 }
}

export function dateStart(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value ? +date / 1000 : undefined
}

export function utcEraRange(from: string, to: string): EraRange | undefined {
  const start = dateStart(from)
  const last = dateStart(to)
  if (start === undefined || last === undefined || start > last) return
  return [start, last + DAY]
}

export function readEraRange(from: string, to: string, value: unknown): EraRange | undefined {
  const utc = utcEraRange(from, to)
  if (!utc || value === undefined) return utc
  if (!Array.isArray(value) || value.length !== 2) return
  const [start, end] = value as unknown[]
  if (!int(start, utc[0] - DAY, utc[0] + DAY) || !int(end, utc[1] - DAY, utc[1] + DAY) || end <= start) return
  return [start, end]
}

export function readFilters(value: unknown): Filters | undefined {
  const input = object(value)
  if (!input || !['forgotten', 'deep-cuts', 'era'].includes(input.mode as string)) return
  const { mode, artist, album, from, to, quiet, min, max, perArtist, limit } = input
  if (!int(quiet, 0, 3650) || !int(min, 1, 100_000) || (max !== null && !int(max, min, 100_000)) || (perArtist !== null && !int(perArtist, 1, 200)) || !int(limit, 1, 200)) return
  if (typeof artist !== 'string' || artist.length > 300 || typeof album !== 'string' || album.length > 300 || typeof from !== 'string' || typeof to !== 'string') return
  if ((from && dateStart(from) === undefined) || (to && dateStart(to) === undefined) || (from && to && from > to)) return
  if (mode === 'era' && (!from || !to)) return
  if (mode !== 'era' && (from || to)) return
  return { mode: mode as Mode, artist: key(text(artist)), album: key(text(album)), from, to, quiet, min, max, perArtist, limit }
}

export function spotifyUrl(id: string): string {
  return `https://open.spotify.com/track/${id}`
}

export function playlistCsv(tracks: Track[]): string {
  const field = (value: string) => `"${(/^[=+\-@\t\r\n]/.test(value) ? "'" + value : value).replaceAll('"', '""')}"`
  return ['title,artist,album,url', ...tracks.map((t) => [t.title, t.artist, t.album, spotifyUrl(t.id)].map(field).join(','))].join('\r\n') + '\r\n'
}
