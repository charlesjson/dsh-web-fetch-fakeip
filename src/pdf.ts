import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { WebError } from '@deepseek-ai/dsh-web'
import { timeoutOf } from '@deepseek-ai/dsh-timeout'

export interface PdfOptions {
  pdfCommand: string
  pdfTimeoutMs: number
  maxPdfPages: number
  maxPdfBytes: number
}
export const DEFAULT_PDF_OPTIONS: PdfOptions = { pdfCommand: 'pdftotext', pdfTimeoutMs: 15_000, maxPdfPages: 100, maxPdfBytes: 20_000_000 }
export interface PdfText { content: string; truncated: boolean }

export function validatePdfOptions(options: PdfOptions): void {
  if (typeof options.pdfCommand !== 'string' || !options.pdfCommand.trim() || options.pdfCommand.includes('\0')) throw new Error('web-fetch-fakeip: pdfCommand must name a pdftotext executable')
  for (const key of ['pdfTimeoutMs', 'maxPdfPages', 'maxPdfBytes'] as const) {
    if (!Number.isSafeInteger(options[key]) || options[key] <= 0) throw new Error(`web-fetch-fakeip: ${key} must be a positive integer`)
  }
  if (options.pdfTimeoutMs > 2_147_483_647 || options.maxPdfPages > 10_000 || options.maxPdfBytes > 100_000_000) throw new Error('web-fetch-fakeip: PDF limits exceed supported timer/page/byte bounds')
}

/** Decode already validated, completely downloaded PDF bytes in a cancellable local process. */
export async function extractPdfText(bytes: Uint8Array, maxChars: number, signal: AbortSignal, options: PdfOptions): Promise<PdfText> {
  validatePdfOptions(options)
  if (signal.aborted) throw aborted(signal)
  if (bytes.byteLength > options.maxPdfBytes) throw new WebError('PDF 超过下载大小限制', 'WEB_FETCH_TOO_LARGE')
  // Do not run the parser on an HTML login page or another file mislabelled as PDF.
  if (!Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-'))) throw new WebError('服务器返回的内容不是有效的 PDF 文件', 'WEB_PDF_INVALID')

  return await new Promise<PdfText>((resolve, reject) => {
    const child = spawn(options.pdfCommand, ['-f', '1', '-l', String(options.maxPdfPages + 1), '-enc', 'UTF-8', '-layout', '-', '-'], {
      shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    })
    const decoder = new StringDecoder('utf8')
    const rawLimit = Math.min(20_000_000, Math.max(16_384, maxChars * 2 + 4096))
    let raw = '', error = '', capped = false, timedOut = false, settled = false
    let force: ReturnType<typeof setTimeout> | undefined
    const kill = (kind: NodeJS.Signals) => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, kind); else child.kill(kind) } catch {}
    }
    const stop = () => { kill('SIGTERM'); force ??= setTimeout(() => kill('SIGKILL'), 1000) }
    const abort = () => stop()
    const timer = setTimeout(() => { timedOut = true; stop() }, options.pdfTimeoutMs)
    const cleanup = () => { clearTimeout(timer); clearTimeout(force); signal.removeEventListener('abort', abort) }
    const finish = (failure?: WebError) => {
      if (settled) return
      settled = true; cleanup()
      if (failure) { reject(failure); return }
      const pages = raw.split('\f')
      if (pages.at(-1)?.trim() === '') pages.pop()
      const text = pages.slice(0, options.maxPdfPages).map((page, index) => page.trim() ? `[第 ${index + 1} 页]\n${page.trim()}` : '').filter(Boolean).join('\n\n')
      if (!text) { reject(new WebError('PDF 中未提取到可读文字，可能是扫描件或图片 PDF，需要 OCR 识别', 'WEB_PDF_NO_TEXT')); return }
      const truncated = capped || pages.length > options.maxPdfPages || text.length > maxChars
      let content = text.slice(0, maxChars)
      if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1)
      resolve({ content, truncated })
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk: Buffer) => {
      if (capped) return
      const decoded = decoder.write(chunk), remaining = Math.max(0, rawLimit - raw.length)
      raw += decoded.slice(0, remaining)
      const pages = raw.split('\f')
      if (decoded.length > remaining || pages.length > options.maxPdfPages + 1 || (pages.length === options.maxPdfPages + 1 && pages.at(-1)?.trim())) { capped = true; stop() }
    })
    child.stderr.on('data', (chunk: Buffer) => { if (error.length < 8192) error += chunk.toString('utf8').slice(0, 8192 - error.length) })
    child.once('error', failure => finish(new WebError(
      'code' in failure && failure.code === 'ENOENT' ? '未找到 pdftotext。请安装 Poppler，或在插件中配置 pdfCommand 的完整路径。' : '无法启动 PDF 文本提取程序',
      'WEB_PDF_EXTRACTOR_UNAVAILABLE', { cause: failure },
    )))
    child.once('close', code => {
      if (settled) return
      raw += decoder.end()
      if (signal.aborted) { finish(aborted(signal)); return }
      if (timedOut) { finish(new WebError('PDF 文本提取超时，请使用更小的 PDF 或调整提取时限', 'WEB_FETCH_TIMEOUT')); return }
      if (code !== 0 && !capped) {
        if (code === 3 || /password|encrypted|copying.*not allowed/i.test(error)) finish(new WebError('PDF 已加密、需要密码或不允许提取文字', 'WEB_PDF_ENCRYPTED'))
        else finish(new WebError('PDF 无法解析，文件可能已损坏或不完整', 'WEB_PDF_INVALID'))
        return
      }
      finish()
    })
    child.stdin.end(bytes)
  })
}

function aborted(signal: AbortSignal): WebError {
  return timeoutOf(signal, 'WEB_FETCH_TIMEOUT') ? new WebError('网页获取超时', 'WEB_FETCH_TIMEOUT') : new WebError('网页获取已取消', 'WEB_ABORTED')
}
