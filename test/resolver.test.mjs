import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFakeIpResolver, DEFAULT_DOH_URL, isFakeIp } from '../dist/resolver.js'
import { resolvePublicAddresses } from '../dist/vendor/address-policy.js'

const options = { dohUrl: DEFAULT_DOH_URL, dnsTimeoutMs: 1000 }
const freshSignal = () => new AbortController().signal
const fake = [{ address: '198.18.0.7', family: 4 }]
const publicV4 = [{ address: '93.184.216.34', family: 4 }]

function fixture({ initial = fake, answers = { 1: ['93.184.216.34'], 28: [] }, status = {}, payload, networkPrefix = [], dnsFetch } = {}) {
  const lookups = []
  const requests = []
  const resolver = createFakeIpResolver(options, {
    lookup: async name => { lookups.push(name); return name === 'ipv4only.arpa' ? networkPrefix : initial },
    fetch: dnsFetch ?? (async (input, init) => {
      const url = new URL(input)
      requests.push({ url, init })
      const type = Number(url.searchParams.get('type'))
      const body = payload ?? { Status: status[type] ?? 0, Answer: answers[type].map(data => ({ type, data })) }
      return Response.json(body)
    }),
  })
  return { resolver, lookups, requests }
}

test('reproduces the original block and resolves the same hostname through DoH', async () => {
  await assert.rejects(resolvePublicAddresses('example.com', freshSignal(), async () => fake), { code: 'WEB_BLOCKED_URL' })
  const { resolver, lookups, requests } = fixture()
  assert.deepEqual(await resolver('example.com', freshSignal()), publicV4)
  assert.deepEqual(lookups, ['example.com'])
  assert.deepEqual(requests.map(r => r.url.searchParams.get('type')).sort(), ['1', '28'])
  for (const { url, init } of requests) {
    assert.equal(url.searchParams.get('name'), 'example.com')
    assert.equal(init.redirect, 'error')
    assert.equal(init.credentials, 'omit')
  }
})

test('only the configured Clash pool is recognized, never all 198.* addresses', () => {
  for (const ip of ['198.18.0.0', '198.19.255.255', 'fdfe:dcba:9876::5e']) assert.equal(isFakeIp(ip), true)
  for (const ip of ['198.17.255.255', '198.20.0.0', '192.168.1.1', '::ffff:198.18.0.7', '198.18.example.com']) assert.equal(isFakeIp(ip), false)
})

test('IPv6 fake-IP alone and mixed with IPv4 fake-IP both use DoH', async () => {
  for (const initial of [[{ address: 'fdfe:dcba:9876::5e', family: 6 }], [...fake, { address: 'fdfe:dcba:9876::5e', family: 6 }]]) {
    assert.deepEqual(await fixture({ initial }).resolver('example.com', freshSignal()), publicV4)
  }
})

test('only the configured IPv6 fake pool is eligible, other ULA answers stay blocked', async () => {
  assert.equal(isFakeIp('fdfe:dcba:9877::5e'), false)
  assert.equal(isFakeIp('fdfe:dcba:9876::5e', ['198.18.0.0/15']), false)
  await assert.rejects(fixture({ initial: [...fake, { address: 'fdfe:dcba:9877::5e', family: 6 }] }).resolver('example.com', freshSignal()), { code: 'WEB_BLOCKED_URL' })
})

test('fake-IP ranges must be valid non-empty CIDR lists', () => {
  for (const fakeIpRanges of [[], ['invalid'], ['198.18.0.0/99']]) {
    assert.throws(() => createFakeIpResolver({ ...options, fakeIpRanges }))
  }
})

test('public system DNS needs no DoH or second target lookup', async () => {
  const { resolver, lookups, requests } = fixture({ initial: publicV4 })
  assert.deepEqual(await resolver('example.com', freshSignal()), publicV4)
  assert.deepEqual(lookups, ['example.com'])
  assert.equal(requests.length, 0)
})

for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '64:ff9b::a00:1']) {
  test(`rejects a private or special literal ${address} without contacting DoH`, async () => {
    const { resolver, requests, lookups } = fixture()
    await assert.rejects(resolver(address.includes(':') ? `[${address}]` : address, freshSignal()), { code: 'WEB_BLOCKED_URL' })
    assert.equal(requests.length, 0)
    assert.equal(lookups.includes(address), false)
  })
}

test('a literal fake IP is blocked: only domain answers get fallback', async () => {
  await assert.rejects(fixture().resolver('198.18.0.7', freshSignal()), { code: 'WEB_BLOCKED_URL' })
})

for (const initial of [
  [{ address: '192.168.1.1', family: 4 }],
  [...fake, { address: '10.1.1.1', family: 4 }],
  [...fake, { address: '::1', family: 6 }],
]) {
  test(`refuses genuine private DNS answers, including mixtures ${initial.map(r => r.address)}`, async () => {
    const { resolver, requests } = fixture({ initial })
    await assert.rejects(resolver('example.com', freshSignal()), { code: 'WEB_BLOCKED_URL' })
    assert.equal(requests.length, 0)
  })
}

test('a public and fake-IP mixture uses only validated DoH results', async () => {
  const { resolver } = fixture({ initial: [...fake, ...publicV4] })
  assert.deepEqual(await resolver('example.com', freshSignal()), publicV4)
})

