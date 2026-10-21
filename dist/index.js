import z from '@deepseek-ai/schemastery';
import { DEFAULT_USER_AGENT } from '@deepseek-ai/dsh-web-fetch-http';
import { HttpFetchProvider } from './vendor/provider.js';
import { DEFAULT_PDF_OPTIONS, validatePdfOptions } from './pdf.js';
import { createFakeIpResolver, DEFAULT_DOH_URL, DEFAULT_FAKE_IP_RANGES } from './resolver.js';
export { createFakeIpResolver, DEFAULT_DOH_URL, DEFAULT_FAKE_IP_RANGES, isFakeIp } from './resolver.js';
export { HttpFetchProvider } from './vendor/provider.js';
export const name = 'web-fetch-fakeip';
export const inject = ['web'];
export const Config = z.object({
    dohUrl: z.string().default(DEFAULT_DOH_URL),
    dnsTimeoutMs: z.number().default(8_000),
    fakeIpRanges: z.array(z.string()).default([...DEFAULT_FAKE_IP_RANGES]),
    maxResponseBytes: z.number().default(5_000_000),
    maxBodyChars: z.number().default(100_000),
    timeoutMs: z.number().default(30_000),
    maxRedirects: z.number().default(5),
    userAgent: z.string().default(DEFAULT_USER_AGENT),
    pdfCommand: z.string().default(DEFAULT_PDF_OPTIONS.pdfCommand),
    pdfTimeoutMs: z.number().default(DEFAULT_PDF_OPTIONS.pdfTimeoutMs),
    maxPdfPages: z.number().default(DEFAULT_PDF_OPTIONS.maxPdfPages),
    maxPdfBytes: z.number().default(DEFAULT_PDF_OPTIONS.maxPdfBytes),
});
export function apply(ctx, config) {
    for (const field of ['maxResponseBytes', 'maxBodyChars', 'timeoutMs']) {
        if (!Number.isFinite(config[field]) || config[field] <= 0) {
            throw new Error(`web-fetch-fakeip: ${field} must be a positive finite number`);
        }
    }
    if (config.timeoutMs > 2_147_483_647)
        throw new Error('web-fetch-fakeip: timeoutMs exceeds the Node timer limit');
    if (!Number.isInteger(config.maxRedirects) || config.maxRedirects < 0) {
        throw new Error('web-fetch-fakeip: maxRedirects must be a non-negative integer');
    }
    validatePdfOptions(config);
    ctx.web.registerFetchProvider(new HttpFetchProvider(config, createFakeIpResolver(config), config));
}
