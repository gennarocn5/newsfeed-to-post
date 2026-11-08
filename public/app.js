import {
  NETWORKS, articleKey, buildArticlePost, countLength, isSupported, networkName, timeAgo, withLink,
} from './engine.js'

/* ------------------------------------------------------------------ utils */
const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmt = (n) => Number(n || 0).toLocaleString()
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return '' } }
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d } catch { return d } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* storage full or blocked: the app still works for this visit */ } },
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.body ? 'POST' : 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(json.error || `Request failed (${res.status})`)
    err.status = res.status
    if (res.status === 401 && S.account) setTimeout(() => location.reload(), 2500)
    throw err
  }
  return json
}

function flash(msg, ok = false) {
  const el = $('#flash')
  el.textContent = msg
  el.classList.toggle('ok', ok)
  el.hidden = !msg
  if (msg) clearTimeout(flash.t), (flash.t = setTimeout(() => { el.hidden = true }, ok ? 4000 : 10000))
}

// Grow a textarea to fit its text, so posts are never cut off mid-sentence.
function autosize(el) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight + 2}px`
}
const autosizeAll = (root) => $$('textarea', root).forEach(autosize)

/* ------------------------------------------------------------------ state */
const S = {
  account: null,
  orgId: null,
  channels: [],
  ai: false,
  ideasLeft: null,
  feeds: store.get('nftp:feeds', []),      // [{ url, title, siteUrl, voice, error }]
  items: store.get('nftp:items', {}),      // feedUrl → [item]
  handled: store.get('nftp:handled', {}),  // articleKey → { at, posts, ideas }
  filter: 'new',
  picked: new Set(),
  cur: null,                                // the open article and its drafts
  sending: false,
}
const saveFeeds = () => store.set('nftp:feeds', S.feeds)
const saveItems = () => store.set('nftp:items', S.items)
const saveHandled = () => store.set('nftp:handled', S.handled)
const pickKey = () => `nftp:picked:${S.orgId}`

const supportedChannels = () => S.channels.filter((c) => isSupported(c.service))
const pickedChannels = () => supportedChannels().filter((c) => S.picked.has(c.id))
const pickedServices = () => [...new Set(pickedChannels().map((c) => c.service))]

/* ------------------------------------------------------------------- boot */
async function boot() {
  const params = new URLSearchParams(location.search)
  if (params.get('error')) { flash(params.get('error')); history.replaceState(null, '', '/') }

  let session
  try { session = await api('/api/session') } catch (e) { session = { connected: false }; flash(e.message) }
  if (!session.connected) { $('#welcome').hidden = false; return }

  S.account = session.account
  S.ai = session.ai
  S.ideasLeft = session.ideasLeft
  const orgs = S.account.organizations || []
  $('#org').innerHTML = orgs.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')
  $('#org').closest('.org').hidden = orgs.length < 2
  $('#who').textContent = S.account.email || S.account.name || ''
  $('#account').hidden = false
  $('#app').hidden = false
  S.orgId = store.get('nftp:org', null)
  if (!orgs.some((o) => o.id === S.orgId)) S.orgId = orgs[0]?.id
  $('#org').value = S.orgId

  renderFeeds()
  renderItems()
  await loadOrg()
  if (S.feeds.length) refreshAll()
}

async function loadOrg() {
  store.set('nftp:org', S.orgId)
  try {
    S.channels = (await api(`/api/channels?organizationId=${encodeURIComponent(S.orgId)}`)).channels
  } catch (e) {
    S.channels = []
    flash(e.message)
  }
  const saved = store.get(pickKey(), null)
  const ids = saved || supportedChannels().map((c) => c.id)
  S.picked = new Set(ids.filter((id) => supportedChannels().some((c) => c.id === id)))
  if (S.cur) { resetPosts(); renderDesk() }
}

/* ------------------------------------------------------------------ feeds */
async function addFeed(input) {
  const value = input.trim()
  if (!value) return
  const btn = $('#add-feed button')
  btn.disabled = true; btn.textContent = 'Finding…'
  try {
    const { feed, items } = await api('/api/feed', { body: { url: value } })
    if (S.feeds.some((f) => f.url === feed.feedUrl)) {
      flash(`${feed.title} is already in your feeds.`)
    } else {
      S.feeds.push({ url: feed.feedUrl, title: feed.title, siteUrl: feed.siteUrl, voice: '' })
      flash(`Added ${feed.title}: ${items.length} recent ${items.length === 1 ? 'article' : 'articles'}.`, true)
    }
    S.items[feed.feedUrl] = items.map((it) => ({ ...it, feedUrl: feed.feedUrl }))
    saveFeeds(); saveItems()
    $('#feed-url').value = ''
    renderFeeds(); renderItems()
  } catch (e) {
    flash(e.message)
  } finally {
    btn.disabled = false; btn.textContent = 'Add'
  }
}

async function refreshFeed(feed) {
  try {
    const { feed: info, items } = await api('/api/feed', { body: { url: feed.url } })
    feed.title = info.title || feed.title
    feed.error = null
    S.items[feed.url] = items.map((it) => ({ ...it, feedUrl: feed.url }))
  } catch (e) {
    feed.error = e.message
  }
}

async function refreshAll() {
  const btn = $('#refresh')
  btn.disabled = true; btn.textContent = 'Checking…'
  await Promise.all(S.feeds.map(refreshFeed))
  saveFeeds(); saveItems()
  renderFeeds(); renderItems()
  btn.disabled = false; btn.textContent = 'Refresh'
}

function removeFeed(url) {
  S.feeds = S.feeds.filter((f) => f.url !== url)
  delete S.items[url]
  saveFeeds(); saveItems()
  renderFeeds(); renderItems()
}

function renderFeeds() {
  $('#try').hidden = S.feeds.length > 0
  $('#feed-list').innerHTML = S.feeds.map((f) => `
    <li class="feed${f.error ? ' bad' : ''}" data-url="${esc(f.url)}">
      <div class="feed-h">
        <span class="feed-name">${esc(f.title || host(f.url))}</span>
        <span class="feed-meta muted">${f.error ? esc(f.error) : `${(S.items[f.url] || []).length} recent · ${esc(host(f.url))}`}</span>
      </div>
      <details class="voice"${f.voice ? '' : ''}>
        <summary>Voice notes${f.voice ? ' ✓' : ''}</summary>
        <textarea rows="3" maxlength="1500" placeholder="How this publication sounds on social. e.g. No hashtags. Lead with the number. Call teams by their nickname.">${esc(f.voice || '')}</textarea>
      </details>
      <button class="link remove" type="button" title="Remove this feed">Remove</button>
    </li>`).join('')
}

/* ------------------------------------------------------------------ inbox */
function allItems() {
  const seen = new Set()
  const out = []
  for (const feed of S.feeds) {
    for (const it of S.items[feed.url] || []) {
      const key = articleKey(it.link)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ ...it, key, feedTitle: feed.title })
    }
  }
  return out.sort((a, b) => (Date.parse(b.published || 0) || 0) - (Date.parse(a.published || 0) || 0))
}

function renderItems() {
  const items = allItems()
  const fresh = items.filter((it) => !S.handled[it.key])
  $('#new-count').textContent = fresh.length || ''
  for (const b of $$('.seg button')) b.setAttribute('aria-pressed', String(b.dataset.filter === S.filter))
  const shown = S.filter === 'new' ? fresh : S.filter === 'done' ? items.filter((it) => S.handled[it.key]) : items

  if (!S.feeds.length) {
    $('#items').innerHTML = '<li class="none muted">Add a feed above and new articles show up here.</li>'
    return
  }
  if (!shown.length) {
    $('#items').innerHTML = `<li class="none muted">${S.filter === 'new' ? 'You\'re all caught up. New articles appear here when you refresh.' : 'Nothing here yet.'}</li>`
    return
  }
  const current = S.cur?.key
  $('#items').innerHTML = shown.map((it) => {
    const done = S.handled[it.key]
    return `<li><button type="button" class="item${it.key === current ? ' on' : ''}${done ? ' done' : ''}" data-key="${esc(it.key)}">
      ${it.image ? `<img src="${esc(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="noimg" aria-hidden="true"></span>'}
      <span class="item-t">
        <span class="item-meta">${esc(it.feedTitle || '')}${it.published ? ` · ${esc(timeAgo(it.published))}` : ''}${done ? ' · <b class="sent">Sent</b>' : ''}</span>
        <span class="item-h">${esc(it.title)}</span>
      </span>
    </button></li>`
  }).join('')
}

