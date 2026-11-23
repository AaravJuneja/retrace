import { Unzip, UnzipInflate } from 'fflate'
import { ARCHIVE_AUDIO, BATCH_SIZE, archiveRow, object, type Play, type Preview } from '../shared/history'

type Request = { type: 'open'; files: File[] } | { type: 'batch'; offset: number }
let records: Play[] = []
let ready = false
const MAX_SHARD = 60_000_000

function digest(content: string) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
    .then((bytes) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join(''))
}

async function scan(files: File[]): Promise<Preview> {
  records = []
  ready = false
  const hashes: Promise<string>[] = []
  let first = Infinity
  let last = 0
  let skipped = 0
  let privatePlays = 0

  function parse(content: string, name: string) {
    let list: unknown
    try { list = JSON.parse(content.replace(/^\uFEFF/u, '')) } catch { throw new Error(`Cannot read ${name} as JSON.`) }
    if (!Array.isArray(list) || (list.length && !list.some((entry) => {
      const row = object(entry)
      return row && 'ts' in row && 'ms_played' in row && 'spotify_track_uri' in row
    }))) throw new Error(`${name} is not Spotify Extended Streaming History audio JSON.`)

    const start = records.length
    for (const row of list) {
      const play = archiveRow(row)
      if (play === 'private') privatePlays++
      else if (!play) skipped++
      else {
        records.push(play)
        first = Math.min(first, play[1])
        last = Math.max(last, play[1])
      }
    }
    hashes.push(digest(JSON.stringify(records.slice(start))))
  }

  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      const unzip = new Unzip((member) => {
        const name = member.name.split('/').at(-1) ?? ''
        if (!ARCHIVE_AUDIO.test(name)) return
        const decoder = new TextDecoder()
        let content = ''
        let size = 0
        member.ondata = (error, bytes, final) => {
          if (error) throw error
          size += bytes.length
          if (size > MAX_SHARD) throw new Error(`${name} is too large to open safely in this browser.`)
          content += decoder.decode(bytes, { stream: !final })
          if (final) parse(content, name)
        }
        member.start()
      })
      unzip.register(UnzipInflate)
      const reader = file.stream().getReader()
      try {
        while (true) {
          const { value, done } = await reader.read()
          unzip.push(value ?? new Uint8Array(), done)
          if (done) break
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    } else if (/\.json$/i.test(file.name)) {
      if (file.size > MAX_SHARD) throw new Error(`${file.name} is too large to open safely in this browser.`)
      parse(await file.text(), file.name)
    } else throw new Error('Choose the Extended Streaming History ZIP or its audio JSON files.')
  }

  if (!hashes.length) throw new Error('No audio history files found. Choose Extended Streaming History, not Account data or Technical logs.')
  if (!records.length) throw new Error('No eligible music plays were found in these files.')
  const compare = (a: string, b: string) => a === b ? 0 : a < b ? -1 : 1
  records.sort((a, b) => a[1] - b[1] || compare(a[0], b[0]) || (b[5] ?? 0) - (a[5] ?? 0) || compare(a[2], b[2]) || compare(a[3], b[3]) || compare(a[4], b[4]))
  const id = await digest((await Promise.all(hashes)).sort().join(' '))
  ready = true
  return { id, first, last, count: records.length, files: hashes.length, private: privatePlays, skipped }
}

self.onmessage = ({ data }: MessageEvent<Request>) => {
  if (data.type === 'batch') {
    self.postMessage(ready ? { type: 'batch', rows: records.slice(data.offset, data.offset + BATCH_SIZE) } : { type: 'error', message: 'Open the archive first.' })
    return
  }
  scan(data.files).then(
    (preview) => self.postMessage({ type: 'preview', preview }),
    (error: unknown) => self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Could not open the archive.' }),
  )
}
