import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { makePdf } from './pdf-fixture.mjs'
import { DEFAULT_PDF_OPTIONS } from '../dist/pdf.js'

const requests = []
let respond = () => new Response('hello', { headers: { 'content-type': 'text/plain' } })
class Agent {
  constructor(options) { this.options = options; this.closed = false }
  async close() { this.closed = true }
}
mock.module('undici', {
  namedExports: {
    Agent,
    fetch: async (url, init) => {
      const addresses = await new Promise((resolve, reject) => {
        init.dispatcher.options.connect.lookup(url.hostname, { all: true }, (err, result) => err ? reject(err) : resolve(result))
      })
      requests.push({ url: String(url), addresses, init })
      return respond(url, init)
    },
  },
})
const { HttpFetchProvider } = await import('@deepseek-ai/dsh-web-fetch-http')
const { HttpFetchProvider: PdfFetchProvider } = await import('../dist/vendor/provider.js')
const plugin = await import('../dist/index.js')
const { createFakeIpResolver } = await import('../dist/resolver.js')
const limits = { maxResponseBytes: 5000, maxBodyChars: 1000, timeoutMs: 1000, maxRedirects: 5, userAgent: 'test' }

function provider({ answers, systemLookup, dnsFetch, pdfOptions, ...overrides } = {}) {
  const resolver = createFakeIpResolver({ dohUrl: 'https://dns.alidns.com/resolve', dnsTimeoutMs: 1000 }, {
    lookup: systemLookup ?? (async () => [{ address: '198.18.0.7', family: 4 }]),
    fetch: dnsFetch ?? (async input => {
      const url = new URL(input)
      const type = Number(url.searchParams.get('type'))
      return Response.json({ Status: 0, Answer: type === 1 ? [{ type, data: answers?.() ?? '93.184.216.34' }] : [] })
    }),
  })
  return new PdfFetchProvider({ ...limits, ...overrides }, resolver, { ...DEFAULT_PDF_OPTIONS, ...pdfOptions })
}

test('reproduces the stock PDF content-type failure and fixes it in the same single request', async () => {
  requests.length = 0
  respond = () => new Response(makePdf(['Readable PDF text']), { headers: { 'content-type': 'application/pdf' } })
  const old = new HttpFetchProvider(limits, async () => [{ address: '93.184.216.34', family: 4 }])
  await assert.rejects(old.fetch({ url: 'https://example.com/doc.pdf' }), { code: 'WEB_UNSUPPORTED_CONTENT_TYPE' })
  requests.length = 0
  const result = await provider().fetch({ url: 'https://example.com/doc.pdf' })
  assert.equal(requests.length, 1); assert.equal(result.body.kind, 'text')
  assert.ok(result.body.content.includes('Readable PDF text')); assert.equal(result.statusCode, 200)
  assert.deepEqual(requests[0].addresses, [{ address: '93.184.216.34', family: 4 }])
  assert.ok(requests[0].init.headers.accept.includes('application/pdf'))
  assert.equal(requests[0].init.dispatcher.closed, true)
})

test('PDF MIME parameters and a generic download ending in .pdf are accepted', async () => {
  for (const contentType of ['Application/PDF; charset=binary', 'application/octet-stream']) {
    respond = () => new Response(makePdf(), { headers: { 'content-type': contentType } })
    assert.equal((await provider().fetch({ url: 'https://example.com/doc.pdf?download=1' })).body.kind, 'text')
  }
})

test('PDF rejects both declared and streamed download overflow without parsing partial bytes', async () => {
  for (const headers of [{ 'content-type': 'application/pdf', 'content-length': '10000' }, { 'content-type': 'application/pdf' }]) {
    respond = () => new Response(makePdf(), { headers })
    await assert.rejects(provider({ pdfOptions: { maxPdfBytes: 100 } }).fetch({ url: 'https://example.com/doc.pdf' }), { code: 'WEB_FETCH_TOO_LARGE' })
  }
})

test('PDF follows same-origin redirects once and enforces PDF character limits', async () => {
  requests.length = 0
  respond = url => url.pathname === '/start' ? new Response(null, { status: 302, headers: { location: '/doc.pdf' } })
    : new Response(makePdf(['Text from a redirected PDF']), { headers: { 'content-type': 'application/pdf' } })
  const result = await provider({ maxBodyChars: 20 }).fetch({ url: 'https://example.com/start' })
  assert.equal(result.url, 'https://example.com/doc.pdf'); assert.equal(result.truncated, true); assert.equal(result.body.content.length, 20)
  assert.equal(requests.length, 2); assert.ok(requests.every(request => request.init.dispatcher.closed))
})

test('overall timeout covers a stalled PDF response body', async () => {
  respond = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('%PDF-1.4\n')) } }), { headers: { 'content-type': 'application/pdf' } })
  const keepAlive = setTimeout(() => {}, 1000)
  try { await assert.rejects(provider({ timeoutMs: 20 }).fetch({ url: 'https://example.com/doc.pdf' }), { code: 'WEB_FETCH_TIMEOUT' }) }
  finally { clearTimeout(keepAlive) }
})