/* ---------------------------------------------------------------- the desk */
function feedFor(item) {
  return S.feeds.find((f) => f.url === item?.feedUrl) || null
}

async function openArticle(item) {
  const key = item.key || articleKey(item.link)
  S.cur = {
    key,
    item,
    article: null,
    loading: true,
    error: null,
    fullText: '',
    showPaste: false,
    posts: {},
    edited: new Set(),
    angles: null,
    include: new Set([0, 1, 2]),
    tab: {},
    writing: false,
    result: null,
  }
  renderItems()
  renderDesk()
  if (matchMedia('(max-width: 900px)').matches) $('#desk').scrollIntoView({ behavior: 'smooth', block: 'start' })

  try {
    const { article } = await api('/api/article', {
      body: { url: item.link, hints: { title: item.title, summary: item.summary, image: item.image, author: item.author, published: item.published } },
    })
    if (S.cur?.key !== key) return
    S.cur.article = article
  } catch (e) {
    if (S.cur?.key !== key) return
    // The page could not be read; fall back to what the feed told us.
    S.cur.error = e.message
    S.cur.article = {
      url: item.link, title: item.title || item.link, dek: item.summary || '', image: item.image || null,
      siteName: feedFor(item)?.title || host(item.link), author: item.author || '', published: item.published || null,
      text: item.summary || '', textSource: 'excerpt', previewOnly: true,
    }
  }
  S.cur.loading = false
  resetPosts()
  renderDesk()
}

