import { getCookie, setCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { int, object, type Requester } from '../shared/history'

export type Env = {
  DISCORD_CLIENT_ID?: string
  DISCORD_CLIENT_SECRET?: string
  DISCORD_OWNER_ID?: string
  SESSION_SECRET?: string
  APP_ORIGIN?: string
  TURSO_DATABASE_URL?: string
  TURSO_AUTH_TOKEN?: string
  LISTENBRAINZ_USER?: string
}

type Ctx = Context<{ Bindings: Env }>
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const flowCookie = '__Host-retrace-flow'
const sessionCookie = '__Host-retrace-session'
const issuer = 'https://discord.com'
const sessionAge = 14 * 86_400

function to64(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function from64(data: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(data.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0))
}

function random(): string {
  return to64(crypto.getRandomValues(new Uint8Array(32)))
}

function hmac(secret: string) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function seal(secret: string, payload: Record<string, unknown>) {
  const value = to64(encoder.encode(JSON.stringify(payload)))
  const signature = await crypto.subtle.sign('HMAC', await hmac(secret), encoder.encode(value))
  return `${value}.${to64(new Uint8Array(signature))}`
}

export async function unseal(secret: string, value: string | undefined, now: number) {
  if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value)) return
  try {
    const [payload, signature] = value.split('.')
    if (!await crypto.subtle.verify('HMAC', await hmac(secret), from64(signature), encoder.encode(payload))) return
    const data = object(JSON.parse(decoder.decode(from64(payload))))
    if (data && int(data.exp, now + 1, now + sessionAge)) return data
  } catch { return }
}

export function authConfig(env: Env) {
  const { DISCORD_CLIENT_ID: client, DISCORD_CLIENT_SECRET: clientSecret, DISCORD_OWNER_ID: owner, SESSION_SECRET: secret, APP_ORIGIN: origin } = env
  if (!client || !clientSecret || !owner || !secret || secret.length < 32 || !origin || !/^\d{17,20}$/.test(owner)) return
  try {
    const url = new URL(origin)
    if (url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) return
    return { client, clientSecret, owner, secret, origin, callback: `${origin}/api/auth/discord/callback` }
  } catch { return }
}

export async function signedIn(c: Ctx): Promise<boolean> {
  const config = authConfig(c.env)
  if (!config || new URL(c.req.url).origin !== config.origin) return false
  const data = await unseal(config.secret, getCookie(c, sessionCookie), Math.floor(Date.now() / 1000))
  return data?.kind === 'session' && data.owner === config.owner
}

function cookie(c: Ctx, name: string, value: string, maxAge: number, sameSite: 'Lax' | 'Strict') {
  setCookie(c, name, value, { path: '/', secure: true, httpOnly: true, sameSite, maxAge })
}

export async function discordLogin(c: Ctx) {
  const config = authConfig(c.env)
  if (!config || new URL(c.req.url).origin !== config.origin) return c.redirect('/?login=unconfigured', 303)
  const state = random()
  const verifier = random()
  const challenge = to64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))))
  const flow = await seal(config.secret, { kind: 'flow', state, verifier, exp: Math.floor(Date.now() / 1000) + 600 })
  cookie(c, flowCookie, flow, 600, 'Lax')
  const params = new URLSearchParams({ client_id: config.client, redirect_uri: config.callback, response_type: 'code', scope: 'identify', state, code_challenge: challenge, code_challenge_method: 'S256' })
  return c.redirect(`${issuer}/oauth2/authorize?${params}`, 303)
}

export async function discordCallback(c: Ctx, request: Requester = fetch) {
  const config = authConfig(c.env)
  if (!config || new URL(c.req.url).origin !== config.origin) return c.redirect('/?login=unconfigured', 303)
  const signed = getCookie(c, flowCookie)
  cookie(c, flowCookie, '', 0, 'Lax')
  const code = c.req.query('code')
  const authIssuer = c.req.query('iss')
  const now = Math.floor(Date.now() / 1000)
  const flow = await unseal(config.secret, signed, now)
  if (c.req.query('error') === 'access_denied') return c.redirect('/?login=cancelled', 303)
  if (!code || code.length > 2048 || (authIssuer && authIssuer !== issuer) || flow?.kind !== 'flow' || typeof flow.state !== 'string' || flow.state !== c.req.query('state') || typeof flow.verifier !== 'string') return c.redirect('/?login=invalid', 303)

  const agent = `DiscordBot (${config.origin}, 1.0)`
  try {
    const exchange = await request(`${issuer}/api/v10/oauth2/token`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: `Basic ${btoa(`${config.client}:${config.clientSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': agent },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.callback, code_verifier: flow.verifier }),
      signal: AbortSignal.timeout(12_000),
    })
    if (!exchange.ok) return c.redirect('/?login=unavailable', 303)
    const token = object(await exchange.json())
    if (typeof token?.access_token !== 'string' || token.scope !== 'identify' || String(token.token_type).toLowerCase() !== 'bearer') return c.redirect('/?login=unavailable', 303)
    const response = await request(`${issuer}/api/v10/users/@me`, {
      headers: { Authorization: `Bearer ${token.access_token}`, 'User-Agent': agent }, redirect: 'manual', signal: AbortSignal.timeout(12_000),
    })
    if (!response.ok) return c.redirect('/?login=unavailable', 303)
    const user = object(await response.json())
    if (user?.id !== config.owner) return c.redirect('/?login=not-owner', 303)
    cookie(c, sessionCookie, await seal(config.secret, { kind: 'session', owner: config.owner, exp: now + sessionAge }), sessionAge, 'Strict')
    return c.redirect('/', 303)
  } catch { return c.redirect('/?login=unavailable', 303) }
}

export function signOut(c: Ctx) {
  cookie(c, sessionCookie, '', 0, 'Strict')
  return c.json({ ok: true })
}
