import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../dist/index.js'

test('a missing host API is reported before any plugin effects are registered', async () => {
  const effects = []
  const ctx = { web: { registerFetchProvider: () => { effects.push('registered') } } }
  delete ctx.web.registerFetchProvider
  await assert.rejects(async () => apply(ctx, {}), error => {
    assert.equal(error.code, 'DSH_API_UNSUPPORTED')
    assert.deepEqual(error.missingMethods, ['web.registerFetchProvider'])
    assert.match(error.message, /dsh-web-fetch-fakeip/)
    return true
  })
  assert.deepEqual(effects, [])
})