function resetPosts() {
  const cur = S.cur
  if (!cur?.article) return
  for (const c of supportedChannels()) {
    if (!cur.edited.has(c.id)) cur.posts[c.id] = buildArticlePost(cur.article, c.service)
  }
}

function renderDesk() {
  const cur = S.cur
  $('#desk-empty').hidden = Boolean(cur)
  $('#desk-article').hidden = !cur
  if (!cur) { $('#sendbar').hidden = true; return }
  renderStory()
  renderChannels()
  renderPosts()
  renderFullText()
  renderIdeas()
  renderSendbar()
}

function renderStory() {
  const { article: a, item, loading, error } = S.cur
  if (loading) {
    $('#story').innerHTML = `<div class="story-body"><span class="lbl">Reading the article…</span><h1>${esc(item.title || item.link)}</h1><div class="skel"></div><div class="skel short"></div></div>`
    return
  }
  const byline = [a.author && `By ${a.author}`, a.published && timeAgo(a.published)].filter(Boolean).join(' · ')
  $('#story').innerHTML = `
    ${a.image ? `<img class="story-img" src="${esc(a.image)}" alt="" referrerpolicy="no-referrer">` : ''}
    <div class="story-body">
      <span class="lbl">${esc(a.siteName || host(a.url))}${byline ? ` · ${esc(byline)}` : ''}</span>
      <h1>${esc(a.title)}</h1>
      ${a.dek ? `<p class="dek">${esc(a.dek)}</p>` : ''}
      <p class="story-links"><a href="${esc(a.url)}" target="_blank" rel="noopener">Open the article ↗</a>${error ? `<span class="warn-txt">Couldn't read the page (${esc(error)}). Using the feed's summary.</span>` : ''}</p>
    </div>`
}

