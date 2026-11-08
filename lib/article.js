// Reads one article page: the publisher's own headline, description, image,
// byline and date from its meta tags, plus the readable body text for the AI
// ideas. Paywalled sites usually serve only a preview to the public; that is
// detected and reported so the user can paste the full text instead.
import { parse } from 'node-html-parser'
import { fetchPublic } from './fetch-public.js'
import { decodeEntities, htmlToText } from '../public/engine.js'

export const MAX_TEXT = 15_000
const MIN_PARAGRAPH = 40

function meta(root, ...keys) {
  for (const key of keys) {
    const el = root.querySelector(`meta[property="${key}"]`) || root.querySelector(`meta[name="${key}"]`)
    const value = el?.getAttribute('content')
    if (value?.trim()) return decodeEntities(value.trim())
  }
  return ''
}

function absolute(href, base) {
  if (!href) return null
  try {
    const url = new URL(href, base)
    return /^https?:$/.test(url.protocol) ? url.toString() : null
  } catch { return null }
}

// JSON-LD often carries the cleanest data (and sometimes the whole body).
export function readJsonLd(root) {
  const found = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(visit)
    const type = [].concat(node['@type'] || []).join(' ')
    if (/(News|Blog|Reportage|Analysis|Opinion)?Article|BlogPosting|Report/.test(type)) found.push(node)
    if (node['@graph']) visit(node['@graph'])
  }
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(script.textContent)) } catch { /* malformed JSON-LD is common */ }
  }
  const a = found[0]
  if (!a) return null
  const image = [].concat(a.image || [])[0]
  const author = [].concat(a.author || [])[0]
  return {
    headline: a.headline ? decodeEntities(String(a.headline)) : '',
    description: a.description ? decodeEntities(String(a.description)) : '',
    body: a.articleBody ? htmlToText(String(a.articleBody)) : '',
    image: typeof image === 'string' ? image : image?.url || null,
    author: typeof author === 'string' ? author : author?.name || '',
    published: a.datePublished || null,
    free: a.isAccessibleForFree === undefined ? null : !['false', false, 'False'].includes(a.isAccessibleForFree),
  }
}

const BODY_SELECTORS = [
  '[itemprop="articleBody"]', '.entry-content', '.article-content', '.article-body', '.post-content',
  '.story-body', '.c-entry-content', 'article', 'main',
]

export function readBody(root) {
  for (const junk of root.querySelectorAll('script, style, noscript, nav, header, footer, aside, form, figure, iframe, svg, .share, .social, .related, .newsletter, .comments, #comments')) {
    junk.remove()
  }
  let best = ''
  for (const selector of BODY_SELECTORS) {
    for (const container of root.querySelectorAll(selector)) {
      const paragraphs = container.querySelectorAll('p, h2, h3, blockquote, li')
        .map((p) => htmlToText(p.innerHTML).replace(/\s+/g, ' ').trim())
        .filter((t) => t.length >= MIN_PARAGRAPH)
      const text = [...new Set(paragraphs)].join('\n\n')
      if (text.length > best.length) best = text
    }
    if (best.length > 1500) break
  }
  return best
}

const PAYWALL_HINTS = /(subscribe to (continue|read)|to continue reading|already a (subscriber|member)|members[- ]only|premium content|unlock this (article|story)|paywall|sign in to read|become a (subscriber|member))/i

export function extractArticle(html, url, hints = {}) {
  const root = parse(html, { blockTextElements: { script: true, style: true, noscript: true } })
  const ld = readJsonLd(root)
  const title = meta(root, 'og:title', 'twitter:title') || ld?.headline || decodeEntities(root.querySelector('title')?.textContent?.trim() || '') || hints.title || ''
  const dek = meta(root, 'og:description', 'description', 'twitter:description') || ld?.description || hints.summary || ''
  const image = absolute(meta(root, 'og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src') || ld?.image, url) || hints.image || null
  const siteName = meta(root, 'og:site_name', 'application-name') || new URL(url).hostname.replace(/^www\./, '')
  const author = meta(root, 'author', 'article:author', 'parsely-author', 'sailthru.author') || ld?.author || hints.author || ''
  const published = meta(root, 'article:published_time', 'parsely-pub-date', 'date') || ld?.published || hints.published || null
  const canonical = absolute(root.querySelector('link[rel="canonical"]')?.getAttribute('href'), url) || url

  // Longest wins among: JSON-LD body, the page body, the feed's own full text.
  const sources = [
    { from: 'page', text: readBody(root) },
    { from: 'structured data', text: ld?.body || '' },
    { from: 'feed', text: hints.contentText || '' },
  ].sort((a, b) => b.text.length - a.text.length)
  let { from, text } = sources[0]
  if (!text) { from = 'excerpt'; text = dek }

  const previewOnly = ld?.free === false || (text.length < 2500 && PAYWALL_HINTS.test(html))
  return {
    url: canonical,
    title: htmlToText(title),
    dek: htmlToText(dek),
    image,
    siteName: htmlToText(siteName),
    author: htmlToText(author).replace(/^by\s+/i, ''),
    published,
    text: text.slice(0, MAX_TEXT),
    textSource: from,
    previewOnly,
  }
}

export async function loadArticle(url, hints = {}, { fetcher = fetchPublic } = {}) {
  const res = await fetcher(url, { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' })
  return extractArticle(res.text, res.url, hints)
}
