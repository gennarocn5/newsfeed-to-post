# Newsfeed-To-Post

**Every new story, ready to post.**

Newsrooms publish all day, and someone has to turn every article into social posts for every network. Newsfeed-To-Post watches a publisher's feed and, for each new article, gets two things ready to send to Buffer:

1. **The article post.** The publisher's own headline and excerpt (meta description) plus the link, shaped to each network's character limit. No AI, so it's exactly the publisher's words. It goes to the Buffer queue or drafts.
2. **Three post ideas.** Claude reads the story and writes three distinct angles (a stat, a quote, a person, a key moment), with a native version for each network. They go to the Buffer **Ideas** board, so the social team can pick them up later in the week.

Live: https://newsfeed-to-post.vercel.app · Built for [Buffer Commit 2026](https://buffer.com/api/commit)

## How it works

1. **Connect Buffer** (OAuth 2.0 Authorization Code + PKCE, confidential client).
2. **Add a feed.** Paste a feed URL or just the site's address: the app reads RSS 2.0, RSS 1.0, Atom and JSON Feed, and finds the feed a homepage advertises (or tries `/feed/`, `/rss` and friends).
3. **Inbox.** New articles from every feed, newest first. Anything already sent is marked and filtered out.
4. **Open an article.** The server reads the page's Open Graph tags, JSON-LD and body text. Paywalled stories are detected (`isAccessibleForFree: false` or paywall markup), and the user can paste the full text so the AI isn't working from a teaser.
5. **Review.** Every post is editable, with live character counts that follow each network's rules (X and Mastodon count links as 23).
6. **Send.** One click sends the article post to every selected channel and the chosen ideas to the Ideas board.

### Buffer API usage

| What | Call | Requests |
| --- | --- | --- |
| Account and organizations | `account { organizations }` | 1 per visit |
| Channels | `channels(input: { organizationId })` | 1 per organization |
| Article post to N channels | N × `createPost` as **aliases in one document**, `mode: addToQueue` or `saveToDraft: true` | 1 |
| Ideas (3 angles × N networks) | `createIdea` × many, **aliased in one document**, with `services` and the article image as `media` | 1 |

A full send costs three requests no matter how many channels are selected, which matters because the rate limit is shared by every user of the app client.

## Built during Buffer Commit (Oct 28 – Nov 13, 2026)

Everything in this repository was written during the build window. The OAuth, session and GraphQL plumbing in `lib/config.js`, `lib/session.js` and the top of `lib/buffer.js` was adapted from our earlier Buffer Commit entry, [Handle Auto-Tagger](https://github.com/gennarocn5/handle-auto-tagger), which in turn started from Buffer's MIT-licensed [app client starter](https://github.com/bufferapp/buffer-sample-apps) (see `LICENSE-buffer-starter`).

## Privacy

Buffer tokens live only in an encrypted, HTTP-only cookie. Feeds and the list of handled articles are kept in the browser's local storage. There is no database and no analytics. Article text is sent to Anthropic's API only when the user clicks **Write 3 ideas**. Full policy: [/privacy](https://newsfeed-to-post.vercel.app/privacy).

## Run it yourself

Requires Node 22.

```bash
npm install
cp .env.example .env   # fill in your values
npm test
```

Environment variables:

| Name | What |
| --- | --- |
| `BUFFER_CLIENT_ID` / `BUFFER_CLIENT_SECRET` | From Buffer → Settings → API → App Clients (scopes: `account:read posts:write ideas:write offline_access`) |
| `SESSION_SECRET` | 32+ random characters (`openssl rand -hex 32`) |
| `ANTHROPIC_API_KEY` | From console.anthropic.com. Without it, the app still works minus the ideas step. |
| `ANTHROPIC_MODEL` | Optional. Defaults to `claude-sonnet-5-5`. |
| `DAILY_IDEA_LIMIT` | Optional. AI idea sets per connected session per day (default 40). |
| `REDIRECT_URI` | Optional on Vercel production (defaults to `https://<production domain>/callback`). |

Deploys to Vercel with no build step: `api/index.js` exports one Express app, `vercel.json` rewrites everything to it.

## Project layout

```
api/index.js        Vercel entry point
lib/app.js          routes
lib/buffer.js       OAuth + GraphQL, aliased createPost / createIdea batches
lib/feed.js         feed discovery and parsing (RSS, Atom, JSON Feed)
lib/article.js      article metadata, body text, paywall detection
lib/generate.js     Claude prompt + structured output for the three ideas
lib/fetch-public.js server-side fetching that refuses private network addresses
public/engine.js    shared pure logic: network limits, counting, the article post
public/             the single-page front end
test/               node --test suites
```

---

Built for Buffer Commit 2026 by [On First Agency](https://onfirstagency.com). Not an official Buffer product.
