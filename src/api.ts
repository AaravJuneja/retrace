import type { Artist, EraRange, Filters, Status, Track } from '../shared/history'

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!response.ok) {
    const { error } = await response.json().catch(() => ({ error: '' })) as { error?: string }
    throw new Error(error || `Request failed (${response.status}).`)
  }
  return response.json() as Promise<T>
}

export const session = () => api<{ signedIn: boolean; configured: boolean }>('session')
export const readStatus = () => api<Status>('status')
export const findArtists = (search: string) => api<Artist[]>('artists', { search })
export const readPlaylist = (filters: Filters, range?: EraRange) => api<Track[]>('playlist', { ...filters, range })
export const sync = () => api<{ pending: boolean; synced: number | null }>('sync', {})

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Try again in a moment.'
}
