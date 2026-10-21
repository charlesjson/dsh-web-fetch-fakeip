/** Adapted from DeepSeek Harness dsh-v0.2.1-rc.2, MIT Copyright (c) 2026 DeepSeek.
 * Source commit: 687f282e8625c6b8d11ff58211a90524be2e4317. See THIRD_PARTY_NOTICES.md. */
import type { LookupAddress, LookupOptions } from 'node:dns';
import type { Dispatcher, Response } from 'undici';
import { resolvePublicAddresses } from './address-policy.js';
import type { PublicAddress } from './address-policy.js';
export type { PublicAddress } from './address-policy.js';
export interface PinnedResponse {
    readonly response: Response;
    close(): Promise<void>;
}
/**
 * Whether a hostname is an IP literal that {@link resolvePublicAddresses} would refuse.
 *
 * A proxied hop skips those checks because the proxy resolves the origin, but a literal needs no
 * resolution: the address is already stated, and handing it to a proxy running on this machine
 * would reach exactly the loopback or private service the checks exist to keep out of reach.
 *
 * @param hostname - a URL's hostname, bracketed or not.
 * @returns true when the host is a literal address no request may be sent to.
 */
export declare function isNonPublicIpLiteral(hostname: string): boolean;
/**
 * Fetch through an agent whose lookup callback returns only the already validated address set. The
 * URL hostname remains intact for HTTP Host and TLS SNI.
 *
 * The agent is this request's own because the address set is: pinning is how this package refuses a
 * DNS answer that changes between validation and connection, and it may not apply process-wide —
 * an operator-configured MCP server or model endpoint on loopback is a supported destination, and
 * only the URLs this tool fetches are the model's to choose.
 *
 * @param url - validated HTTP(S) URL the policy does not route through a proxy.
 * @param addresses - public addresses returned by {@link resolvePublicAddresses}.
 * @param headers - request headers.
 * @param signal - request and body-read cancellation signal.
 * @returns a response plus the disposer its consumer must call.
 */
export declare function requestPinned(url: URL, addresses: readonly PublicAddress[], headers: Record<string, string>, signal: AbortSignal): Promise<PinnedResponse>;
/**
 * Fetch through the dispatcher the proxy policy already installed, letting the proxy resolve the
 * origin.
 *
 * No address set is pinned because none exists to pin: the proxy performs the lookup, and a
 * connection pinned to a locally resolved address would reach the origin directly and defeat the
 * proxy. The dispatcher is the process-wide one, so hops share its connection pool and no caller
 * closes it.
 *
 * @param dispatcher - the route's dispatcher, from `proxyRouteFor`.
 * @param url - validated HTTP(S) URL the policy routes through a proxy.
 * @param headers - request headers.
 * @param signal - request and body-read cancellation signal.
 * @returns a response plus a disposer that releases nothing, so both paths close alike.
 */
export declare function requestVia(dispatcher: Dispatcher, url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<PinnedResponse>;
/** Production network operations kept as an object so provider tests can replace resolution only. */
export declare const publicHttpNetwork: {
    resolve: typeof resolvePublicAddresses;
    request: typeof requestPinned;
    requestVia: typeof requestVia;
};
type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
/**
 * Build the connector lookup that serves a fixed validated answer set.
 *
 * @param addresses - public addresses retained from the preceding resolution.
 * @returns a Node-compatible lookup callback that performs no network resolution.
 */
export declare function createPinnedLookup(addresses: readonly PublicAddress[]): (hostname: string, options: LookupOptions, callback: LookupCallback) => void;
