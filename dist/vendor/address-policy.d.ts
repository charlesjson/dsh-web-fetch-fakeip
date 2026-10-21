import type { LookupAddress } from 'node:dns';
export interface PublicAddress {
    readonly address: string;
    readonly family: 4 | 6;
}
export type AddressResolver = (hostname: string, options: {
    all: true;
    order: 'verbatim';
}) => Promise<LookupAddress[]>;
/**
 * Return whether an address is globally reachable unicast. IPv4-mapped IPv6 is
 * classified by its embedded IPv4 address; transition and translation prefixes
 * remain blocked because their eventual IPv4 destination cannot be pinned here.
 *
 * @param input - textual IPv4 or IPv6 address.
 * @returns true only for a public unicast destination.
 */
export declare function isPublicIpAddress(input: string): boolean;
/**
 * Resolve a hostname once and reject the complete answer set if any destination
 * is not public. The returned addresses are the only ones the transport may use.
 *
 * @param hostname - URL hostname, including brackets when it is an IPv6 literal.
 * @param signal - aborts the wait for system resolution; an in-flight OS lookup may finish unused.
 * @param resolver - lookup implementation, overridden only by focused tests.
 * @returns the validated, non-empty address set.
 */
export declare function resolvePublicAddresses(hostname: string, signal: AbortSignal, resolver?: AddressResolver): Promise<PublicAddress[]>;
