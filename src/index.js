import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-github-login'
export const inject = ['tools']

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const API_ROOT = 'https://api.github.com'
const DEFAULT_SCOPES = 'read:user user:email'
const MAX_API_RESPONSE_BYTES = 512_000

function text(value) { return typeof value === 'string' ? value.trim() : '' }
function configuredPath(config) {
  const value = text(config?.tokenPath) || text(process.env.DSH_GITHUB_TOKEN_PATH)
  return resolve(value || join(homedir(), '.config', 'dsh-github-login', 'credentials.json'))
}
function configuredClientId(config) { return text(config?.clientId) || text(process.env.DSH_GITHUB_CLIENT_ID) }
function configuredScopes(config, requested) {
  return text(requested) || text(config?.scopes) || text(process.env.DSH_GITHUB_SCOPES) || DEFAULT_SCOPES
}
async function loadJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error?.code === 'ENOENT') return null; throw new Error(`Unable to read GitHub login state: ${error.message}`) }
}
async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}
async function removeState(path) { await rm(path, { force: true }) }

async function fetchJson(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: options.signal ?? controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'dsh-github-login/0.1.0', ...(options.headers || {}) } })
    const raw = await response.text()
    let data
    try { data = raw ? JSON.parse(raw) : null } catch { data = { message: raw.slice(0, 1000) } }
    if (!response.ok) {
      const error = new Error(text(data?.message) || `GitHub returned HTTP ${response.status}`)
      error.status = response.status; error.data = data; throw error
    }
    return data
  } catch (error) { if (error?.name === 'AbortError') throw new Error('GitHub request timed out'); throw error }
  finally { clearTimeout(timer) }
}
function requireClientId(config) {
  const clientId = configuredClientId(config)
  if (!clientId) throw new Error('GitHub Client ID is not configured. Set DSH_GITHUB_CLIENT_ID or configure clientId in the plugin patch.')
  return clientId
}
function publicUser(user) {
  return { login: user?.login ?? null, name: user?.name ?? null, id: user?.id ?? null,
    avatar_url: user?.avatar_url ?? null, html_url: user?.html_url ?? null }
}
function outputText(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
const output = { schema: { type: 'object', additionalProperties: true }, render: outputText }
function tool(definition) { return defineTool({ ...definition, output }) }

export function apply(ctx, config = {}) {
  const tokenPath = configuredPath(config)
  ctx.tools.register(tool({
    name: 'github_login_start',
    description: 'Start GitHub login with OAuth Device Flow. Open verification_uri and enter user_code, then call github_login_poll.',
    parameters: {}, timeoutMs: 30_000,
    async execute() {
      const clientId = requireClientId(config)
      const scope = configuredScopes(config)
      const data = await fetchJson(DEVICE_CODE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: clientId, scope }) })
      if (!data?.device_code || !data?.user_code || !data?.verification_uri) throw new Error('GitHub did not return a valid device authorization response')
      const pending = { kind: 'device-flow', device_code: data.device_code, client_id: clientId,
        interval: Math.max(5, Number(data.interval) || 5), expires_at: Date.now() + (Number(data.expires_in) || 900) * 1000, scope }
      await saveJson(tokenPath, pending)
      return { status: 'authorization_required', verification_uri: data.verification_uri,
        verification_uri_complete: data.verification_uri_complete ?? null, user_code: data.user_code,
        expires_in: data.expires_in, interval: pending.interval, scope,
        next_step: 'Open verification_uri, enter user_code, then call github_login_poll.' }
    },
  }))
  ctx.tools.register(tool({
    name: 'github_login_poll',
    description: 'Finish GitHub device login after authorization. Polls once and never exposes the access token.',
    parameters: {}, timeoutMs: 30_000,
    async execute() {
      const pending = await loadJson(tokenPath)
      if (!pending?.device_code || pending.kind !== 'device-flow') throw new Error('No pending GitHub login. Call github_login_start first.')
      if (Date.now() >= Number(pending.expires_at)) { await removeState(tokenPath); throw new Error('The GitHub device code expired. Start login again.') }
      const data = await fetchJson(ACCESS_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: pending.client_id, device_code: pending.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) }).catch(async (error) => {
        const code = error?.data?.error
        if (code === 'authorization_pending') return { authorization_pending: true }
        if (code === 'slow_down') { pending.interval = Math.min(60, (Number(pending.interval) || 5) + 5); await saveJson(tokenPath, pending); return { authorization_pending: true, slow_down: true, interval: pending.interval } }
        if (code === 'expired_token') { await removeState(tokenPath); throw new Error('The GitHub device code expired. Start login again.') }
        if (code === 'access_denied') { await removeState(tokenPath); throw new Error('GitHub authorization was denied.') }
        throw error
      })
      if (data?.error === 'authorization_pending') return { status: 'authorization_pending', interval: pending.interval, next_step: 'Wait for the indicated interval, then call github_login_poll again.' }
      if (data?.error === 'slow_down') { pending.interval = Math.min(60, (Number(pending.interval) || 5) + 5); await saveJson(tokenPath, pending); return { status: 'authorization_pending', interval: pending.interval, next_step: 'Wait for the indicated interval, then call github_login_poll again.' } }
      if (data?.error === 'expired_token') { await removeState(tokenPath); throw new Error('The GitHub device code expired. Start login again.') }
      if (data?.error === 'access_denied') { await removeState(tokenPath); throw new Error('GitHub authorization was denied.') }
      if (data.authorization_pending) return { status: 'authorization_pending', interval: data.interval ?? pending.interval, next_step: 'Wait for the indicated interval, then call github_login_poll again.' }
      if (!data?.access_token) throw new Error('GitHub did not return an access token')
      const token = { kind: 'token', access_token: data.access_token, token_type: data.token_type || 'bearer', scope: data.scope || pending.scope, created_at: new Date().toISOString() }
      await saveJson(tokenPath, token)
      const user = await githubRequest(token, '/user', { method: 'GET' })
      return { status: 'authenticated', user: publicUser(user), scope: token.scope }
    },
  }))
  ctx.tools.register(tool({
    name: 'github_auth_status',
    description: 'Check whether this DeepSeek Harness instance has an active GitHub login. Never returns the token.',
    parameters: {}, timeoutMs: 30_000,
    async execute() {
      const state = await loadJson(tokenPath)
      if (!state?.access_token) return { authenticated: false, status: state?.kind === 'device-flow' ? 'authorization_pending' : 'logged_out' }
      try { const user = await githubRequest(state, '/user', { method: 'GET' }); return { authenticated: true, user: publicUser(user), scope: state.scope || '' } }
      catch (error) { if (error?.status === 401) { await removeState(tokenPath); return { authenticated: false, status: 'invalid_token' } }; throw error }
    },
  }))
  ctx.tools.register(tool({
    name: 'github_logout',
    description: 'Remove the locally stored GitHub login token from this DeepSeek Harness instance.',
    parameters: {}, timeoutMs: 10_000,
    async execute() { await removeState(tokenPath); return { status: 'logged_out' } },
  }))
  ctx.tools.register(tool({
    name: 'github_api',
    description: 'Call an authenticated GitHub REST API endpoint. Use a path beginning with /, a method, and body null for methods without a body. Tokens are never returned.',
    parameters: { path: { type: 'string' }, method: { type: 'string' }, body: { type: 'json' } }, timeoutMs: 60_000,
    async execute({ path, method, body }, exec) {
      const state = await loadJson(tokenPath)
      if (!state?.access_token) throw new Error('Not logged in. Call github_login_start first.')
      const normalizedMethod = text(method).toUpperCase()
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(normalizedMethod)) throw new Error('Unsupported GitHub API method. Use GET, POST, PUT, PATCH, or DELETE.')
      return githubRequest(state, normalizeApiPath(path), { method: normalizedMethod, body: body == null || normalizedMethod === 'GET' ? undefined : JSON.stringify(body), signal: exec?.signal })
    },
  }))
}

function normalizeApiPath(path) {
  const value = text(path)
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.includes('\n') || value.includes('\r')) throw new Error('GitHub API path must be a relative path beginning with /')
  const url = new URL(value, API_ROOT)
  if (url.origin !== API_ROOT) throw new Error('GitHub API path must stay on api.github.com')
  return `${url.pathname}${url.search}`
}
async function githubRequest(state, path, options = {}) {
  const headers = { authorization: `Bearer ${state.access_token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(API_ROOT + normalizeApiPath(path), { ...options, headers: { ...headers, ...(options.headers || {}) } })
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > MAX_API_RESPONSE_BYTES) throw new Error('GitHub API response is too large to return to the model')
  const raw = await response.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_API_RESPONSE_BYTES) throw new Error('GitHub API response is too large to return to the model')
  let data; try { data = raw ? JSON.parse(raw) : null } catch { data = { raw: raw.slice(0, 1000) } }
  if (!response.ok) { const error = new Error(text(data?.message) || `GitHub returned HTTP ${response.status}`); error.status = response.status; error.data = data; throw error }
  return data ?? { status: response.status }
}
