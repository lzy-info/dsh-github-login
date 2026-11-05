import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function mounted(config) {
  const tools = new Map()
  apply({ tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } } }, config)
  return tools
}

test('starts device flow and persists only pending state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-github-login-'))
  const tokenPath = join(dir, 'credentials.json')
  const originalFetch = globalThis.fetch
  const originalClientId = process.env.DSH_GITHUB_CLIENT_ID
  process.env.DSH_GITHUB_CLIENT_ID = 'client-test'
  globalThis.fetch = async () => response({ device_code: 'device', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })
  try {
    const result = await mounted({ tokenPath }).get('github_login_start').execute({})
    assert.equal(result.status, 'authorization_required')
    assert.equal(result.user_code, 'ABCD-EFGH')
    const saved = JSON.parse(await readFile(tokenPath, 'utf8'))
    assert.equal(saved.device_code, 'device')
    assert.equal(saved.access_token, undefined)
  } finally {
    globalThis.fetch = originalFetch
    if (originalClientId === undefined) delete process.env.DSH_GITHUB_CLIENT_ID
    else process.env.DSH_GITHUB_CLIENT_ID = originalClientId
    await rm(dir, { recursive: true, force: true })
  }
})

test('rejects API paths that escape api.github.com', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-github-login-'))
  const tokenPath = join(dir, 'credentials.json')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => response({ login: 'test' })
  try {
    await writeFile(tokenPath, JSON.stringify({ kind: 'token', access_token: 'token' }))
    const tools = mounted({ tokenPath })
    await assert.rejects(() => tools.get('github_api').execute({ path: 'https://example.com/', method: 'GET', body: null }), /relative path/)
  } finally {
    globalThis.fetch = originalFetch
    await rm(dir, { recursive: true, force: true })
  }
})

test('handles GitHub authorization_pending responses returned with HTTP 200', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-github-login-'))
  const tokenPath = join(dir, 'credentials.json')
  const originalFetch = globalThis.fetch
  await writeFile(tokenPath, JSON.stringify({ kind: 'device-flow', device_code: 'device', client_id: 'client', interval: 5, expires_at: Date.now() + 60_000 }))
  globalThis.fetch = async () => response({ error: 'authorization_pending', error_description: 'The user has not yet authorized' })
  try {
    const result = await mounted({ tokenPath }).get('github_login_poll').execute({})
    assert.equal(result.status, 'authorization_pending')
    assert.equal(result.interval, 5)
  } finally {
    globalThis.fetch = originalFetch
    await rm(dir, { recursive: true, force: true })
  }
})
