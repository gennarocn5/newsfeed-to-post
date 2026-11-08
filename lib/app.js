import express from 'express'
import path from 'node:path'
import {
  ANTHROPIC_API_KEY,
  DAILY_IDEA_LIMIT,
  HttpError,
  REDIRECT_URI,
  loginUnavailableReason,
  withCause,
} from './config.js'
import { readSession } from './session.js'
import {
  ACCOUNT_QUERY,
  CHANNELS_QUERY,
  buildAuthorizeUrl,
  buildCreateIdeasMutation,
  buildCreatePostsMutation,
  buildIdeaInput,
  buildPostInput,
  createPkcePair,
  createState,
  exchangeCodeForTokens,
  graphql,
  readAliased,
} from './buffer.js'
import { loadFeed } from './feed.js'
import { MAX_TEXT, loadArticle } from './article.js'
import { MAX_VOICE, generateIdeas } from './generate.js'
import { NETWORKS, countLength } from '../public/engine.js'

const app = express()
app.use(express.json({ limit: '300kb' }))

// Every route gets the session up front; routes that change it save explicitly.
app.use(async (req, res, next) => {
  try {
    req.session = await readSession(req, res)
    req.ctx = { req, res, session: req.session }
    next()
  } catch (err) {
    next(err)
  }
})

app.use(express.static(path.join(import.meta.dirname, '..', 'public'), { extensions: ['html'] }))

// Account data and authentication cookies must never be stored by a shared cache.
app.use(['/api', '/auth', '/callback'], (_req, res, next) => {
  res.set('Cache-Control', 'no-store, private')
  next()
})

// Lets a route throw HttpError and have it become a real response.
const wrap = (handler) => async (req, res, next) => {
  try {
    await handler(req, res)
  } catch (err) {
    if (err.status) {
      if (err.retryAfter) res.set('Retry-After', String(err.retryAfter))
      return res.status(err.status).json({ error: err.message, retryAfter: err.retryAfter || undefined })
    }
    next(err)
  }
}

// The server fetches pages and spends an AI key on the user's behalf, so those
// routes are for connected Buffer users only. This checks the session cookie
// without spending a Buffer API request.
function requireConnected(req) {
  if (!req.session.tokens) throw new HttpError(401, 'Connect your Buffer account first')
}

const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')
const ID_PATTERN = /^[a-f\d]{24}$/i

app.get('/auth/login', wrap(async (req, res) => {
  const unavailable = loginUnavailableReason(req.get('host'))
  if (unavailable) return res.redirect(`/?error=${encodeURIComponent(unavailable)}`)

  const { verifier, challenge } = createPkcePair()
  const state = createState()

  // Note the asymmetry: we keep the verifier and the state, and send out only
  // the challenge (the hash) and the state.
  req.session.pkce = { codeVerifier: verifier, state }
  await req.session.save()

  res.redirect(buildAuthorizeUrl({ state, codeChallenge: challenge }))
}))

app.get('/callback', wrap(async (req, res) => {
  const { code, state, error, error_description: description } = req.query
  const pkce = req.session.pkce
  req.session.pkce = null   // one-time values — discard either way

  if (error) {
    await req.session.save()
    return res.redirect(`/?error=${encodeURIComponent(description || error)}`)
  }
  // CSRF check: only a callback this app started carries the state we stored.
  // A missing session and a mismatched state have different causes, so they get
  // different messages.
  // Both cases send the user back to the start with a plain-language note; the
  // technical cause goes to the logs.
  if (!pkce || state !== pkce.state) {
    console.warn(JSON.stringify({ event: 'oauth_callback_rejected', reason: !pkce ? 'no_session' : 'state_mismatch' }))
    await req.session.save()
    return res.redirect(`/?error=${encodeURIComponent('Your Buffer sign-in timed out or was interrupted. Click Connect Buffer to try again.')}`)
  }

  let tokens
  try {
    // The code is short-lived, so exchange it immediately.
    tokens = await exchangeCodeForTokens({ code, codeVerifier: pkce.codeVerifier })
  } catch (err) {
    console.error(JSON.stringify({ event: 'oauth_token_exchange_failed', code: err.oauthError, message: err.message }))
    await req.session.save()
    const message = withCause('Buffer could not complete the connection. Check your client configuration.', err.message)
    return res.redirect(`/?error=${encodeURIComponent(message)}`)
  }

  try {
    req.session.tokens = tokens
    await req.session.save()
  } catch (err) {
    // Saving can fail because of the tokens themselves (a sealed cookie that is
    // too large, say), so drop them before saving the cleared session.
    req.session.tokens = null
    await req.session.save()
    throw err
  }
  res.redirect('/')
}))

