import crypto from 'node:crypto'
import {
  API_URL,
  AUTH_URL,
  CLIENT_ID,
  CLIENT_SECRET,
  HttpError,
  REDIRECT_URI,
  SCOPES,
  TOKEN_URL,
  withCause,
} from './config.js'

/* ------------------------------------------------------------- oauth flow */

// The verifier is the secret. Its SHA-256 digest is the challenge, and only the
// challenge is ever sent to Buffer — the verifier stays on this server until
// the token exchange, which is what makes a stolen authorization code useless.
export function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

// Random value echoed back by Buffer on the callback. If it doesn't match what
// we handed out, the callback didn't come from a flow we started.
export function createState() {
  return crypto.randomBytes(16).toString('base64url')
}

export function buildAuthorizeUrl({ state, codeChallenge }) {
  const url = new URL(AUTH_URL)
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',          // selects the Authorization Code flow
    scope: SCOPES,                  // space-separated
    state,
    code_challenge: codeChallenge,  // the hash — never the verifier
    code_challenge_method: 'S256',  // tells Buffer the challenge is a SHA-256 hash
    prompt: 'consent',
  }).toString()
  return url.toString()
}

// What the token endpoint's error codes usually mean in practice. Naming the
// likely cause saves the reader a trip through the OAuth spec.
const TOKEN_ERROR_HINTS = {
  invalid_client: 'set BUFFER_CLIENT_SECRET for a confidential client, or omit it entirely for a public one',
  invalid_grant: 'the code was already used or has expired, or redirect_uri differs from the authorize request',
  invalid_scope: 'a requested scope is not enabled on this app client',
  unsupported_grant_type: 'this client is not allowed to use that grant type',
}

// The authorization server advertises only "none" and "client_secret_post", so
// the secret always goes in the form body — never HTTP Basic.
export async function requestTokens(params, previous = null) {
  const body = new URLSearchParams({ client_id: CLIENT_ID, ...params })
  if (CLIENT_SECRET) body.set('client_secret', CLIENT_SECRET)

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const json = await res.json().catch(() => ({}))

  if (!res.ok || json.error) {
    const detail = json.error_description || json.error || `HTTP ${res.status}`
    const hint = TOKEN_ERROR_HINTS[json.error]
    const error = new Error(hint ? `${detail} — ${hint}` : detail)
    error.oauthError = json.error
    throw error
  }

  return {
    accessToken: json.access_token,
    // Buffer replaces a refresh token when it is used. Never retain the old
    // value after a successful refresh.
    refreshToken: json.refresh_token || null,
    scope: json.scope || previous?.scope,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 - 30_000,
    connectedAt: previous?.connectedAt || Date.now(),
  }
}

// Trade the one-time code for tokens. This is where the code_verifier is
// finally revealed: Buffer re-hashes it, compares it to the challenge from the
// authorize step, and only trusts us if they match.
export async function exchangeCodeForTokens({ code, codeVerifier }) {
  const tokens = await requestTokens({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,   // must byte-match the authorize request
    code_verifier: codeVerifier,
  })
  if (!tokens.refreshToken) throw new Error('Buffer did not return a refresh token; enable offline_access for this app client')
  return tokens
}

export async function refreshTokens(previous) {
  const replacement = await requestTokens({
    grant_type: 'refresh_token',
    refresh_token: previous.refreshToken,
  }, previous)

  // A replacement is required for a rotating-token flow. Continuing with the
  // old token would make a later failure hard to diagnose and unsafe to retry.
  if (!replacement.refreshToken) throw new Error('Buffer did not return a replacement refresh token')
  return replacement
}

// The gate every API call passes through. It saves a rotated token pair before
// returning, so the next request uses Buffer's replacement refresh token.
async function accessToken(ctx) {
  const tokens = ctx.session.tokens
  if (!tokens) throw new HttpError(401, 'Not connected to Buffer')
  if (Date.now() < tokens.expiresAt) return tokens.accessToken

  if (!tokens.refreshToken) {
    ctx.session.tokens = null
    await ctx.session.save()
    throw new HttpError(401, 'Your Buffer session expired. Connect again to continue.')
  }

  try {
    ctx.session.tokens = await refreshTokens(tokens)
    await ctx.session.save()
    return ctx.session.tokens.accessToken
  } catch (err) {
    console.warn(JSON.stringify({ event: 'buffer_token_refresh_failed', code: err.oauthError }))
    ctx.session.tokens = null
    await ctx.session.save()
    throw new HttpError(401, 'Your Buffer session expired. Connect again to continue.')
  }
}

/* --------------------------------------------------------------- graphql */
// Everything the app reads or writes goes through one GraphQL endpoint at
// https://api.buffer.com, with the access token in an Authorization header.

// Rate limits are per client, so every user of this app shares one quota. A
// well-behaved client reads Retry-After and backs off rather than hammering.
const MAX_BACKOFF_SECONDS = 5

