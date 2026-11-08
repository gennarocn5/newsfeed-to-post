import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildArticlePost, cleanExcerpt, countLength, decodeEntities, fitBody, htmlToText, truncateAtWord, withLink, articleKey } from '../public/engine.js'

const article = {
  title: '2026 Fall Report: Army',
  dek: 'With six regionals in the last eight years and five regular-season titles in the last six, Army has set the bar high in West Point. Here is how the Black Knights look this fall.',
  url: 'https://d1baseball.com/fall-report/2026-army/',
}

test('X post fits 280 with the link counted as 23', () => {
  const post = buildArticlePost(article, 'twitter')
  assert.ok(post.startsWith('2026 Fall Report: Army\n\n'))
  assert.ok(post.endsWith(article.url))
  assert.ok(countLength(post, 'twitter') <= 280)
})

test('Bluesky counts the full link and still fits 300', () => {
  const post = buildArticlePost(article, 'bluesky')
  assert.ok(countLength(post, 'bluesky') <= 300)
  assert.ok(post.endsWith(article.url))
})

test('Instagram has no link and points to the bio', () => {
  const post = buildArticlePost(article, 'instagram')
  assert.ok(!post.includes('https://'))
  assert.match(post, /link in bio/)
})

test('a description that repeats the headline is not doubled', () => {
  const post = buildArticlePost({ title: 'Big news', dek: 'Big news: the team won again tonight in extra innings.', url: 'https://x.com/a' }, 'facebook')
  assert.equal(post, 'Big news\n\nthe team won again tonight in extra innings.\n\nhttps://x.com/a')
})

test('entities and WordPress furniture are cleaned', () => {
  assert.equal(decodeEntities('It&#8217;s &amp; done &hellip;'), 'It’s & done …')
  assert.equal(cleanExcerpt('A good read [&hellip;]'), 'A good read')
  assert.equal(cleanExcerpt('Story text. The post Army preview appeared first on D1Baseball.'), 'Story text.')
  assert.equal(htmlToText('<p>One</p><p>Two<br>Three</p>'), 'One\n\nTwo\nThree')
})

test('truncation cuts at a word and adds an ellipsis', () => {
  const t = truncateAtWord('one two three four five', 12)
  assert.equal(t, 'one two…')
  assert.ok(Array.from(t).length <= 12)
})

test('AI bodies are clamped to leave room for the link', () => {
  const long = 'word '.repeat(100)
  const { text, trimmed } = fitBody(long, 'twitter', article.url)
  assert.ok(trimmed)
  assert.ok(countLength(withLink(text, article.url, 'twitter'), 'twitter') <= 280)
  assert.equal(withLink('Hi', article.url, 'instagram'), 'Hi')
})

test('article keys ignore tracking parameters', () => {
  assert.equal(articleKey('https://a.com/story/?utm_source=rss&id=3#top'), 'https://a.com/story/?id=3')
  assert.equal(articleKey('https://a.com/story/'), 'https://a.com/story')
})
