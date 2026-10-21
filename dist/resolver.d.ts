import type { AddressResolver, PublicAddress } from './vendor/address-policy.js';
export declare const DEFAULT_DOH_URL = "https://dns.alidns.com/resolve";
export declare const DEFAULT_FAKE_IP_RANGES: readonly ["198.18.0.0/15", "fdfe:dcba:9876::/64"];
export interface ResolverOptions {
    dohUrl: string;
    dnsTimeoutMs: number;
    fakeIpRanges?: readonly string[];
}
/** Injection points keep tests off the system network; production uses these defaults. */
export interface ResolverDependencies {
    lookup?: AddressResolver;
    fetch?: typeof globalThis.fetch;
}
/** Only the explicitly configured proxy pools are eligible, never arbitrary private IPs. */
export declare function isFakeIp(address: string, ranges?: readonly string[]): boolean;
export declare function validateResolverOptions(options: ResolverOptions): void;
/** Feed the stock fetcher's injected resolver real, validated, pinnable addresses. */
export declare function createFakeIpResolver(options: ResolverOptions, dependencies?: ResolverDependencies): (hostname: string, signal: AbortSignal) => Promise<PublicAddress[]>;