test('actual upstream fetcher pins DoH addresses and preserves the URL hostname', async () => {
  requests.length = 0
  respond = () => new Response('hello', { headers: { 'content-type': 'text/plain' } })
  const result = await provider().fetch({ url: 'https://example.com/page' })
  assert.equal(result.statusCode, 200)
  assert.equal(result.body.content, 'hello')
  assert.equal(requests[0].url, 'https://example.com/page')
  assert.deepEqual(requests[0].addresses, [{ address: '93.184.216.34', family: 4 }])
  assert.equal(requests[0].init.dispatcher.closed, true)
})

test('same-origin redirects resolve and validate each hop', async () => {
  requests.length = 0
  respond = url => new URL(url).pathname === '/start'
    ? new Response(null, { status: 302, headers: { location: '/end' } })
    : new Response('end', { headers: { 'content-type': 'text/plain' } })
  const result = await provider().fetch({ url: 'https://example.com/start' })
  assert.equal(result.url, 'https://example.com/end')
  assert.equal(requests.length, 2)
  assert.ok(requests.every(request => request.init.dispatcher.closed))
})

test('rebinding on a later redirect cannot reach a private address', async () => {
  requests.length = 0
  respond = () => new Response(null, { status: 302, headers: { location: '/end' } })
  let resolutions = 0
  await assert.rejects(provider({ answers: () => ++resolutions === 1 ? '93.184.216.34' : '127.0.0.1' }).fetch({ url: 'https://example.com/start' }), { code: 'WEB_BLOCKED_URL' })
  assert.equal(requests.length, 1)
})

test('cross-origin redirects retain the upstream refusal', async () => {
  respond = () => new Response(null, { status: 302, headers: { location: 'https://other.example/' } })
  await assert.rejects(provider().fetch({ url: 'https://example.com/' }), { code: 'WEB_REDIRECT_BLOCKED' })
})

test('upstream byte limits and body truncation still apply', async () => {
  respond = () => new Response('abcdef', { headers: { 'content-type': 'text/plain', 'content-length': '6' } })
  await assert.rejects(provider({ maxResponseBytes: 3 }).fetch({ url: 'https://example.com/' }), { code: 'WEB_FETCH_TOO_LARGE' })
  respond = () => new Response('abcdef', { headers: { 'content-type': 'text/plain' } })
  const bytes = await provider({ maxResponseBytes: 3 }).fetch({ url: 'https://example.com/' })
  assert.equal(bytes.body.content, 'abc')
  assert.equal(bytes.truncated, true)
  const result = await provider({ maxBodyChars: 3 }).fetch({ url: 'https://example.com/' })
  assert.equal(result.body.content, 'abc')
  assert.equal(result.truncated, true)
})

test('the overall fetch deadline remains WEB_FETCH_TIMEOUT during system DNS', async () => {
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    await assert.rejects(provider({ timeoutMs: 15, systemLookup: () => new Promise(() => {}) }).fetch({ url: 'https://example.com/' }), { code: 'WEB_FETCH_TIMEOUT' })
  } finally { clearTimeout(keepAlive) }
})

const hangingFetch = async (_url, { signal }) => new Promise((_, reject) => {
  if (signal.aborted) reject(signal.reason)
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
})

test('the overall fetch deadline remains WEB_FETCH_TIMEOUT during DoH', async () => {
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    await assert.rejects(provider({ timeoutMs: 15, dnsFetch: hangingFetch }).fetch({ url: 'https://example.com/' }), { code: 'WEB_FETCH_TIMEOUT' })
  } finally { clearTimeout(keepAlive) }
})

test('caller cancellation remains WEB_ABORTED during DoH', async () => {
  const controller = new AbortController()
  const result = provider({ dnsFetch: hangingFetch }).fetch({ url: 'https://example.com/' }, controller.signal)
  setImmediate(() => controller.abort())
  await assert.rejects(result, { code: 'WEB_ABORTED' })
})

test('Cordis loads the plugin with defaults and registers the original http provider id', async () => {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, { fetchProvider: 'http' })
  await ctx.plugin(plugin)
  try {
    await assert.rejects(ctx.web.fetch({ url: 'http://127.0.0.1/' }), { code: 'WEB_BLOCKED_URL' })
  } finally { await ctx.fiber.dispose() }
})

test('bundle patch replaces the built-in row instead of creating a duplicate provider', async () => {
  const patch = parse(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
  const warnings = []
  const rows = applyEntryPatches([{ id: 'web-fetch-http', name: '@deepseek-ai/dsh-web-fetch-http' }], patch, (...args) => warnings.push(args))
  assert.equal(warnings.length, 0)
  assert.equal(rows.length, 2)
  assert.equal(rows.find(row => row.id === 'web-fetch-http').disabled, true)
  const active = rows.filter(row => !row.disabled)
  assert.equal(active.length, 1)
  assert.equal(active[0].id, 'web-fetch-fakeip')
  assert.equal(active[0].name, 'dsh-web-fetch-fakeip/runtime')
  assert.equal(active[0].config.dohUrl, 'https://dns.alidns.com/resolve')
})
