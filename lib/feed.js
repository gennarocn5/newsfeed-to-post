// Reads a publisher's feed. Accepts RSS 2.0, RSS 1.0 (RDF), Atom and JSON
// Feed, and when given a homepage instead of a feed, finds the feed the page
// advertises (or tries the usual addresses: WordPress serves /feed/).
import { XMLParser } from 'fast-xml-parser'
import { HttpError } from './config.js'
import { fetchPublic, normalizeUserUrl } from './fetch-public.js'
import { cleanExcerpt, decodeEntities, htmlToText } from '../public/engine.js'

const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5'
const COMMON_FEED_PATHS = ['/feed/', '/rss', '/feed.xml', '/rss.xml', '/atom.xml', '/index.xml', '/feed.json']
export const MAX_ITEMS = 30

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  cdataPropName: false,
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  parseTagValue: false,
  isArray: (name) => ['item', 'entry', 'link', 'category', 'media:content', 'media:thumbnail', 'enclosure', 'author'].includes(name),
})

/* ---------------------------------------------------------- detection */
export function looksLikeFeed(text, contentType = '') {
  const head = text.slice(0, 2000).trimStart()
  if (/json/.test(contentType) || head.startsWith('{')) return /jsonfeed\.org/.test(head) || /"items"\s*:/.test(text.slice(0, 20000))
  return /<(rss|feed|rdf:RDF)[\s>]/i.test(head)
}

// <link rel="alternate" type="application/rss+xml" href="..."> on a homepage.
export function discoverFeedLinks(html, baseUrl) {
  const links = []
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const attr = (name) => (tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i')) || [])[1]
    const rel = (attr('rel') || '').toLowerCase()
    const type = (attr('type') || '').toLowerCase()
    const href = attr('href')
    if (!href || !rel.split(/\s+/).includes('alternate')) continue
    if (!/(rss|atom|feed)\+?(xml|json)|application\/json/.test(type)) continue
    // Skip comment feeds; they are not the article feed.
    if (/comments?/i.test(attr('title') || '') || /\/comments\/feed/.test(href)) continue
    try { links.push(new URL(decodeEntities(href), baseUrl).toString()) } catch { /* ignore bad href */ }
  }
  return [...new Set(links)]
}

/* ------------------------------------------------------------- parsing */
const text = (v) => {
  if (v == null) return ''
  if (typeof v === 'string' || typeof v === 'number') return String(v)
  if (Array.isArray(v)) return text(v[0])
  if (typeof v === 'object') return text(v['#text'] ?? '')
  return ''
}

function firstImageIn(html) {
  const m = String(html || '').match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)
  return m ? decodeEntities(m[1]) : null
}

function absolute(href, base) {
  if (!href) return null
  try { return new URL(href, base).toString() } catch { return null }
}

