// Pure logic shared by the browser and the server (and the tests): network
// rules, text clean-up, and the article post built straight from the
// headline and excerpt. No DOM, no network.

/* ------------------------------------------------------------ networks */
// limit: characters allowed. urlLength: how many characters a link counts for
// (X and Mastodon count every link as 23; the others count it as typed).
// link: whether a link in the text is clickable. image: an image is required.
export const NETWORKS = {
  twitter:   { name: 'X',         limit: 280,  urlLength: 23,   link: true,  image: false },
  threads:   { name: 'Threads',   limit: 500,  urlLength: null, link: true,  image: false },
  bluesky:   { name: 'Bluesky',   limit: 300,  urlLength: null, link: true,  image: false },
  mastodon:  { name: 'Mastodon',  limit: 500,  urlLength: 23,   link: true,  image: false },
  facebook:  { name: 'Facebook',  limit: 2000, urlLength: null, link: true,  image: false },
  linkedin:  { name: 'LinkedIn',  limit: 3000, urlLength: null, link: true,  image: false },
  instagram: { name: 'Instagram', limit: 2200, urlLength: null, link: false, image: true },
}

export const SUPPORTED_SERVICES = Object.keys(NETWORKS)

const OTHER_NAMES = { tiktok: 'TikTok', youtube: 'YouTube', pinterest: 'Pinterest', googlebusiness: 'Google Business', startPage: 'Start Page', substack: 'Substack' }

export function networkName(service) {
  return NETWORKS[service]?.name || OTHER_NAMES[service] || service.charAt(0).toUpperCase() + service.slice(1)
}

export function isSupported(service) {
  return Boolean(NETWORKS[service])
}

/* ---------------------------------------------------------------- text */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', bull: '•', middot: '·',
  eacute: 'é', egrave: 'è', aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
  uuml: 'ü', ouml: 'ö', auml: 'ä', ccedil: 'ç', copy: '©', reg: '®', trade: '™', deg: '°',
}

export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      try { return String.fromCodePoint(n) } catch { return match }
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match
  })
}

// HTML fragment → readable plain text with paragraph breaks.
export function htmlToText(html) {
  return decodeEntities(String(html ?? '')
    .replace(/<(script|style|noscript|iframe|svg|figure|figcaption)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|section|article)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Feed excerpts often end with "[…]", "Read more" or "The post X appeared first
// on Y." — WordPress furniture that should not reach a social post.
export function cleanExcerpt(text) {
  return String(text ?? '')
    .replace(/\s*The post .{1,300}? appeared first on .{1,200}?\.?\s*$/i, '')
    .replace(/\s*(\[(…|\.\.\.)\]|\[&hellip;\]|(Continue reading|Read more)[^\n]*)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/* --------------------------------------------------------------- length */
const URL_PATTERN = /https?:\/\/[^\s]+/g

// Characters as the network counts them: graphemes (so an emoji counts once),
// with links counted at the network's fixed length where it has one.
export function countLength(text, service) {
  const net = NETWORKS[service]
  let value = String(text ?? '')
  let linkChars = 0
  if (net?.urlLength) {
    value = value.replace(URL_PATTERN, () => { linkChars += net.urlLength; return '' })
  }
  return graphemes(value) + linkChars
}

function graphemes(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    let n = 0
    for (const _ of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) n++
    return n
  }
  return Array.from(text).length
}

// Cut at a word boundary so the result (with an ellipsis) fits in `max`
// characters. Returns '' when nothing sensible fits.
export function truncateAtWord(text, max) {
  const value = String(text ?? '').trim()
  if (graphemes(value) <= max) return value
  if (max < 2) return ''
  const chars = Array.from(value).slice(0, max - 1).join('')
  const cut = chars.replace(/\s+\S*$/, '')
  const base = (cut.length >= chars.length * 0.6 ? cut : chars).replace(/[\s,;:–—-]+$/, '')
  return base ? `${base}…` : ''
}

/* ---------------------------------------------------- the article post */
// The no-AI post: the headline and the publisher's own excerpt (meta
// description) with the link, shaped to each network's limit.
//
// article: { title, dek, url }
export function buildArticlePost(article, service) {
  const net = NETWORKS[service]
  if (!net) return ''
  const title = String(article.title ?? '').trim()
  let dek = cleanExcerpt(article.dek)
  // Some sites repeat the headline as the description.
  if (dek && normalize(dek).startsWith(normalize(title))) dek = dek.slice(title.length).replace(/^[\s:.,–—-]+/, '')
  const tail = net.link ? (article.url ? `\n\n${article.url}` : '') : '\n\nFull story: link in bio.'

  const budget = net.limit - countLength(tail, service)
  const head = truncateAtWord(title, budget)
  let body = head
  if (dek && head === title) {
    const room = budget - countLength(`${title}\n\n`, service)
    // Only add the excerpt when a meaningful piece of it fits.
    if (room >= 40) {
      const fitted = truncateAtWord(dek, room)
      if (fitted) body = `${title}\n\n${fitted}`
    }
  }
  return `${body}${tail}`.trim()
}

function normalize(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/* ------------------------------------------------------- the AI ideas */
// The model writes the post body without the link. The app adds the link
// itself, so it is always the real article URL and always counted correctly.
export function withLink(body, url, service) {
  const net = NETWORKS[service]
  const text = String(body ?? '').trim()
  if (!net || !net.link || !url) return text
  return `${text}\n\n${url}`
}

// How many characters the model may use for the body on each network.
export function bodyBudget(service, url) {
  const net = NETWORKS[service]
  if (!net) return 0
  const linkCost = net.link && url ? countLength(`\n\n${url}`, service) : 0
  return net.limit - linkCost
}

// Clamp a model-written body to the network's budget, flagging when it had to.
export function fitBody(body, service, url) {
  const budget = bodyBudget(service, url)
  const text = String(body ?? '').trim()
  if (countLength(text, service) <= budget) return { text, trimmed: false }
  return { text: truncateAtWord(text, budget), trimmed: true }
}

/* ------------------------------------------------------------- inbox */
// A stable key for "have we handled this article yet": the link without the
// tracking parameters feeds love to add.
export function articleKey(link) {
  try {
    const url = new URL(link)
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref$|source$)/i.test(key)) url.searchParams.delete(key)
    }
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return String(link || '').trim()
  }
}

export function timeAgo(date, now = Date.now()) {
  const t = new Date(date).getTime()
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
