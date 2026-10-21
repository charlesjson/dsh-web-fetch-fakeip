import { lookup } from 'node:dns/promises'
import { HttpFetchProvider } from '../dist/vendor/provider.js'
import { createFakeIpResolver, DEFAULT_DOH_URL } from '../dist/resolver.js'

const url = new URL(process.argv[2] ?? 'https://example.com/')
const limits = { maxResponseBytes: 5_000_000, maxBodyChars: 100_000, timeoutMs: 30_000, maxRedirects: 5, userAgent: 'dsh-web-fetch-fakeip/smoke' }
// Force only the selected target's system answer to fake-IP. DoH itself uses the
// real HTTPS transport, and the upstream provider makes the actual page request.
const resolver = createFakeIpResolver({ dohUrl: DEFAULT_DOH_URL, dnsTimeoutMs: 8000 }, {
  lookup: (hostname, options) => hostname === url.hostname
    ? Promise.resolve([{ address: '198.18.0.7', family: 4 }])
    : lookup(hostname, options),
})
const result = await new HttpFetchProvider(limits, resolver).fetch({ url: url.href })
console.log(JSON.stringify({ url: result.url, statusCode: result.statusCode, kind: result.body.kind, chars: result.body.content.length, truncated: result.truncated, pdfPages: (result.body.content.match(/\[第 \d+ 页\]/g) ?? []).length }, null, 2))
if (result.statusCode < 200 || result.statusCode >= 400 || result.body.content.length === 0) process.exitCode = 1