function renderChannels() {
  const sup = supportedChannels()
  const other = S.channels.filter((c) => !isSupported(c.service))
  if (!S.channels.length) {
    $('#channels').innerHTML = '<p class="muted small">No connected channels in this organization. Connect one in Buffer, then reload.</p>'
    return
  }
  $('#channels').innerHTML = sup.map((c) => `
    <label class="ch${S.picked.has(c.id) ? ' on' : ''}" title="${esc(networkName(c.service))}">
      <input type="checkbox" value="${esc(c.id)}"${S.picked.has(c.id) ? ' checked' : ''}>
      ${c.avatar ? `<img src="${esc(c.avatar)}" alt="" referrerpolicy="no-referrer">` : '<span class="av"></span>'}
      <span class="ch-t"><span class="ch-name">${esc(c.displayName || c.name)}</span><span class="net ${esc(c.service)}">${esc(networkName(c.service))}</span></span>
    </label>`).join('') +
    (other.length ? `<p class="muted small unsup">Not supported yet: ${other.map((c) => esc(`${c.displayName || c.name} (${networkName(c.service)})`)).join(', ')}</p>` : '')
}

function counter(text, service) {
  const n = countLength(text, service)
  const limit = NETWORKS[service].limit
  return `<span class="cnt${n > limit ? ' over' : n > limit * 0.9 ? ' near' : ''}">${fmt(n)} / ${fmt(limit)}</span>`
}

function renderPosts() {
  const cur = S.cur
  const chans = pickedChannels()
  if (cur.loading) { $('#posts').innerHTML = '<div class="skel tall"></div>'; return }
  if (!chans.length) { $('#posts').innerHTML = '<p class="muted small">Pick at least one channel above.</p>'; return }
  const imageless = !cur.article.image
  $('#posts').innerHTML = chans.map((c) => {
    const text = cur.posts[c.id] ?? ''
    const needsImage = NETWORKS[c.service].image && imageless
    return `<div class="post" data-channel="${esc(c.id)}">
      <div class="post-h">
        <span class="net ${esc(c.service)}">${esc(networkName(c.service))}</span>
        <span class="post-ch">${esc(c.displayName || c.name)}</span>
        ${cur.edited.has(c.id) ? '<button class="link tiny reset" type="button">Reset</button>' : ''}
        ${counter(text, c.service)}
      </div>
      <textarea rows="${Math.min(8, Math.max(3, Math.ceil(text.length / 70) + 1))}" spellcheck="true">${esc(text)}</textarea>
      ${needsImage ? `<p class="warn-txt small">${esc(networkName(c.service))} needs an image, and this article has none. This channel will be skipped.</p>` : ''}
    </div>`
  }).join('')
  autosizeAll($('#posts'))
}

function renderFullText() {
  const cur = S.cur
  if (cur.loading || !cur.article) { $('#fulltext').innerHTML = ''; return }
  const a = cur.article
  const len = (cur.fullText || a.text || '').length
  const source = cur.fullText ? 'text you pasted' : a.textSource === 'excerpt' ? 'the excerpt only' : `the ${a.textSource}`
  const warn = !cur.fullText && (a.previewOnly || len < 1200)
  $('#fulltext').innerHTML = `
    <div class="ft${warn ? ' warn' : ''}">
      <p>${warn
        ? `<b>Only ${fmt(len)} characters are public.</b> ${a.previewOnly ? 'This story looks paywalled, so the AI only sees the free preview.' : 'The AI only has a short excerpt to work from.'} Paste the full text for sharper ideas.`
        : `The AI will read <b>${fmt(len)} characters</b> from ${esc(source)}.`}
        <button class="link" type="button" id="toggle-paste">${cur.showPaste ? 'Hide' : cur.fullText ? 'Edit pasted text' : 'Paste full text'}</button></p>
      ${cur.showPaste ? `<textarea id="paste" rows="7" placeholder="Paste the article's full text here. It's sent to the AI once and not stored.">${esc(cur.fullText)}</textarea>` : ''}
    </div>`
}

