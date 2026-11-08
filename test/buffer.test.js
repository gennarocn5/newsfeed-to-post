import { test } from 'node:test'
import assert from 'node:assert/strict'
process.env.BUFFER_CLIENT_ID ||= 'test-client'
const { GqlEnum, buildCreateIdeasMutation, buildCreatePostsMutation, buildIdeaInput, buildPostInput, gqlLiteral } = await import('../lib/buffer.js')

test('GraphQL literals escape strings and leave enums bare', () => {
  assert.equal(gqlLiteral({ a: 'say "hi"\n', b: [new GqlEnum('twitter')], c: null }), '{ a: "say \\"hi\\"\\n", b: [twitter], c: null }')
  assert.throws(() => new GqlEnum('bad value'))
  assert.throws(() => gqlLiteral({ 'bad key': 1 }))
})

test('idea input carries services and image media', () => {
  const input = buildIdeaInput({ organizationId: 'o1', title: 'Angle — X', text: 'Body', services: ['twitter'], imageUrl: 'https://i/x.png' })
  const doc = buildCreateIdeasMutation([input, input])
  assert.match(doc, /i0: createIdea\(input: \{ organizationId: "o1", content: \{ title: "Angle — X", text: "Body", services: \[twitter\], media: \[\{ url: "https:\/\/i\/x.png", type: image \}\] \} \}\)/)
  assert.match(doc, /i1: createIdea/)
})

test('post inputs: drafts, required metadata, aliased mutation', () => {
  const ig = buildPostInput({ channelId: 'c', service: 'instagram', text: 't', imageUrl: 'https://i/x.png', when: 'draft' })
  assert.equal(ig.saveToDraft, true)
  assert.deepEqual(ig.metadata, { instagram: { type: 'post', shouldShareToFeed: true } })
  assert.deepEqual(ig.assets, [{ image: { url: 'https://i/x.png' } }])
  const x = buildPostInput({ channelId: 'c', service: 'twitter', text: 't' })
  assert.equal(x.metadata, undefined)
  assert.equal(x.saveToDraft, undefined)
  assert.match(buildCreatePostsMutation(2), /mutation CreatePosts\(\$p0: CreatePostInput!, \$p1: CreatePostInput!\)/)
})