app.post('/auth/logout', wrap(async (req, res) => {
  await req.session.destroy()
  res.json({ connected: false })
}))

app.get('/api/session', wrap(async (req, res) => {
  // redirectUri is echoed back for debugging: curl this endpoint to see the
  // exact callback the app will send.
  if (!req.session.tokens) return res.json({ connected: false, redirectUri: REDIRECT_URI })

  const data = await graphql(req.ctx, ACCOUNT_QUERY)
  res.json({
    connected: true,
    account: data.account,
    redirectUri: REDIRECT_URI,
    ai: Boolean(ANTHROPIC_API_KEY),
    ideasLeft: ideasLeft(req.session),
  })
}))

app.get('/api/channels', wrap(async (req, res) => {
  const organizationId = req.query.organizationId
  if (!organizationId) throw new HttpError(400, 'organizationId is required')

  const data = await graphql(req.ctx, CHANNELS_QUERY, { organizationId })
  res.json({ channels: data.channels.filter((c) => !c.isDisconnected) })
}))

/* ---------------------------------------------------------- the inbox */
// Load a feed (or find one from a homepage). Nothing is stored server-side:
// the browser keeps the user's feed list and what has been handled.
app.post('/api/feed', wrap(async (req, res) => {
  requireConnected(req)
  const url = str(req.body?.url, 2000)
  if (!url.trim()) throw new HttpError(400, 'Paste a feed or website address')
  const feed = await loadFeed(url)
  res.json({
    feed: { feedUrl: feed.feedUrl, title: feed.title, siteUrl: feed.siteUrl },
    // Full text stays out of the list; it is read when an article is opened.
    items: feed.items.map(({ contentText, ...item }) => ({ ...item, hasFullText: contentText.length > 1500 })),
  })
}))

// Open one article: meta tags plus the readable text the AI will work from.
app.post('/api/article', wrap(async (req, res) => {
  requireConnected(req)
  const url = str(req.body?.url, 2000)
  if (!url.trim()) throw new HttpError(400, 'An article address is required')
  const hints = req.body?.hints || {}
  const article = await loadArticle(url, {
    title: str(hints.title, 500),
    summary: str(hints.summary, 2000),
    image: /^https:\/\//.test(hints.image || '') ? str(hints.image, 2000) : null,
    author: str(hints.author, 200),
    published: str(hints.published, 50),
  })
  res.json({ article })
}))

/* ------------------------------------------------------------ AI ideas */
function today() { return new Date().toISOString().slice(0, 10) }

function ideasLeft(session) {
  const usage = session.ideaUsage
  const used = usage?.day === today() ? usage.count : 0
  return Math.max(0, DAILY_IDEA_LIMIT - used)
}

app.post('/api/ideas', wrap(async (req, res) => {
  requireConnected(req)
  if (ideasLeft(req.session) <= 0) {
    throw new HttpError(429, `You've used today's ${DAILY_IDEA_LIMIT} AI idea sets. They reset at midnight UTC.`)
  }
  const a = req.body?.article || {}
  const article = {
    url: /^https?:\/\//.test(a.url || '') ? str(a.url, 2000) : '',
    title: str(a.title, 500),
    dek: str(a.dek, 2000),
    siteName: str(a.siteName, 200),
    author: str(a.author, 200),
    published: str(a.published, 50),
    text: str(a.text, MAX_TEXT + 5000),
    previewOnly: Boolean(a.previewOnly),
  }
  if (!article.title) throw new HttpError(400, 'The article needs a headline')
  const services = Array.isArray(req.body?.services) ? req.body.services.filter((s) => NETWORKS[s]) : []
  if (!services.length) throw new HttpError(400, 'Pick at least one channel on a supported network')

  const angles = await generateIdeas({ article, services, voice: str(req.body?.voice, MAX_VOICE) })

  const usage = req.session.ideaUsage?.day === today() ? req.session.ideaUsage : { day: today(), count: 0 }
  req.session.ideaUsage = { day: usage.day, count: usage.count + 1 }
  await req.session.save()
  res.json({ angles, ideasLeft: ideasLeft(req.session) })
}))

/* ------------------------------------------------------- send to Buffer */
// One click sends the article post to each selected channel (queued or as
// drafts) and the chosen ideas to Buffer's Ideas board. Each part is a single
// aliased GraphQL request, so a full send costs three requests in total
// (channels lookup, posts, ideas) however many channels are involved.
const MAX_POSTS = 15
const MAX_IDEAS = 24