for (const answers of [
  { 1: ['198.18.0.3'], 28: [] },
  { 1: ['93.184.216.34', '192.168.1.1'], 28: [] },
  { 1: ['93.184.216.34'], 28: ['::1'] },
  { 1: ['93.184.216.34'], 28: ['::ffff:169.254.169.254'] },
]) {
  test(`rejects the whole DoH set if any returned address is non-public ${JSON.stringify(answers)}`, async () => {
    await assert.rejects(fixture({ answers }).resolver('example.com', freshSignal()), { code: 'WEB_BLOCKED_URL' })
  })
}

test('rejects an address translating to a private IPv4 through a locally discovered NAT64 prefix', async () => {
  const { resolver, lookups } = fixture({
    answers: { 1: [], 28: ['2001:db9:64::a00:1'] },
    networkPrefix: [{ address: '2001:db9:64::c000:aa', family: 6 }],
  })
  await assert.rejects(resolver('example.com', freshSignal()), { code: 'WEB_BLOCKED_URL' })
  assert.ok(lookups.includes('ipv4only.arpa'))
})

test('preserves NAT64 protection for ordinary system DNS', async () => {
  const { resolver, requests } = fixture({
    initial: [{ address: '2001:db9:64::a00:1', family: 6 }],
    networkPrefix: [{ address: '2001:db9:64::c000:aa', family: 6 }],
  })
  await assert.rejects(resolver('example.com', freshSignal()), { code: 'WEB_BLOCKED_URL' })
  assert.equal(requests.length, 0)
})

test('accepts public IPv6 while using the local resolver for DNS64 discovery', async () => {
  const { resolver, lookups } = fixture({ answers: { 1: [], 28: ['2606:4700:4700::1111'] } })
  assert.deepEqual(await resolver('example.com', freshSignal()), [{ address: '2606:4700:4700::1111', family: 6 }])
  assert.deepEqual(lookups, ['example.com', 'ipv4only.arpa'])
})

for (const config of [
  { answers: { 1: [], 28: [] } },
  { status: { 1: 3, 28: 3 } },
  { status: { 28: 2 } },
  { answers: { 1: ['not-an-ip'], 28: [] } },
  { payload: { Status: 0, TC: true, Answer: [] } },
  { payload: { Status: 0, Answer: 'invalid' } },
  { payload: { Answer: [] } },
]) {
  test(`fails closed on invalid or unsuccessful DNS data ${JSON.stringify(config)}`, async () => {
    await assert.rejects(fixture(config).resolver('example.com', freshSignal()), { code: 'WEB_PROVIDER_ERROR' })
  })
}

test('does not mistake CNAME records for addresses', async () => {
  const { resolver } = fixture({ payload: { Status: 0, Answer: [{ type: 5, data: '127.0.0.1.example.com.' }] } })
  await assert.rejects(resolver('example.com', freshSignal()), { code: 'WEB_PROVIDER_ERROR' })
})

test('limits both declared and streamed DoH response sizes', async () => {
  for (const headers of [{ 'content-length': '999999' }, {}]) {
    const { resolver } = fixture({ dnsFetch: async () => new Response(' '.repeat(70_000), { headers }) })
    await assert.rejects(resolver('example.com', freshSignal()), { code: 'WEB_PROVIDER_ERROR' })
  }
})

test('DoH HTTP failure never falls back to the fake address', async () => {
  const { resolver } = fixture({ dnsFetch: async () => new Response('no', { status: 503 }) })
  await assert.rejects(resolver('example.com', freshSignal()), { code: 'WEB_PROVIDER_ERROR' })
})

test('requires an HTTPS JSON DoH URL without credentials or fragments', () => {
  for (const dohUrl of ['http://example.com/resolve', 'https://a:b@example.com/resolve', 'https://example.com/resolve#x']) {
    assert.throws(() => createFakeIpResolver({ ...options, dohUrl }))
  }
  for (const dnsTimeoutMs of [0, -1, Infinity, 1.5, 2_147_483_648]) {
    assert.throws(() => createFakeIpResolver({ ...options, dnsTimeoutMs }))
  }
})

test('honors cancellation while waiting for system DNS', async () => {
  const controller = new AbortController()
  const resolver = createFakeIpResolver(options, { lookup: () => new Promise(() => {}) })
  const result = resolver('example.com', controller.signal)
  controller.abort()
  await assert.rejects(result, error => error.cause === controller.signal.reason)
})

const hangingFetch = async (_url, { signal }) => new Promise((_, reject) => {
  if (signal.aborted) reject(signal.reason)
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
})

test('honors cancellation during DoH', async () => {
  const controller = new AbortController()
  const { resolver } = fixture({ dnsFetch: hangingFetch })
  const result = resolver('example.com', controller.signal)
  setImmediate(() => controller.abort())
  await assert.rejects(result, error => error.cause === controller.signal.reason)
})

test('enforces a bounded DoH deadline', async () => {
  const resolver = createFakeIpResolver({ ...options, dnsTimeoutMs: 15 }, { lookup: async () => fake, fetch: hangingFetch })
  // AbortSignal.timeout uses an unref'ed timer, so keep this test alive until it fires.
  const keepAlive = setTimeout(() => {}, 1000)
  try { await assert.rejects(resolver('example.com', freshSignal()), { code: 'WEB_FETCH_TIMEOUT' }) }
  finally { clearTimeout(keepAlive) }
})
