import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverFeedLinks, loadFeed, looksLikeFeed, parseFeed } from '../lib/feed.js'

const RSS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>D1Baseball</title><atom:link href="https://d1baseball.com/feed/" rel="self" type="application/rss+xml" /><link>https://d1baseball.com</link>
<item><title>2026 Fall Report: Army</title><link>https://d1baseball.com/fall-report/2026-army/</link><dc:creator><![CDATA[Mark Etheridge]]></dc:creator><pubDate>Fri, 06 Nov 2026 14:00:00 +0000</pubDate><category><![CDATA[Fall Report]]></category><guid isPermaLink="false">https://d1baseball.com/?p=1</guid><description><![CDATA[With six regionals in the last eight years, Army&#8217;s bar is high [&#8230;]]]></description></item>
<item><title>Older story &amp; more</title><link>https://d1baseball.com/old/</link><pubDate>Mon, 02 Nov 2026 14:00:00 +0000</pubDate><description>Old</description><content:encoded><![CDATA[<p><img src="https://cdn.example.com/a.jpg">Full text here.</p>]]></content:encoded></item>
</channel></rss>`

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Site</title><link href="https://atom.example/"/>
<entry><title type="html">Hello &lt;b&gt;world&lt;/b&gt;</title><link rel="alternate" href="https://atom.example/hello"/><published>2026-11-05T10:00:00Z</published><author><name>Ann</name></author><summary>Short</summary></entry></feed>`

test('parses RSS with creator, categories, cleaned excerpt, newest first', () => {
  const feed = parseFeed(RSS, 'https://d1baseball.com/feed/')
  assert.equal(feed.title, 'D1Baseball')
  assert.equal(feed.items.length, 2)
  const [a, b] = feed.items
  assert.equal(a.title, '2026 Fall Report: Army')
  assert.equal(a.author, 'Mark Etheridge')
  assert.deepEqual(a.categories, ['Fall Report'])
  assert.equal(a.summary, 'With six regionals in the last eight years, Army’s bar is high')
  assert.equal(b.title, 'Older story & more')
  assert.equal(b.image, 'https://cdn.example.com/a.jpg')
  assert.equal(b.contentText, 'Full text here.')
})

test('parses Atom', () => {
  const feed = parseFeed(ATOM, 'https://atom.example/feed')
  assert.equal(feed.items[0].title, 'Hello world')
  assert.equal(feed.items[0].link, 'https://atom.example/hello')
  assert.equal(feed.items[0].author, 'Ann')
})

test('parses JSON Feed', () => {
  const feed = parseFeed(JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'J', items: [{ id: '1', url: 'https://j.example/1', title: 'One', content_html: '<p>Body</p>', date_published: '2026-11-01T00:00:00Z' }] }), 'https://j.example/feed.json')
  assert.equal(feed.items[0].title, 'One')
  assert.equal(feed.items[0].contentText, 'Body')
})

test('detects feeds and discovers feed links on a homepage', () => {
  assert.ok(looksLikeFeed(RSS))
  assert.ok(!looksLikeFeed('<!doctype html><html></html>'))
  const html = '<link rel="alternate" type="application/rss+xml" title="Site &raquo; Feed" href="/feed/"><link rel="alternate" type="application/rss+xml" title="Site &raquo; Comments Feed" href="/comments/feed/">'
  assert.deepEqual(discoverFeedLinks(html, 'https://site.example/'), ['https://site.example/feed/'])
})

test('loadFeed follows a homepage to its feed', async () => {
  const pages = {
    'https://d1baseball.com/': '<html><head><link rel="alternate" type="application/rss+xml" href="https://d1baseball.com/feed/"></head></html>',
    'https://d1baseball.com/feed/': RSS,
  }
  const fetcher = async (url) => {
    const key = String(url)
    if (!(key in pages)) throw new Error('404')
    return { url: key, text: pages[key], contentType: key.endsWith('/feed/') ? 'application/rss+xml' : 'text/html' }
  }
  const feed = await loadFeed('d1baseball.com', { fetcher })
  assert.equal(feed.feedUrl, 'https://d1baseball.com/feed/')
  assert.equal(feed.items.length, 2)
})
