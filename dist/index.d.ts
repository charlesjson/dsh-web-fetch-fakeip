import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { HttpFetchLimits } from './vendor/provider.js';
import type { PdfOptions } from './pdf.js';
export { createFakeIpResolver, DEFAULT_DOH_URL, DEFAULT_FAKE_IP_RANGES, isFakeIp } from './resolver.js';
export { HttpFetchProvider } from './vendor/provider.js';
export declare const name = "web-fetch-fakeip";
export declare const inject: string[];
export interface Config extends HttpFetchLimits, PdfOptions {
    dohUrl: string;
    dnsTimeoutMs: number;
    fakeIpRanges: string[];
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
