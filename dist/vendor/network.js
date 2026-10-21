import { isIP } from 'node:net';
import { isPublicIpAddress, resolvePublicAddresses } from './address-policy.js';
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
export function isNonPublicIpLiteral(hostname) {
    const unbracketed = stripIpv6Brackets(hostname);
    return isIP(unbracketed) !== 0 && !isPublicIpAddress(unbracketed);
}
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
export async function requestPinned(url, addresses, headers, signal) {
    // Keep the Node-only transport out of browser-worker startup. The preview can load the provider
    // and fail loud at its DNS stub without evaluating Undici; a real request resolves it here.
    const { Agent, fetch } = await import('undici');
    // Reached only where `proxyRouteFor` reported no proxy for this URL, and the pinned lookup this
    // agent carries is per-request state the process-wide dispatcher cannot hold.
    // proxy-exempt: pinning one request's validated addresses, on a URL the policy routes directly.
    const dispatcher = new Agent({ autoSelectFamily: true, connect: { lookup: createPinnedLookup(addresses) } });
    try {
        // proxy-exempt: the agent above, whose lifetime is this one request.
        const response = await fetch(url, { method: 'GET', redirect: 'manual', headers, signal, dispatcher });
        return { response, close: async () => { await dispatcher.close(); } };
    }
    catch (error) {
        await dispatcher.close();
        throw error;
    }
}
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
export async function requestVia(dispatcher, url, headers, signal) {
    const { fetch } = await import('undici');
    // proxy-exempt: the dispatcher is the installed policy's own, handed over by `proxyRouteFor`.
    const response = await fetch(url, { method: 'GET', redirect: 'manual', headers, signal, dispatcher });
    return { response, close: () => Promise.resolve() };
}
/** Production network operations kept as an object so provider tests can replace resolution only. */
export const publicHttpNetwork = {
    resolve: resolvePublicAddresses,
    request: requestPinned,
    requestVia,
};
/**
 * Build the connector lookup that serves a fixed validated answer set.
 *
 * @param addresses - public addresses retained from the preceding resolution.
 * @returns a Node-compatible lookup callback that performs no network resolution.
 */
export function createPinnedLookup(addresses) {
    return (hostname, options, callback) => {
        const family = typeof options.family === 'number'
            ? options.family
            : options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : 0;
        const eligible = family === 0 ? addresses : addresses.filter(address => address.family === family);
        const selected = eligible[0];
        if (selected === undefined) {
            const error = Object.assign(new Error(`no validated address for ${hostname} in family ${family}`), {
                code: 'ENOTFOUND',
                hostname,
            });
            callback(error, options.all === true ? [] : '', family);
            return;
        }
        if (options.all === true) {
            callback(null, eligible.map(address => ({ ...address })));
            return;
        }
        callback(null, selected.address, selected.family);
    };
}
function stripIpv6Brackets(hostname) {
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}
