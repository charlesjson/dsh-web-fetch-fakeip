import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractPdfText, DEFAULT_PDF_OPTIONS, validatePdfOptions } from '../dist/pdf.js'
import { makePdf } from './pdf-fixture.mjs'
const signal = () => new AbortController().signal

async function fakeCommand(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pdf-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'pdftotext-test')
  await writeFile(path, '#!' + process.execPath + '\n' + source)
  await chmod(path, 0o700)
  return path
}

test('real pdftotext extracts a complete two-page PDF with page labels', async () => {
  const value = await extractPdfText(makePdf(['First page text', 'Second page text']), 10000, signal(), DEFAULT_PDF_OPTIONS)
  assert.match(value.content, /\[第 1 页\]\nFirst page text/)
  assert.match(value.content, /\[第 2 页\]\nSecond page text/)
  assert.equal(value.truncated, false)
})

test('bounds extracted pages and marks partial text explicitly', async () => {
  const value = await extractPdfText(makePdf(['First', 'Second', 'Third']), 10000, signal(), { ...DEFAULT_PDF_OPTIONS, maxPdfPages: 2 })
  assert.ok(value.content.includes('Second')); assert.ok(!value.content.includes('Third')); assert.equal(value.truncated, true)
})

test('bounds returned characters', async () => {
  const value = await extractPdfText(makePdf(['A longer line of PDF text']), 16, signal(), DEFAULT_PDF_OPTIONS)
  assert.equal(value.content.length, 16); assert.equal(value.truncated, true)
})

test('image-only or blank PDF gives an OCR-specific explanation', async () => {
  await assert.rejects(extractPdfText(makePdf([null]), 10000, signal(), DEFAULT_PDF_OPTIONS), error => error.code === 'WEB_PDF_NO_TEXT' && error.message.includes('OCR'))
})

test('rejects invalid bytes and reports damaged PDFs', async () => {
  await assert.rejects(extractPdfText(Buffer.from('<html>login</html>'), 10000, signal(), DEFAULT_PDF_OPTIONS), { code: 'WEB_PDF_INVALID' })
  await assert.rejects(extractPdfText(Buffer.from('%PDF-1.4\nbroken'), 10000, signal(), DEFAULT_PDF_OPTIONS), { code: 'WEB_PDF_INVALID' })
})

test('missing local converter explains how to configure the dependency', async () => {
  await assert.rejects(extractPdfText(makePdf(), 10000, signal(), { ...DEFAULT_PDF_OPTIONS, pdfCommand: '/does/not/exist/pdftotext' }), { code: 'WEB_PDF_EXTRACTOR_UNAVAILABLE' })
})

test('an encrypted PDF produces the password error', async t => {
  const pdfCommand = await fakeCommand(t, 'process.stdin.resume();process.stdin.on("end",()=>{process.stderr.write("Incorrect password");process.exit(3)})')
  await assert.rejects(extractPdfText(makePdf(), 10000, signal(), { ...DEFAULT_PDF_OPTIONS, pdfCommand }), { code: 'WEB_PDF_ENCRYPTED' })
})

test('PDF extraction deadline stops a hanging local converter', async t => {
  const pdfCommand = await fakeCommand(t, 'process.stdin.resume();setInterval(()=>{},1000)')
  await assert.rejects(extractPdfText(makePdf(), 10000, signal(), { ...DEFAULT_PDF_OPTIONS, pdfCommand, pdfTimeoutMs: 30 }), { code: 'WEB_FETCH_TIMEOUT' })
})

test('cancellation terminates extraction and keeps the abort classification', async t => {
  const pdfCommand = await fakeCommand(t, 'process.stdin.resume();setInterval(()=>{},1000)')
  const controller = new AbortController()
  const result = extractPdfText(makePdf(), 10000, controller.signal, { ...DEFAULT_PDF_OPTIONS, pdfCommand })
  setTimeout(() => controller.abort(), 25)
  await assert.rejects(result, { code: 'WEB_ABORTED' })
})

test('large converter output is bounded even before extraction finishes', async t => {
  const pdfCommand = await fakeCommand(t, 'process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write("word ".repeat(100000));setInterval(()=>{},1000)})')
  const value = await extractPdfText(makePdf(), 100, signal(), { ...DEFAULT_PDF_OPTIONS, pdfCommand })
  assert.ok(value.content.length <= 100); assert.equal(value.truncated, true)
})

test('rejects invalid extraction settings', () => {
  for (const value of [{ maxPdfPages: 0 }, { maxPdfPages: 10001 }, { pdfTimeoutMs: -1 }, { maxPdfBytes: 0 }, { pdfCommand: '' }]) {
    assert.throws(() => validatePdfOptions({ ...DEFAULT_PDF_OPTIONS, ...value }))
  }
})