app.post('/api/send', wrap(async (req, res) => {
  const body = req.body || {}
  const organizationId = str(body.organizationId, 40)
  if (!ID_PATTERN.test(organizationId)) throw new HttpError(400, 'organizationId is required')
  const when = body.when === 'draft' ? 'draft' : 'queue'
  const imageUrl = /^https:\/\//i.test(body.article?.image || '') ? str(body.article.image, 2000) : null
  const attachImage = body.attachImage !== false

  const posts = (Array.isArray(body.posts) ? body.posts : []).slice(0, MAX_POSTS)
    .map((p) => ({ channelId: str(p?.channelId, 40), text: str(p?.text, 5000).trim() }))
  const ideas = (Array.isArray(body.ideas) ? body.ideas : []).slice(0, MAX_IDEAS)
    .map((i) => ({
      title: str(i?.title, 120).trim(),
      text: str(i?.text, 5000).trim(),
      services: (Array.isArray(i?.services) ? i.services : []).filter((s) => NETWORKS[s]).slice(0, 1),
    }))
    .filter((i) => i.text)
  if (!posts.length && !ideas.length) throw new HttpError(400, 'Nothing to send: pick a channel or an idea')

  const result = { posts: [], ideas: [] }

  if (posts.length) {
    // `service` decides required metadata, so it comes from Buffer, not the browser.
    const channels = (await graphql(req.ctx, CHANNELS_QUERY, { organizationId })).channels
    const ready = []
    for (const p of posts) {
      const channel = channels.find((c) => c.id === p.channelId && !c.isDisconnected)
      const net = NETWORKS[channel?.service]
      let problem = null
      if (!channel) problem = 'That channel is not connected in this organization'
      else if (!net) problem = `${channel.service} isn't supported yet`
      else if (!p.text) problem = 'The post is empty'
      else if (countLength(p.text, channel.service) > net.limit) problem = `Too long for ${net.name} (${countLength(p.text, channel.service)}/${net.limit})`
      else if (net.image && !imageUrl) problem = `${net.name} needs an image and this article has none`
      if (problem) result.posts.push({ channelId: p.channelId, ok: false, message: problem })
      else ready.push({ ...p, service: channel.service, net })
    }

    if (ready.length) {
      const variables = {}
      ready.forEach((p, i) => {
        variables[`p${i}`] = buildPostInput({
          channelId: p.channelId,
          service: p.service,
          text: p.text,
          imageUrl: imageUrl && (attachImage || p.net.image) ? imageUrl : null,
          when,
        })
      })
      try {
        const data = await graphql(req.ctx, buildCreatePostsMutation(ready.length), variables)
        readAliased(data, 'p', ready.length).forEach((r, i) => {
          if (r?.post) result.posts.push({ channelId: ready[i].channelId, ok: true, id: r.post.id, status: r.post.status, dueAt: r.post.dueAt })
          else result.posts.push({ channelId: ready[i].channelId, ok: false, message: r?.message || 'Buffer did not accept this post' })
        })
      } catch (err) {
        if (err.status === 401 || err.status === 429) throw err
        for (const p of ready) result.posts.push({ channelId: p.channelId, ok: false, message: err.message })
      }
    }
  }

  if (ideas.length) {
    const inputs = ideas.map((i) => buildIdeaInput({
      organizationId,
      title: i.title,
      text: i.text,
      services: i.services,
      imageUrl: attachImage || i.services.some((s) => NETWORKS[s].image) ? imageUrl : null,
    }))
    try {
      const data = await graphql(req.ctx, buildCreateIdeasMutation(inputs))
      readAliased(data, 'i', inputs.length).forEach((r, n) => {
        if (r?.id) result.ideas.push({ title: ideas[n].title, ok: true, id: r.id })
        else result.ideas.push({ title: ideas[n].title, ok: false, message: r?.message || 'Buffer did not accept this idea' })
      })
    } catch (err) {
      if (err.status === 401) throw err
      for (const i of ideas) result.ideas.push({ title: i.title, ok: false, message: err.message })
    }
  }

  res.json({ ...result, rateLimit: req.ctx.rateLimit || null })
}))

// Misconfiguration (a missing SESSION_SECRET, for instance) should read as a
// clear message instead of an opaque platform 500.
app.use((err, _req, res, next) => {
  // Too late for a clean response; let Express close the connection.
  if (res.headersSent) return next(err)
  console.error(JSON.stringify({ event: 'unhandled_request_error', name: err.name, message: err.message }))
  res.status(500).json({ error: withCause('Something went wrong. Please try again.', err.message) })
})

export default app
