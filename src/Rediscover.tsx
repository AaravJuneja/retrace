import { useDeferredValue, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { DAY, defaults, playlistCsv, readFilters, spotifyUrl, type Artist, type EraRange, type Filters, type Mode, type Status, type Track } from '../shared/history'
import { errorText, findArtists, readPlaylist, readStatus } from './api'
import { dateLabel, localDate, localEraRange, since, timeLabel } from './dates'

const modes: Record<Mode, string> = { forgotten: 'Forgotten favorites', 'deep-cuts': 'Deep cuts', era: 'From an era' }

function ArtistPicker({ value, change }: { value: Artist | null; change: (artist: Artist | null) => void }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [editing, setEditing] = useState(false)
  const [search, setSearch] = useState('')
  const term = useDeferredValue(search)
  const { data: suggestions } = useQuery({ queryKey: ['artists', ''], queryFn: () => findArtists(''), select: (artists) => artists.slice(0, 3) })
  const options = useQuery({ queryKey: ['artists', term], queryFn: () => findArtists(term), enabled: editing })
  function close() {
    setEditing(false)
    trigger.current?.focus()
  }
  return <div className="artist-picker">
    <span className="field-title">Artist</span>
    <div className="artist-input">
      <button ref={trigger} className="artist-chip" aria-expanded={editing} aria-controls={editing ? 'artist-options' : undefined} onClick={() => { setEditing(!editing); setSearch('') }}>{value ? `Only ${value.name}` : 'All artists'} <span aria-hidden="true">⌄</span></button>
      {value && <button className="icon-button" aria-label={`Clear ${value.name} filter`} onClick={() => { change(null); close() }}>×</button>}
    </div>
    {editing && <div className="artist-options" id="artist-options" onKeyDown={(e) => { if (e.key === 'Escape') close() }}>
      <label className="sr-only" htmlFor="artist-search">Search recorded artists</label>
      <input id="artist-search" autoFocus placeholder="Search recorded artists" value={search} onChange={(e) => setSearch(e.currentTarget.value)} maxLength={300} />
      {options.isPending && <p role="status">Finding artists…</p>}
      {options.isError && <p role="alert">{errorText(options.error)}</p>}
      {options.data?.length === 0 && <p>No matching recorded artists.</p>}
      <ul>{options.data?.map((artist) => <li key={artist.key}><button onClick={() => { change(artist); close() }}>{artist.name}</button></li>)}</ul>
    </div>}
    {!editing && !!suggestions?.length && <div className="row artist-shortcuts" role="group" aria-label="Artists from your history">
      <span aria-hidden="true">From your history</span>
      {suggestions.map((artist) => <button key={artist.key} aria-pressed={value?.key === artist.key} onClick={() => change(value?.key === artist.key ? null : artist)}>{artist.name}</button>)}
    </div>}
    {value && <p className="credit-note">Guest appearances by {value.name} may be missing from older plays.</p>}
  </div>
}

function Coverage({ data, quiet, range }: { data: Status; quiet: number; range?: EraRange }) {
  const timestamp = Math.floor(Date.now() / 1000)
  const archiveThrough = data.coverage.reduce<number | null>((last, r) => Math.max(last ?? 0, r.last), null)
  const newest = Math.max(data.archive.last ?? 0, data.live.last ?? 0)
  const overlaps = (start: number, end: number) => {
    return (quiet > 0 && start <= timestamp && end >= timestamp - quiet * DAY)
      || (range ? start < range[1] && end >= range[0] : !quiet && start <= timestamp)
  }
  const gap = archiveThrough !== null && ((data.live.first !== null && data.live.first > archiveThrough + DAY && overlaps(archiveThrough + 1, data.live.first - 1)) || (!data.feed.enabled && archiveThrough < timestamp && overlaps(archiveThrough + 1, timestamp)))
  const feedLag = data.feed.enabled && (data.feed.error || data.feed.pending || (data.feed.synced !== null && timestamp - data.feed.synced > 6 * 3600))
  const partial = data.archive.n > 0 && archiveThrough === null && !data.feed.enabled
  return <>
    <div className="coverage">
      <span>Archive through <strong>{archiveThrough !== null ? dateLabel(archiveThrough) : 'not established'}</strong></span>
      <span>Newest recorded play <strong>{newest ? dateLabel(newest) : 'none'}</strong></span>
      <span>Live sync <strong>{data.feed.error ? 'failed' : !data.feed.enabled ? 'off' : data.feed.synced ? timeLabel(data.feed.synced) : 'not yet synced'}</strong></span>
    </div>
    {(gap || partial || feedLag || (data.feed.enabled && data.feed.synced === null && data.archive.n > 0)) && <p className="notice coverage-warning">
      {feedLag ? 'Live sync hasn’t caught up. Tracks missing from the feed may still appear.' : gap ? 'Part of this date range isn’t covered. Tracks you played during the gap may still appear.' : 'Recent coverage is incomplete. Some tracks may appear despite a later play.'} <Link to="/archive">View coverage</Link>
    </p>}
  </>
}

function Era({ filters, change, status }: { filters: Filters; change: (patch: Partial<Filters>) => void; status?: Status }) {
  const first = Math.min(status?.archive.first ?? Infinity, status?.live.first ?? Infinity)
  const last = Math.max(status?.archive.last ?? 0, status?.live.last ?? 0)
  const earliest = Number.isFinite(first) ? new Date(first * 1000).getFullYear() : 0
  const latest = last ? new Date(last * 1000).getFullYear() : 0
  const years = earliest ? Array.from({ length: Math.min(40, latest - earliest + 1) }, (_, i) => earliest + i) : []
  return <section className="era panel" aria-label="Choose dates for the era">
    <div className="era-header"><strong>Play dates</strong><span>Uses your device’s time zone and when you listened, not the release date.</span></div>
    <div className="era-years">{years.map((year) => <button key={year} aria-pressed={filters.from.startsWith(`${year}-`) && filters.to.startsWith(`${year}-`)} onClick={() => change({ from: `${year}-01-01`, to: `${year}-12-31` })}>{year}</button>)}</div>
    <div className="row">
      <label>From<input type="date" value={filters.from} onChange={(e) => change({ from: e.currentTarget.value })} /></label>
      <label>Through<input type="date" value={filters.to} onChange={(e) => change({ to: e.currentTarget.value })} /></label>
    </div>
  </section>
}

function FiltersPanel({ filters, change }: { filters: Filters; change: (patch: Partial<Filters>) => void }) {
  return <details className="filters panel" open={window.matchMedia('(min-width: 681px)').matches}>
    <summary>More filters</summary>
    <div className="filter-fields">
      <label>Exact album name<input type="text" value={filters.album} placeholder="Any album" maxLength={300} onChange={(e) => change({ album: e.currentTarget.value })} /></label>
      <label>Days without a qualifying play<input type="number" min="0" max="3650" value={filters.quiet} onChange={(e) => change({ quiet: Number(e.currentTarget.value) })} /></label>
      <label>Minimum plays<input type="number" min="1" value={filters.min} onChange={(e) => change({ min: Number(e.currentTarget.value) })} /></label>
      <label>Maximum plays<input type="number" min="1" value={filters.max ?? ''} placeholder="Any" onChange={(e) => change({ max: e.currentTarget.value ? Number(e.currentTarget.value) : null })} /></label>
      {!filters.artist && <label>Maximum tracks per artist<input type="number" min="1" max="200" value={filters.perArtist ?? ''} placeholder="Any" onChange={(e) => change({ perArtist: e.currentTarget.value ? Number(e.currentTarget.value) : null })} /></label>}
      <label>Playlist length<input type="number" min="1" max="200" value={filters.limit} onChange={(e) => change({ limit: Number(e.currentTarget.value) })} /></label>
    </div>
  </details>
}

function Results({ tracks, artist, mode }: { tracks: Track[]; artist: Artist | null; mode: Mode }) {
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const [notice, setNotice] = useState('')
  const kept = tracks.filter((track) => !removed.has(track.id))
  function download() {
    const url = URL.createObjectURL(new Blob([playlistCsv(kept)], { type: 'text/csv;charset=utf-8' }))
    const link = Object.assign(document.createElement('a'), { href: url, download: 'retrace-playlist.csv' })
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function copy() {
    try { await navigator.clipboard.writeText(kept.map((t) => spotifyUrl(t.id)).join('\n')); setNotice('Spotify links copied.') }
    catch { setNotice('Could not copy links. Download the CSV instead.') }
  }
  return <section className="results" aria-labelledby="playlist-title">
    <div className="results-head">
      <div><h2 id="playlist-title">Playlist preview</h2><p>{kept.length} {kept.length === 1 ? 'track' : 'tracks'}{artist ? ` for ${artist.name}` : ''}</p></div>
      {tracks.length > 0 && <div className="export">
        <div className="row"><button className="primary" disabled={!kept.length} onClick={download}>Download CSV</button><button disabled={!kept.length} onClick={() => void copy()}>Copy Spotify links</button></div>
        <p>In <a href="https://soundiiz.com/webapp/playlists" target="_blank" rel="noreferrer">Soundiiz</a>, choose Import Playlist, then From File and Spotify.</p>
      </div>}
    </div>
    {notice && <p role="status" className="notice">{notice}</p>}
    {removed.size > 0 && <p className="small"><button onClick={() => setRemoved(new Set())}>Restore removed tracks</button></p>}
    {kept.length ? <table>
      <thead><tr><th className="index" scope="col">#</th><th scope="col">Track</th><th scope="col">{mode === 'era' ? 'Plays in era' : 'Plays'}</th><th scope="col">Last recorded play</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
      <tbody>{kept.map((track, index) => <tr key={track.id}>
        <td className="index">{index + 1}</td>
        <td><a className="track" href={spotifyUrl(track.id)} target="_blank" rel="noreferrer">{track.title || 'Untitled track'}</a><span className="track-meta">{[artist?.name === track.artist ? '' : track.artist, track.album].filter(Boolean).join(' / ')}</span></td>
        <td>{track.plays.toLocaleString()}</td><td><span className="played">{since(track.last)}</span><span className="track-meta when">{dateLabel(track.last)}</span></td>
        <td className="remove"><button className="icon-button" aria-label={`Remove ${track.title || 'track'}`} onClick={() => { setNotice(''); setRemoved(new Set([...removed, track.id])) }}>×</button></td>
      </tr>)}</tbody>
    </table> : <p className="notice">{tracks.length ? 'All matches are removed from this draft.' : 'No matching tracks. Try a shorter quiet period, a wider date range, or fewer filters.'}</p>}
  </section>
}

export function Rediscover() {
  const history = useQuery({ queryKey: ['status'], queryFn: readStatus })
  const [mode, setMode] = useState<Mode>('forgotten')
  const [artist, setArtist] = useState<Artist | null>(null)
  const [settings, setSettings] = useState(() => defaults('forgotten'))
  const filters = { ...settings, artist: artist?.key ?? '' }
  const input = useDeferredValue(filters)
  const data = history.data
  const hasPlays = !!(data?.archive.n || data?.live.n)
  const range = localEraRange(input.from, input.to)
  const valid = !!readFilters(input) && (input.mode !== 'era' || !!range)
  const results = useQuery({ queryKey: ['playlist', input, range], queryFn: () => readPlaylist(input, range), enabled: hasPlays && valid })
  const change = (patch: Partial<Filters>) => setSettings((previous) => ({ ...previous, ...patch }))

  function select(next: Mode) {
    if (next === mode) return
    setMode(next)
    const nextSettings = defaults(next)
    if (next === 'era') {
      const first = Math.min(data?.archive.first ?? Infinity, data?.live.first ?? Infinity)
      const year = Number.isFinite(first) ? new Date(first * 1000).getFullYear() : new Date().getFullYear()
      nextSettings.from = `${year}-01-01`
      nextSettings.to = [localDate(new Date()), `${year}-12-31`].sort()[0]
    }
    setSettings(nextSettings)
  }

  return <main className="wrap main">
    <h1 className="sr-only">Rediscover</h1>
    {history.isPending && <p role="status">Loading listening history…</p>}
    {history.isError && <p role="alert" className="notice">{errorText(history.error)} <button onClick={() => void history.refetch()}>Retry</button></p>}
    {data && !hasPlays && <section className="empty panel"><h2>Start with your listening history</h2><p>Import your Spotify Extended Streaming History to rediscover older plays. {data.feed.enabled ? 'Live sync is on. New plays will appear once ListenBrainz records them.' : 'You can also start collecting new plays while the export is preparing.'}</p><Link className="primary button" to="/archive">Open archive</Link></section>}
    {data && hasPlays && <>
      <div className="builder">
        <div className="modes" role="group" aria-label="Playlist mode">{Object.entries(modes).map(([id, label]) => <button key={id} aria-pressed={id === mode} onClick={() => select(id as Mode)}>{label}</button>)}</div>
        <p className="rule">{filters.mode === 'era' ? 'Rank tracks by plays in the selected dates.' : filters.mode === 'deep-cuts' ? `Rarely played tracks${filters.quiet ? ` with no qualifying plays in the last ${filters.quiet} days` : ''}.` : `At least ${filters.min} qualifying ${filters.min === 1 ? 'play' : 'plays'}${filters.quiet ? `, none in the last ${filters.quiet} days` : ''}.`}</p>
        <ArtistPicker value={artist} change={setArtist} />
      </div>
      {mode === 'era' && <Era filters={filters} change={change} status={data} />}
      <Coverage data={data} quiet={filters.quiet} range={localEraRange(filters.from, filters.to)} />
      <div className="content">
        <FiltersPanel filters={filters} change={change} />
        {!valid ? <p className="notice" role="status">Check the date range and playlist limits.</p> : results.isError ? <p className="notice" role="alert">{errorText(results.error)} <button onClick={() => void results.refetch()}>Retry</button></p> : results.isPending ? <p role="status">Building playlist…</p> : <Results tracks={results.data} artist={artist} mode={input.mode} key={JSON.stringify(input)} />}
      </div>
    </>}
  </main>
}