export async function graphql(ctx, query, variables, { backedOff = false } = {}) {
  const token = await accessToken(ctx)
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const json = await res.json().catch(() => null)
  // Surface the remaining quota so the browser can pace a long history scan.
  ctx.rateLimit = res.headers.get('RateLimit') || ctx.rateLimit || null

  if (res.status === 401) {
    ctx.session.tokens = null
    await ctx.session.save()
    throw new HttpError(401, 'Buffer rejected the access token — reconnect')
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After')) || 0
    // Wait out a short reset once. A long one is not worth holding a request
    // open for — serverless functions bill wall-clock time and time out — so
    // it is reported instead, with the wait the API asked for.
    if (!backedOff && retryAfter > 0 && retryAfter <= MAX_BACKOFF_SECONDS) {
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000))
      return graphql(ctx, query, variables, { backedOff: true })
    }
    const error = new HttpError(429, `Buffer API rate limit reached${retryAfter ? ` — try again in ${retryAfter}s` : ''}`)
    error.retryAfter = retryAfter
    throw error
  }

  // A GraphQL request that fails still comes back as HTTP 200. The real status
  // is in the `errors` array, under extensions.code.
  if (!res.ok || json?.errors?.length) {
    const failure = json?.errors?.[0]
    const code = failure?.extensions?.code
    console.error(JSON.stringify({ event: 'buffer_api_error', status: res.status, code, message: failure?.message }))
    throw new HttpError(502, withCause(
      'Buffer could not complete the request. Please try again.',
      [code, failure?.message].filter(Boolean).join(': ') || `HTTP ${res.status}`,
    ))
  }
  return json.data
}

export const ACCOUNT_QUERY = `
  query Account {
    account {
      id
      email
      name
      organizations { id name }
    }
  }
`

// A "channel" is any social account connected to Buffer — a LinkedIn profile,
// an Instagram account, and so on. We scope the query to one organization.
export const CHANNELS_QUERY = `
  query Channels($organizationId: OrganizationId!) {
    channels(input: { organizationId: $organizationId }) {
      id
      name
      displayName
      service
      avatar
      isDisconnected
      isQueuePaused
    }
  }
`

/* ------------------------------------------------------- creating posts */
// Each article becomes one post per selected channel. Rather than one request
// per channel, every createPost goes into a single GraphQL document under its
// own alias (p0, p1, ...), so sending to six channels costs one request of the
// shared rate limit instead of six.
//
// createPost returns a UNION: PostActionSuccess or a typed error. Every error
// type implements MutationError, so `... on MutationError` catches them all and
// a rejected post comes back as data we can show next to that channel.

// Networks that need extra metadata for a valid post. Every other network
// accepts plain text.
const REQUIRED_METADATA = {
  instagram: { type: 'post', shouldShareToFeed: true },
  facebook: { type: 'post' },
}

export function buildPostInput({ channelId, service, text, imageUrl = null, when = 'queue' }) {
  const input = {
    channelId,
    text,
    // `assets` and `needsApproval` are non-null in the schema even when empty.
    assets: imageUrl ? [{ image: { url: imageUrl } }] : [],
    needsApproval: false,
    schedulingType: 'automatic',
    mode: 'addToQueue',
  }
  if (when === 'draft') input.saveToDraft = true
  if (REQUIRED_METADATA[service]) input.metadata = { [service]: { ...REQUIRED_METADATA[service] } }
  return input
}

export function buildCreatePostsMutation(count) {
  const defs = [], fields = []
  for (let i = 0; i < count; i++) {
    defs.push(`$p${i}: CreatePostInput!`)
    fields.push(`  p${i}: createPost(input: $p${i}) {
    ... on PostActionSuccess { post { id status dueAt channelId } }
    ... on MutationError { message }
  }`)
  }
  return `mutation CreatePosts(${defs.join(', ')}) {\n${fields.join('\n')}\n}`
}

export function readAliased(data, prefix, count) {
  const out = []
  for (let i = 0; i < count; i++) out.push(data?.[`${prefix}${i}`] ?? null)
  return out
}

/* ------------------------------------------------------- creating ideas */
// Ideas belong to the organization, not a channel, and carry the networks they
// are meant for in `services`. The documented examples write the input inline,
// so ideas are serialized to GraphQL literals instead of typed variables: this
// keeps the request independent of the input type's schema name.

export class GqlEnum {
  constructor(value) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid enum value ${value}`)
    this.value = value
  }
}

// JS value → GraphQL input literal. Strings go through JSON.stringify, whose
// escaping is valid GraphQL string syntax.
export function gqlLiteral(value) {
  if (value instanceof GqlEnum) return value.value
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(gqlLiteral).join(', ')}]`
  if (typeof value === 'object') {
    const parts = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Invalid field name ${k}`)
        return `${k}: ${gqlLiteral(v)}`
      })
    return `{ ${parts.join(', ')} }`
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(String(value))
}

export function buildIdeaInput({ organizationId, title, text, services = [], imageUrl = null }) {
  const content = { title, text }
  if (services.length) content.services = services.map((s) => new GqlEnum(s))
  if (imageUrl) content.media = [{ url: imageUrl, type: new GqlEnum('image') }]
  return { organizationId, content }
}

export function buildCreateIdeasMutation(inputs) {
  const fields = inputs.map((input, i) => `  i${i}: createIdea(input: ${gqlLiteral(input)}) {
    ... on Idea { id content { title } }
    ... on MutationError { message }
  }`)
  return `mutation CreateIdeas {\n${fields.join('\n')}\n}`
}
