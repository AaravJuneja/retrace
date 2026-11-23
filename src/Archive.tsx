import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type Play, type Preview } from '../shared/history'
import { api, errorText, readStatus, sync } from './api'
import { dateLabel, timeLabel } from './dates'

const listenBrainzSettings = 'https://listenbrainz.org/settings/music-services/details/'

function askWorker<T>(worker: Worker, message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener('message', handler)
      worker.removeEventListener('error', failed)
    }
    const handler = ({ data }: MessageEvent) => {
      cleanup()
      if (data.type === 'error') reject(new Error(data.message))
      else resolve(data as T)
    }
    const failed = () => { cleanup(); reject(new Error('Could not read the archive in this browser.')) }
    worker.addEventListener('message', handler)
    worker.addEventListener('error', failed)
    worker.postMessage(message)
  })
}

export function Archive() {
  const client = useQueryClient()
  const state = useQuery({ queryKey: ['status'], queryFn: readStatus })
  const worker = useRef<Worker | null>(null)
  const paused = useRef(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [full, setFull] = useState(false)
  const [busy, setBusy] = useState<'read' | 'write' | null>(null)
  const [next, setNext] = useState(0)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  const [syncing, setSyncing] = useState(false)

  useEffect(() => () => { paused.current = true; worker.current?.terminate() }, [])

  async function open(files: File[]) {
    if (!files.length || busy) return
    worker.current?.terminate()
    const current = new Worker(new URL('./archive.worker.ts', import.meta.url), { type: 'module' })
    worker.current = current
    setBusy('read')
    setPreview(null)
    setNext(0)
    setProblem('')
    setNotice('')
    setFull(false)
    try {
      const response = await askWorker<{ preview: Preview }>(current, { type: 'open', files })
      setPreview(response.preview)
    } catch (error) { setProblem(errorText(error)) }
    finally { setBusy(null) }
  }

  async function add() {
    const current = worker.current
    if (!current || !preview || busy) return
    paused.current = false
    setBusy('write')
    setProblem('')
    setNotice('')
    try {
      const manifest = { id: preview.id, count: preview.count, first: preview.first, last: preview.last, full }
      let { next: offset } = await api<{ next: number }>('import/start', manifest)
      setNext(offset)
      while (offset < preview.count && !paused.current) {
        const { rows } = await askWorker<{ rows: Play[] }>(current, { type: 'batch', offset })
        const batch = await api<{ next: number }>('import/batch', { id: preview.id, offset, rows })
        if (batch.next <= offset || batch.next > preview.count) throw new Error('Import stopped at an unexpected position. Retry this archive.')
        offset = batch.next
        setNext(offset)
      }
      setNotice(offset === preview.count ? 'Archive imported.' : 'Import paused. Resume here or reselect the same files later.')
    } catch (error) { setProblem(`${errorText(error)} The saved batches won’t be repeated when you resume.`) }
    finally {
      setBusy(null)
      await Promise.all(['status', 'playlist', 'artists'].map((name) => client.invalidateQueries({ queryKey: [name] })))
    }
  }

  async function syncNow() {
    setSyncing(true)
    setProblem('')
    try {
      let result = await sync()
      for (let page = 1; page < 15 && result.pending; page++) result = await sync()
      setNotice(result.pending ? 'Some plays were collected. Sync again to continue catching up.' : 'ListenBrainz sync complete.')
    } catch (error) { setProblem(errorText(error)) }
    finally {
      setSyncing(false)
      await Promise.all(['status', 'playlist', 'artists'].map((name) => client.invalidateQueries({ queryKey: [name] })))
    }
  }

  const data = state.data
  return <main className="wrap main">
    <h1 className="sr-only">Listening archive</h1>
    {state.isError && <p role="alert" className="notice">{errorText(state.error)}</p>}
    <div className="archive-grid">
      <section className="panel" aria-labelledby="archive-title">
        <h2 id="archive-title">Import Spotify history</h2>
        <p>Choose the <strong>Extended Streaming History</strong> ZIP or its audio JSON files. Account data and Technical logs aren’t needed.</p>
        <p>Retrace opens the files on this device. It sends only music play records, not the ZIP, IP addresses, or private plays.</p>
        <label className="file-picker"><span>Archive files</span><input type="file" accept=".zip,.json" multiple disabled={!!busy} onChange={(e) => { const files = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ''; void open(files) }} /></label>
        {busy === 'read' && <p role="status">Reading the archive on this device…</p>}
        {preview && <div className="import-preview">
          <strong>{preview.count.toLocaleString()} music plays in {preview.files} {preview.files === 1 ? 'file' : 'files'}</strong>
          <p>{dateLabel(preview.first)} to {dateLabel(preview.last)}. Skipped {preview.private.toLocaleString()} private and {preview.skipped.toLocaleString()} non-music, unplayed, or invalid entries.</p>
          <label className="check"><input type="checkbox" checked={full} disabled={!!busy || next === preview.count} onChange={(e) => setFull(e.currentTarget.checked)} /> This is the complete lifetime export, not a selection of files.</label>
          <progress value={next} max={preview.count} aria-label="Archive import progress" />
          {busy === 'write' && <p role="status">{next.toLocaleString()} of {preview.count.toLocaleString()} records processed.</p>}
          <div className="row">
            <button className="primary" disabled={!!busy || next === preview.count} onClick={() => void add()}>{next ? 'Resume import' : 'Import plays'}</button>
            {busy === 'write' && <button onClick={() => { paused.current = true }}>Pause</button>}
          </div>
        </div>}
      </section>
      <section className="panel" aria-labelledby="coverage-title">
        <h2 id="coverage-title">Data coverage</h2>
        <dl className="sources">
          <div><dt>Spotify archive</dt><dd>{data?.archive.first != null && data.archive.last != null ? `${dateLabel(data.archive.first)} to ${dateLabel(data.archive.last)} (${data.archive.n.toLocaleString()} plays)` : 'No plays imported yet'}</dd></div>
          <div><dt>Newest ListenBrainz play</dt><dd>{data?.live.last != null ? timeLabel(data.live.last) : 'None recorded'}</dd></div>
          <div><dt>Last successful sync</dt><dd>{data?.feed.synced != null ? timeLabel(data.feed.synced) : 'Not yet synced'}</dd></div>
        </dl>
        {data?.feed.enabled ? <><p>Retrace collects public Spotify listens from ListenBrainz. Check the <a href={listenBrainzSettings} target="_blank" rel="noreferrer">connection</a> if new plays stop appearing. ListenBrainz requires reconnecting Spotify every six months.</p><button onClick={() => void syncNow()} disabled={syncing}>{syncing ? 'Syncing…' : 'Sync now'}</button></> : <p>Live sync is optional. Connect Spotify in <a href={listenBrainzSettings} target="_blank" rel="noreferrer">ListenBrainz</a>, then set the Worker’s ListenBrainz username. Hosted ListenBrainz history is public.</p>}
      </section>
    </div>
    {problem && <p className="notice" role="alert">{problem}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
  </main>
}
