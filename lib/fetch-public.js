// Fetches a URL a user typed in, on the server. That makes this server a proxy
// for whoever is using it, so before every hop (including each redirect) the
// host must resolve only to public addresses: no localhost, no private ranges,
// no cloud metadata endpoints. Responses are capped in size and time.
import dns from 'node:dns/promises'
import net from 'node:net'
import { HttpError } from './config.js'

const MAX_REDIRECTS = 5
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024

// Identify ourselves honestly; some publishers block blank user agents.
const USER_AGENT = 'Mozilla/5.0 (compatible; NewsfeedToPost/0.1; +https://newsfeed-to-post.vercel.app)'

export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  if (net.isIPv6(address)) {
    const v = address.toLowerCase()
    if (v === '::' || v === '::1') return true
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateAddress(mapped[1])
    return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') ||
      v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff')
  }
  return true
}

export function normalizeUserUrl(raw) {
  let value = String(raw || '').trim()
  if (!value) throw new HttpError(400, 'Enter a web address')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`
  let url
  try { url = new URL(value) } catch { throw new HttpError(400, 'That doesn\'t look like a web address') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'Only http and https addresses are supported')
  if (url.username || url.password) throw new HttpError(400, 'Addresses with a username or password are not supported')
  url.hash = ''
  return url
}

async function assertPublicHost(url, lookup) {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new HttpError(400, 'That address is not on the public internet')
  }
  let addresses
  if (net.isIP(host)) addresses = [host]
  else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address)
    } catch {
      throw new HttpError(400, `Couldn't find ${host}. Check the address.`)
    }
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new HttpError(400, 'That address is not on the public internet')
  }
}

// Returns { url (final, after redirects), status, contentType, text }.
export async function fetchPublic(input, {
  accept = '*/*',
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  lookup = dns.lookup,
  fetchImpl = fetch,
  headers = {},
} = {}) {
  let url = input instanceof URL ? input : normalizeUserUrl(input)
  const deadline = AbortSignal.timeout(timeoutMs)

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url, lookup)
    let res
    try {
      res = await fetchImpl(url, {
        redirect: 'manual',
        signal: deadline,
        headers: { 'User-Agent': USER_AGENT, Accept: accept, ...headers },
      })
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new HttpError(504, `${url.hostname} took too long to respond`)
      }
      throw new HttpError(502, `Couldn't reach ${url.hostname}`)
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url)
      if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'The site redirected somewhere unsupported')
      continue
    }
    if (!res.ok) {
      throw new HttpError(502, `${url.hostname} answered with HTTP ${res.status}`)
    }

    const declared = Number(res.headers.get('content-length') || 0)
    if (declared > maxBytes) throw new HttpError(413, 'That page is too large to read')

    // Read incrementally so an endless or huge body is cut off at the cap.
    const reader = res.body?.getReader()
    const chunks = []
    let size = 0
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) {
          await reader.cancel().catch(() => {})
          throw new HttpError(413, 'That page is too large to read')
        }
        chunks.push(value)
      }
    }
    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)))
    return {
      url: url.toString(),
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      text: buffer.toString('utf8'),
    }
  }
  throw new HttpError(502, 'Too many redirects')
}
