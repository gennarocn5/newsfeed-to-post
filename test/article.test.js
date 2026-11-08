import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractArticle } from '../lib/article.js'
import { isPrivateAddress, normalizeUserUrl } from '../lib/fetch-public.js'

const para = (n) => `<p>${'This is a long sentence about the team and its season. '.repeat(n)}</p>`

test('reads meta tags and the article body', () => {
  const html = `<html><head><title>T | Site</title>
  <meta property="og:title" content="Army&#8217;s fall">
  <meta property="og:description" content="Six regionals in eight years.">
  <meta property="og:image" content="/img/army.png"><meta property="og:site_name" content="D1Baseball">
  <meta name="author" content="Mark Etheridge"><meta property="article:published_time" content="2026-11-06T14:00:00Z">
  <link rel="canonical" href="https://d1baseball.com/fall-report/2026-army/"></head>
  <body><nav><p>${'Menu item text that is long enough to count. '.repeat(3)}</p></nav><article>${para(3)}${para(4)}<script>bad()</script></article></body></html>`
  const a = extractArticle(html, 'https://d1baseball.com/fall-report/2026-army/?utm_source=x')
  assert.equal(a.title, 'Army’s fall')
  assert.equal(a.dek, 'Six regionals in eight years.')
  assert.equal(a.image, 'https://d1baseball.com/img/army.png')
  assert.equal(a.siteName, 'D1Baseball')
  assert.equal(a.author, 'Mark Etheridge')
  assert.equal(a.url, 'https://d1baseball.com/fall-report/2026-army/')
  assert.equal(a.textSource, 'page')
  assert.ok(!a.text.includes('Menu item'))
  assert.ok(!a.text.includes('bad()'))
  assert.equal(a.previewOnly, false)
})

test('flags a paywalled preview and prefers JSON-LD body when longer', () => {
  const ld = { '@context': 'https://schema.org', '@type': 'NewsArticle', headline: 'H', isAccessibleForFree: 'False', articleBody: 'Body '.repeat(50) }
  const html = `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><article>${para(1)}<div class="paywall">Subscribe to continue reading</div></article></body></html>`
  const a = extractArticle(html, 'https://news.example/h')
  assert.equal(a.title, 'H')
  assert.equal(a.previewOnly, true)
  assert.equal(a.textSource, 'structured data')
})

test('feed full text wins when the page is a teaser', () => {
  const a = extractArticle('<html><body><article>' + para(1) + '</article></body></html>', 'https://x.example/a', { contentText: 'Full '.repeat(500) })
  assert.equal(a.textSource, 'feed')
})

test('blocks private addresses and normalizes input', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) assert.ok(isPrivateAddress(ip), ip)
  for (const ip of ['8.8.8.8', '104.18.1.1', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip)
  assert.equal(normalizeUserUrl('d1baseball.com').toString(), 'https://d1baseball.com/')
  assert.throws(() => normalizeUserUrl('ftp://x.com'))
  assert.throws(() => normalizeUserUrl('https://user:pw@x.com'))
})
