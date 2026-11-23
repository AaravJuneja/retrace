import type { Artist, Filters, Status, Track } from '../shared/history'

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
export const readPlaylist = (filters: Filters) => api<Track[]>('playlist', filters)
export const sync = () => api<{ pending: boolean; synced: number | null }>('sync', {})

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Try again in a moment.'
}

const shortDate = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const dateTime = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' })
export const dateLabel = (seconds: number) => shortDate.format(seconds * 1000)
export const timeLabel = (seconds: number) => dateTime.format(seconds * 1000)
const unit = (count: number, name: string) => `${count.toLocaleString()} ${name}${count === 1 ? '' : 's'}`

export function since(seconds: number) {
  const days = Math.max(0, Math.floor((Date.now() / 1000 - seconds) / 86400))
  if (!days) return 'Today'
  if (days < 60) return `${unit(days, 'day')} ago`
  const months = Math.floor(days / 30.437)
  if (months < 12) return `${unit(months, 'month')} ago`
  const years = Math.floor(months / 12)
  return `${unit(years, 'year')}${years === 1 && months % 12 ? `, ${unit(months % 12, 'month')}` : ''} ago`
}