function renderIdeas() {
  const cur = S.cur
  const btn = $('#write-ideas')
  const services = pickedServices()
  btn.disabled = cur.loading || cur.writing || !S.ai || !services.length || S.ideasLeft === 0
  btn.textContent = cur.writing ? 'Writing…' : cur.angles ? 'Rewrite ideas' : 'Write 3 ideas'
  $('#ideas-sub').textContent = !S.ai
    ? 'AI ideas are not set up on this deployment.'
    : `Fresh angles written by AI from the story itself, one version per network. They're sent to your Buffer Ideas board.${S.ideasLeft != null ? ` ${S.ideasLeft} idea sets left today.` : ''}`

  if (cur.writing) {
    $('#ideas').innerHTML = [0, 1, 2].map(() => '<div class="idea ghost"><div class="skel short"></div><div class="skel tall"></div></div>').join('')
    return
  }
  if (!cur.angles) { $('#ideas').innerHTML = ''; return }
  const url = cur.article.url
  $('#ideas').innerHTML = cur.angles.map((angle, i) => {
    const nets = Object.keys(angle.posts)
    const tab = nets.includes(cur.tab[i]) ? cur.tab[i] : nets[0]
    const body = angle.posts[tab] ?? ''
    const full = withLink(body, url, tab)
    const missing = services.filter((s) => !nets.includes(s))
    return `<div class="idea${cur.include.has(i) ? '' : ' off'}" data-i="${i}">
      <div class="idea-h">
        <label class="check"><input type="checkbox" class="inc"${cur.include.has(i) ? ' checked' : ''}> <span class="idea-n">Idea ${i + 1}</span></label>
        <h3>${esc(angle.label)}</h3>
        ${angle.hook ? `<span class="hook">${esc(angle.hook)}</span>` : ''}
      </div>
      ${angle.basis ? `<p class="basis muted small">${esc(angle.basis)}</p>` : ''}
      <div class="tabs" role="tablist">${nets.map((s) => `<button type="button" role="tab" data-s="${esc(s)}" aria-selected="${s === tab}"><span class="net ${esc(s)}">${esc(networkName(s))}</span></button>`).join('')}</div>
      <textarea class="body" data-s="${esc(tab)}" rows="${Math.min(9, Math.max(3, Math.ceil(body.length / 70) + 1))}">${esc(body)}</textarea>
      <div class="idea-f">
        <span class="muted small">${NETWORKS[tab].link ? 'The article link is added at the end.' : 'No link (Instagram captions aren\'t clickable).'}${angle.trimmed?.includes(tab) ? ' Shortened to fit.' : ''}</span>
        ${counter(full, tab)}
      </div>
      ${missing.length ? `<p class="warn-txt small">No version for ${missing.map(networkName).join(', ')}. Rewrite ideas to include it.</p>` : ''}
    </div>`
  }).join('')
  autosizeAll($('#ideas'))
}

/* ------------------------------------------------------------- sending */
function buildPayload() {
  const cur = S.cur
  const sendPost = $('#send-post').checked
  const posts = sendPost
    ? pickedChannels()
      .filter((c) => !(NETWORKS[c.service].image && !cur.article.image))
      .map((c) => ({ channelId: c.id, text: (cur.posts[c.id] || '').trim() }))
      .filter((p) => p.text)
    : []
  const services = pickedServices()
  const ideas = []
  for (const [i, angle] of (cur.angles || []).entries()) {
    if (!cur.include.has(i)) continue
    for (const s of services) {
      if (!(s in angle.posts) || !angle.posts[s].trim()) continue
      ideas.push({ title: `${angle.label} — ${networkName(s)}`, text: withLink(angle.posts[s], cur.article.url, s), services: [s] })
    }
  }
  return {
    organizationId: S.orgId,
    when: $('#when').value,
    attachImage: $('#attach-image').checked,
    article: { url: cur.article.url, title: cur.article.title, image: cur.article.image },
    posts,
    ideas,
  }
}

