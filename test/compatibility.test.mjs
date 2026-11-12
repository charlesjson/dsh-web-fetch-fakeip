import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'

test('DSH 0.2.2-rc.1 admits the shipped plugin without an exemption', async () => {
 const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'))
 assert.equal(evaluatePluginCompatibility(manifest,{},'0.2.2-rc.1'),undefined)
})
