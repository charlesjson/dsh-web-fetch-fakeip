import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

// DSH includes prereleases when matching ranges, including at the upper bound.
for (const version of ['0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.99', '0.2.2', '0.2.3-rc.1', '0.2.9']) {
  test(`DSH ${version} admits the plugin without an exemption`, () => {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined)
    const { engines, ...peersOnly } = manifest
    assert.equal(evaluatePluginCompatibility(peersOnly, {}, version), undefined)
  })
}

for (const version of ['0.2.2-alpha.1', '0.3.0-alpha.1', '0.3.0-rc.1', '0.3.0', '1.0.0']) {
  test(`DSH ${version} remains outside the compatibility range`, () => {
    const issue = evaluatePluginCompatibility(manifest, {}, version)
    assert.ok(issue)
    assert.equal(issue.exempted, false)
    const { engines, ...peersOnly } = manifest
    assert.ok(evaluatePluginCompatibility(peersOnly, {}, version))
  })
}

test('DSH peers use the same compatibility policy as engines.dsh', () => {
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(range, manifest.engines.dsh, name)
  }
})