function renderSendbar() {
  const cur = S.cur
  const bar = $('#sendbar')
  bar.hidden = !cur || cur.loading
  if (bar.hidden) return
  if (cur.result) {
    const r = cur.result
    const okP = r.posts.filter((p) => p.ok).length, okI = r.ideas.filter((i) => i.ok).length
    const fails = [...r.posts.filter((p) => !p.ok).map((p) => `${channelLabel(p.channelId)}: ${p.message}`), ...r.ideas.filter((i) => !i.ok).map((i) => `${i.title}: ${i.message}`)]
    $('#send-summary').innerHTML = `<b>${okP ? `✓ ${okP} ${okP === 1 ? 'post' : 'posts'} ${$('#when').value === 'draft' ? 'saved as drafts' : 'queued'}` : ''}${okP && okI ? ' · ' : ''}${okI ? `✓ ${okI} ${okI === 1 ? 'idea' : 'ideas'} on your Ideas board` : ''}${!okP && !okI ? 'Nothing was sent' : ''}</b>${fails.length ? `<span class="fails">${fails.map(esc).join('<br>')}</span>` : ''}`
    $('#send').textContent = 'Send again'
    $('#send').disabled = S.sending
    bar.classList.toggle('done', okP + okI > 0 && !fails.length)
    return
  }
  bar.classList.remove('done')
  const p = buildPayload()
  const parts = []
  if (p.posts.length) parts.push(`${p.posts.length} article ${p.posts.length === 1 ? 'post' : 'posts'} ${p.when === 'draft' ? 'as drafts' : 'to the queue'}`)
  if (p.ideas.length) parts.push(`${p.ideas.length} ${p.ideas.length === 1 ? 'idea' : 'ideas'} to your Ideas board`)
  $('#send-summary').textContent = parts.length ? `Ready: ${parts.join(' + ')}.` : 'Pick a channel, or write ideas, to send something.'
  $('#send').textContent = S.sending ? 'Sending…' : 'Send to Buffer'
  $('#send').disabled = S.sending || !parts.length || p.posts.some((x) => {
    const c = S.channels.find((ch) => ch.id === x.channelId)
    return countLength(x.text, c.service) > NETWORKS[c.service].limit
  })
}

function channelLabel(id) {
  const c = S.channels.find((x) => x.id === id)
  return c ? `${c.displayName || c.name} (${networkName(c.service)})` : 'Channel'
}

async function send() {
  const cur = S.cur
  if (!cur || S.sending) return
  const payload = buildPayload()
  S.sending = true
  cur.result = null
  renderSendbar()
  try {
    const result = await api('/api/send', { body: payload })
    cur.result = result
    const okP = result.posts.filter((p) => p.ok).length, okI = result.ideas.filter((i) => i.ok).length
    if (okP + okI > 0) {
      S.handled[cur.key] = { at: Date.now(), posts: okP, ideas: okI }
      saveHandled()
      renderItems()
    }
  } catch (e) {
    flash(e.message)
  } finally {
    S.sending = false
    renderSendbar()
  }
}

async function writeIdeas() {
  const cur = S.cur
  if (!cur?.article || cur.writing) return
  const services = pickedServices()
  const feed = feedFor(cur.item)
  cur.writing = true
  renderIdeas()
  try {
    const a = cur.article
    const { angles, ideasLeft } = await api('/api/ideas', {
      body: {
        article: { ...a, text: cur.fullText || a.text, previewOnly: cur.fullText ? false : a.previewOnly },
        services,
        voice: feed?.voice || '',
      },
    })
    if (S.cur !== cur) return
    cur.angles = angles
    cur.include = new Set([0, 1, 2])
    cur.tab = {}
    cur.result = null
    S.ideasLeft = ideasLeft
  } catch (e) {
    flash(e.message)
  } finally {
    cur.writing = false
    if (S.cur === cur) { renderIdeas(); renderSendbar() }
  }
}

/* ---------------------------------------------------------------- events */
$('#add-feed').addEventListener('submit', (e) => { e.preventDefault(); addFeed($('#feed-url').value) })
$('#try').addEventListener('click', (e) => {
  const b = e.target.closest('[data-feed]')
  if (b) addFeed(b.dataset.feed)
})
$('#refresh').addEventListener('click', refreshAll)
$('#feed-list').addEventListener('click', (e) => {
  const li = e.target.closest('.feed')
  if (li && e.target.closest('.remove')) removeFeed(li.dataset.url)
})
$('#feed-list').addEventListener('input', (e) => {
  const li = e.target.closest('.feed')
  if (!li || e.target.tagName !== 'TEXTAREA') return
  const feed = S.feeds.find((f) => f.url === li.dataset.url)
  if (feed) { feed.voice = e.target.value.slice(0, 1500); saveFeeds() }
})

