import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { WebError } from '@deepseek-ai/dsh-web';
import ipaddr from 'ipaddr.js';
import { isPublicIpAddress, resolvePublicAddresses } from './vendor/address-policy.js';
export const DEFAULT_DOH_URL = 'https://dns.alidns.com/resolve';
export const DEFAULT_FAKE_IP_RANGES = ['198.18.0.0/15', 'fdfe:dcba:9876::/64'];
const MAX_DOH_BYTES = 65_536;
/** Only the explicitly configured proxy pools are eligible, never arbitrary private IPs. */
export function isFakeIp(address, ranges = DEFAULT_FAKE_IP_RANGES) {
    return createFakeIpMatcher(ranges)(address);
}
function createFakeIpMatcher(ranges) {
    if (!Array.isArray(ranges) || ranges.length === 0)
        throw new Error('web-fetch-fakeip: fakeIpRanges must be a non-empty CIDR list');
    const parsedRanges = ranges.map(range => ipaddr.parseCIDR(range));
    return address => {
        if (!isIP(address))
            return false;
        const parsed = ipaddr.parse(address);
        return parsedRanges.some(([subnet, prefix]) => {
            if (parsed instanceof ipaddr.IPv4 && subnet instanceof ipaddr.IPv4)
                return parsed.match(subnet, prefix);
            if (parsed instanceof ipaddr.IPv6 && subnet instanceof ipaddr.IPv6)
                return parsed.match(subnet, prefix);
            return false;
        });
    };
}
export function validateResolverOptions(options) {
    createFakeIpMatcher(options.fakeIpRanges ?? DEFAULT_FAKE_IP_RANGES);
    const url = new URL(options.dohUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
        throw new Error('web-fetch-fakeip: dohUrl must be an HTTPS URL without credentials or a fragment');
    }
    if (!Number.isSafeInteger(options.dnsTimeoutMs) || options.dnsTimeoutMs <= 0 || options.dnsTimeoutMs > 2_147_483_647) {
        throw new Error('web-fetch-fakeip: dnsTimeoutMs must be a positive integer no greater than 2147483647');
    }
}
/** Feed the stock fetcher's injected resolver real, validated, pinnable addresses. */
export function createFakeIpResolver(options, dependencies = {}) {
    validateResolverOptions(options);
    const systemLookup = dependencies.lookup ?? lookup;
    const fetchDns = dependencies.fetch ?? globalThis.fetch;
    const isConfiguredFakeIp = createFakeIpMatcher(options.fakeIpRanges ?? DEFAULT_FAKE_IP_RANGES);
    return async (hostname, signal) => {
        const unbracketed = hostname.replace(/^\[|\]$/g, '');
        if (isIP(unbracketed))
            return resolvePublicAddresses(hostname, signal, systemLookup);
        // Keep the existing public/private result, including NAT64 checks, unless the
        // system answer actually contains a fake IP. Never use DoH to rescue a LAN name.
        const initial = await withAbort(systemLookup(unbracketed, { all: true, order: 'verbatim' }), signal);
        const hasFakeIp = initial.some(entry => isConfiguredFakeIp(entry.address));
        if (!hasFakeIp) {
            return resolvePublicAddresses(hostname, signal, (name, opts) => name === unbracketed ? Promise.resolve(initial) : systemLookup(name, opts));
        }
        for (const entry of initial) {
            if ((entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family) {
                throw new WebError(`hostname "${hostname}" resolved to an invalid IP address`, 'WEB_PROVIDER_ERROR');
            }
            if (!isConfiguredFakeIp(entry.address) && !isPublicIpAddress(entry.address)) {
                throw new WebError(`URL hostname "${hostname}" also resolves to a non-public IP address`, 'WEB_BLOCKED_URL');
            }
        }
        const controller = new AbortController();
        const dnsSignal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(options.dnsTimeoutMs)]);
        const dohLookup = async (name, opts) => {
            // Discover translation prefixes on the network that will carry the socket.
            // A public DoH resolver cannot see a local DNS64 gateway's custom prefix.
            if (name === 'ipv4only.arpa')
                return systemLookup(name, opts);
            const answers = await Promise.all([
                queryDoh(name, 1, options.dohUrl, dnsSignal, fetchDns),
                queryDoh(name, 28, options.dohUrl, dnsSignal, fetchDns),
            ]);
            return answers.flat();
        };
        try {
            // Use the same complete-answer-set and NAT64 policy as the built-in provider.
            // The built-in HttpFetchProvider pins these addresses without resolving again.
            return await resolvePublicAddresses(hostname, dnsSignal, dohLookup);
        }
        catch (error) {
            // Let the stock fetcher distinguish its overall deadline from caller
            // cancellation. Returning WEB_ABORTED here would hide WEB_FETCH_TIMEOUT.
            if (signal.aborted)
                throw abortError(signal);
            if (dnsSignal.aborted)
                throw new WebError('DNS-over-HTTPS resolution timed out', 'WEB_FETCH_TIMEOUT', { cause: error });
            if (error instanceof WebError)
                throw error;
            throw new WebError('DNS-over-HTTPS resolution failed', 'WEB_PROVIDER_ERROR', { cause: error });
        }
        finally {
            controller.abort();
        }
    };
}
async function queryDoh(hostname, type, endpoint, signal, fetchDns) {
    const url = new URL(endpoint);
    url.searchParams.set('name', hostname);
    url.searchParams.set('type', String(type));
    const response = await fetchDns(url, {
        method: 'GET', headers: { accept: 'application/dns-json' }, redirect: 'error', signal,
        credentials: 'omit',
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`DoH service returned HTTP ${response.status}`);
    }
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) > MAX_DOH_BYTES) {
        await response.body?.cancel();
        throw new Error('DoH response exceeds 65536 bytes');
    }
    if (!response.body)
        throw new Error('DoH service returned no body');
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done)
                break;
            total += chunk.value.byteLength;
            if (total > MAX_DOH_BYTES)
                throw new Error('DoH response exceeds 65536 bytes');
            chunks.push(chunk.value);
        }
    }
    finally {
        await reader.cancel();
        reader.releaseLock();
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isRecord(payload) || !Number.isInteger(payload.Status) || payload.TC === true) {
        throw new Error('DoH service returned an invalid or truncated DNS response');
    }
    // NXDOMAIN is a definitive empty answer. SERVFAIL and other failures must not
    // silently discard one family and hide a non-public address in the other.
    if (payload.Status === 3)
        return [];
    if (payload.Status !== 0)
        throw new Error(`DoH service returned DNS status ${String(payload.Status)}`);
    if (payload.Answer === undefined)
        return [];
    if (!Array.isArray(payload.Answer))
        throw new Error('DoH Answer must be an array');
    const addresses = [];
    for (const record of payload.Answer) {
        if (!isRecord(record))
            throw new Error('DoH service returned an invalid answer record');
        if (record.type !== type)
            continue; // CNAMEs carry no connection address.
        const family = type === 1 ? 4 : 6;
        if (typeof record.data !== 'string' || isIP(record.data) !== family) {
            throw new Error('DoH service returned an invalid address');
        }
        addresses.push({ address: record.data, family });
    }
    return addresses;
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function withAbort(promise, signal) {
    if (signal.aborted)
        return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
        const abort = () => reject(abortError(signal));
        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}
function abortError(signal) {
    return new Error('web fetch aborted during DNS resolution', { cause: signal.reason });
}