function mediaImage(node, base) {
  const candidates = [
    ...(node['media:content'] || []).filter((m) => !m['@_medium'] || m['@_medium'] === 'image' || /^image\//.test(m['@_type'] || '')),
    ...(node['media:thumbnail'] || []),
    ...(node.enclosure || []).filter((e) => /^image\//.test(e['@_type'] || '')),
  ]
  const group = node['media:group']
  if (group) candidates.push(...[].concat(group['media:content'] || [], group['media:thumbnail'] || []))
  for (const c of candidates) {
    const url = absolute(c['@_url'], base)
    if (url) return url
  }
  return null
}

function toIso(value) {
  const t = Date.parse(text(value))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

function rssItem(node, base) {
  const link = absolute(text(node.link), base) || absolute(text(node.guid), base)
  const contentHtml = text(node['content:encoded'])
  const summaryHtml = text(node.description)
  return {
    title: decodeEntities(htmlToText(text(node.title))),
    link,
    published: toIso(node.pubDate || node['dc:date'] || node.published || node.updated),
    author: decodeEntities(text(node['dc:creator']) || text(node.author)).replace(/^[^(]*\(([^)]+)\)$/, '$1').trim(),
    summary: cleanExcerpt(htmlToText(summaryHtml || contentHtml).slice(0, 1200)),
    contentText: contentHtml ? htmlToText(contentHtml) : '',
    image: mediaImage(node, base) || firstImageIn(contentHtml || summaryHtml),
    categories: (node.category || []).map((c) => decodeEntities(text(c))).filter(Boolean).slice(0, 8),
  }
}

function atomLink(node, base) {
  const links = node.link || []
  const pick = links.find((l) => (l['@_rel'] || 'alternate') === 'alternate' && (!l['@_type'] || /html/.test(l['@_type']))) || links[0]
  return absolute(pick?.['@_href'] || text(pick), base)
}

function atomItem(node, base) {
  const contentHtml = text(node.content)
  const summaryHtml = text(node.summary)
  const author = (node.author || [])[0]
  return {
    title: decodeEntities(htmlToText(text(node.title))),
    link: atomLink(node, base),
    published: toIso(node.published || node.updated),
    author: decodeEntities(text(author?.name || author)).trim(),
    summary: cleanExcerpt(htmlToText(summaryHtml || contentHtml).slice(0, 1200)),
    contentText: contentHtml ? htmlToText(contentHtml) : '',
    image: mediaImage(node, base) || firstImageIn(contentHtml || summaryHtml),
    categories: (node.category || []).map((c) => decodeEntities(c['@_term'] || text(c))).filter(Boolean).slice(0, 8),
  }
}

function jsonFeed(json, base) {
  const items = (json.items || []).map((it) => ({
    title: decodeEntities(htmlToText(it.title || '')),
    link: absolute(it.url || it.external_url || it.id, base),
    published: toIso(it.date_published || it.date_modified),
    author: (it.authors?.[0]?.name || it.author?.name || '').trim(),
    summary: cleanExcerpt(it.summary || htmlToText(it.content_html || it.content_text || '').slice(0, 1200)),
    contentText: it.content_html ? htmlToText(it.content_html) : (it.content_text || ''),
    image: absolute(it.image || it.banner_image, base),
    categories: (it.tags || []).slice(0, 8),
  }))
  return { title: json.title || '', siteUrl: absolute(json.home_page_url, base), items }
}

export function parseFeed(body, baseUrl) {
  const trimmed = body.trimStart()
  let feed
  if (trimmed.startsWith('{')) {
    let json
    try { json = JSON.parse(trimmed) } catch { throw new HttpError(422, 'That feed isn\'t valid JSON') }
    feed = jsonFeed(json, baseUrl)
  } else {
    let doc
    try { doc = parser.parse(body) } catch { throw new HttpError(422, 'That feed couldn\'t be read') }
    if (doc.rss?.channel) {
      const ch = Array.isArray(doc.rss.channel) ? doc.rss.channel[0] : doc.rss.channel
      feed = {
        title: decodeEntities(text(ch.title)),
        siteUrl: absolute(text((ch.link || []).find((l) => typeof l === 'string' || l['#text']) ?? ch.link), baseUrl),
        items: (ch.item || []).map((n) => rssItem(n, baseUrl)),
      }
    } else if (doc.feed) {
      feed = {
        title: decodeEntities(htmlToText(text(doc.feed.title))),
        siteUrl: atomLink(doc.feed, baseUrl),
        items: (doc.feed.entry || []).map((n) => atomItem(n, baseUrl)),
      }
    } else if (doc['rdf:RDF']) {
      const rdf = doc['rdf:RDF']
      const ch = rdf.channel || {}
      feed = {
        title: decodeEntities(text(ch.title)),
        siteUrl: absolute(text(ch.link), baseUrl),
        items: [].concat(rdf.item || []).map((n) => rssItem(n, baseUrl)),
      }
    } else {
      throw new HttpError(422, 'That address isn\'t an RSS, Atom or JSON feed')
    }
  }

  const items = feed.items
    .filter((it) => it.link && it.title)
    .sort((a, b) => (Date.parse(b.published || 0) || 0) - (Date.parse(a.published || 0) || 0))
    .slice(0, MAX_ITEMS)
  return { title: feed.title || new URL(baseUrl).hostname, siteUrl: feed.siteUrl || new URL(baseUrl).origin, items }
}

/* --------------------------------------------------------------- load */
// Given whatever the user pasted (a feed, a homepage, or a bare domain),
// returns { feedUrl, title, siteUrl, items }.
export async function loadFeed(input, { fetcher = fetchPublic } = {}) {
  const start = normalizeUserUrl(input)
  const first = await fetcher(start, { accept: FEED_ACCEPT })
  if (looksLikeFeed(first.text, first.contentType)) {
    return { feedUrl: first.url, ...parseFeed(first.text, first.url) }
  }

  // An HTML page: follow what it advertises, then the common locations.
  const candidates = [
    ...discoverFeedLinks(first.text, first.url),
    ...COMMON_FEED_PATHS.map((p) => new URL(p, first.url).toString()),
  ]
  for (const candidate of [...new Set(candidates)].slice(0, 6)) {
    try {
      const res = await fetcher(candidate, { accept: FEED_ACCEPT })
      if (looksLikeFeed(res.text, res.contentType)) {
        return { feedUrl: res.url, ...parseFeed(res.text, res.url) }
      }
    } catch { /* try the next one */ }
  }
  throw new HttpError(422, `Couldn't find a feed at ${start.hostname}. Paste the feed's address (it often ends in /feed or /rss).`)
}