$$('.seg button').forEach((b) => b.addEventListener('click', () => { S.filter = b.dataset.filter; renderItems() }))
$('#items').addEventListener('click', (e) => {
  const b = e.target.closest('.item')
  if (!b) return
  const item = allItems().find((it) => it.key === b.dataset.key)
  if (item) openArticle(item)
})
$('#open-url').addEventListener('submit', (e) => {
  e.preventDefault()
  let link = $('#article-url').value.trim()
  if (!link) return
  if (!/^https?:\/\//i.test(link)) link = `https://${link}`
  $('#article-url').value = ''
  openArticle({ link, title: '', summary: '', feedUrl: null })
})

$('#channels').addEventListener('change', (e) => {
  const id = e.target.value
  if (e.target.checked) S.picked.add(id); else S.picked.delete(id)
  store.set(pickKey(), [...S.picked])
  renderChannels(); renderPosts(); renderIdeas(); renderSendbar()
})

$('#posts').addEventListener('input', (e) => {
  const box = e.target.closest('.post')
  if (!box || e.target.tagName !== 'TEXTAREA') return
  const id = box.dataset.channel
  S.cur.posts[id] = e.target.value
  autosize(e.target)
  S.cur.edited.add(id)
  const c = S.channels.find((x) => x.id === id)
  box.querySelector('.cnt').outerHTML = counter(e.target.value, c.service)
  if (!box.querySelector('.reset')) box.querySelector('.post-ch').insertAdjacentHTML('afterend', '<button class="link tiny reset" type="button">Reset</button>')
  S.cur.result = null
  renderSendbar()
})
$('#posts').addEventListener('click', (e) => {
  const box = e.target.closest('.post')
  if (!box || !e.target.closest('.reset')) return
  S.cur.edited.delete(box.dataset.channel)
  resetPosts(); renderPosts(); renderSendbar()
})
for (const id of ['#send-post', '#when', '#attach-image']) $(id).addEventListener('change', () => { if (S.cur) { S.cur.result = null; renderSendbar() } })

$('#fulltext').addEventListener('click', (e) => {
  if (!e.target.closest('#toggle-paste')) return
  S.cur.showPaste = !S.cur.showPaste
  renderFullText()
  if (S.cur.showPaste) $('#paste')?.focus()
})
$('#fulltext').addEventListener('input', (e) => {
  if (e.target.id !== 'paste') return
  // The summary line updates when the box loses focus (the change event), so
  // the textarea being typed in is never re-rendered.
  S.cur.fullText = e.target.value.slice(0, 20000)
})
$('#fulltext').addEventListener('change', (e) => { if (e.target.id === 'paste') renderFullText() })

$('#write-ideas').addEventListener('click', writeIdeas)
$('#ideas').addEventListener('click', (e) => {
  const card = e.target.closest('.idea')
  if (!card) return
  const i = Number(card.dataset.i)
  const tab = e.target.closest('[role="tab"]')
  if (tab) { S.cur.tab[i] = tab.dataset.s; renderIdeas() }
})
$('#ideas').addEventListener('change', (e) => {
  const card = e.target.closest('.idea')
  if (!card || !e.target.classList.contains('inc')) return
  const i = Number(card.dataset.i)
  if (e.target.checked) S.cur.include.add(i); else S.cur.include.delete(i)
  S.cur.result = null
  card.classList.toggle('off', !e.target.checked)
  renderSendbar()
})
$('#ideas').addEventListener('input', (e) => {
  if (!e.target.classList.contains('body')) return
  const card = e.target.closest('.idea')
  const i = Number(card.dataset.i)
  const s = e.target.dataset.s
  S.cur.angles[i].posts[s] = e.target.value
  autosize(e.target)
  card.querySelector('.cnt').outerHTML = counter(withLink(e.target.value, S.cur.article.url, s), s)
  S.cur.result = null
  renderSendbar()
})

$('#send').addEventListener('click', send)
$('#org').addEventListener('change', async (e) => { S.orgId = e.target.value; await loadOrg() })
$('#logout').addEventListener('click', async () => {
  try { await api('/auth/logout', { body: {} }) } catch { /* reload anyway */ }
  location.href = '/'
})

let resizeTimer
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { autosizeAll($('#posts')); autosizeAll($('#ideas')) }, 150) })

boot()
