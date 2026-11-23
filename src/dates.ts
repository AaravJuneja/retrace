import { DAY, dateStart, utcEraRange, type EraRange } from '../shared/history'

const shortDate = new Intl.DateTimeFormat(undefined, { calendar: 'gregory', month: 'short', day: 'numeric', year: 'numeric' })
const dateTime = new Intl.DateTimeFormat(undefined, { calendar: 'gregory', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
const unit = (count: number, name: string) => `${count.toLocaleString()} ${name}${count === 1 ? '' : 's'}`

export const dateLabel = (seconds: number) => shortDate.format(seconds * 1000)
export const timeLabel = (seconds: number) => dateTime.format(seconds * 1000)

export function localDate(date: Date) {
  return [String(date.getFullYear()).padStart(4, '0'), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}

export function localEraRange(from: string, to: string): EraRange | undefined {
  const utc = utcEraRange(from, to)
  if (!utc) return
  const nextDay = new Date(utc[1] * 1000).toISOString().split('T')[0]
  const start = Date.parse(`${from}T00:00:00`) / 1000
  const end = Date.parse(`${nextDay}T00:00:00`) / 1000
  if (start < end) return [start, end]
}

export function since(seconds: number, now = new Date()) {
  const today = dateStart(localDate(now))!
  const played = dateStart(localDate(new Date(seconds * 1000)))!
  const days = Math.max(0, (today - played) / DAY)
  if (!days) return 'Today'
  if (days < 60) return `${unit(days, 'day')} ago`
  const months = Math.floor(days / 30.437)
  if (months < 12) return `${unit(months, 'month')} ago`
  const years = Math.floor(months / 12)
  return `${unit(years, 'year')}${years === 1 && months % 12 ? `, ${unit(months % 12, 'month')}` : ''} ago`
}
