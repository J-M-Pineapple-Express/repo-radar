import { expect, test } from 'claude-code/testing'

import type { Repo, Snapshot } from '../types'
import { assetShape, changes, describe, importTracker, lifetime, mergeHistory, missingAssets, perDay, record, summarize, toLedger } from './lib'
import type { History } from './lib'

const repo = (over: Partial<Repo>): Repo => ({
  name: 'radar',
  owner: 'me',
  url: '',
  isPrivate: false,
  isFork: false,
  stars: 0,
  forks: 0,
  issues: 0,
  prs: 0,
  release: null,
  pushedAt: null,
  language: null,
  languageColor: null,
  health: 'green',
  canPush: true,
  ...over,
})

const snap = (repos: Repo[], at = 0): Snapshot => ({
  accounts: [{ host: 'github.com', login: 'me', repos }],
  fetchedAt: at,
  trafficAt: at,
  watchedSince: '2026-01-01',
})

test('spots new stars, forks, issues and releases, and ignores brand-new repos', () => {
  const before = toLedger(snap([repo({ stars: 2, release: 'v1.0.0' })]))
  const after = snap([repo({ stars: 5, forks: 1, issues: 1, release: 'v1.1.0' }), repo({ name: 'fresh', stars: 9 })])
  const lines = changes(before, after).map(describe)
  expect(lines).toEqual([
    '⭐ +3 stars on radar',
    '🍴 radar was forked',
    '🐛 1 new issue on radar',
    '🚀 radar shipped v1.1.0',
  ])
  expect(summarize(changes(before, after), 47)).toBe('+3 ⭐ · +1 🍴 · 1 new issue · 1 release 🚀 · 47 clones')
  expect(summarize([], 0)).toBe('all quiet')
})

test('flags a release missing an asset the previous release had', () => {
  const previous = ['App-Setup-1.2.0.exe', 'App-1.2.0.dmg', 'latest.yml', 'latest-mac.yml']
  const latest = ['App-Setup-1.3.0.exe', 'App-1.3.0.dmg', 'latest.yml']
  expect(missingAssets(latest, previous)).toEqual(['latest-mac.yml'])
  expect(missingAssets(previous, previous)).toEqual([])
  expect(assetShape('app-1.2.3.exe')).not.toBe(assetShape('app-1.2.3.dmg'))
})

test('maps traffic onto fixed days', () => {
  const keys = ['2026-10-01', '2026-10-02', '2026-10-03']
  const values = perDay([{ timestamp: '2026-10-03T00:00:00Z', count: 8 }, { timestamp: '2026-10-01T00:00:00Z', count: 4 }], keys)
  expect(values).toEqual([4, 0, 8])
})


test('remembers traffic past GitHub 14-day window and adds up a lifetime', () => {
  const history: History = {}
  const entry = (history['me/radar'] ??= { clones: {}, views: {} })
  // Scan in week one, then a later scan whose window has moved on.
  record(entry.clones, [{ timestamp: '2026-09-01T00:00:00Z', count: 5 }, { timestamp: '2026-09-02T00:00:00Z', count: 3 }])
  record(entry.clones, [{ timestamp: '2026-09-02T00:00:00Z', count: 4 }, { timestamp: '2026-09-20T00:00:00Z', count: 10 }])
  record(entry.views, [{ timestamp: '2026-09-03T00:00:00Z', count: 7 }, { timestamp: '2026-09-04T00:00:00Z', count: 0 }])
  expect(lifetime(entry)).toEqual({ clones: 19, views: 7, since: '2026-09-01' })
  expect(Object.keys(entry.views)).toEqual(['2026-09-03'])

  const merged = importTracker(history, { by_repo: { 'me/radar': { days: { '2026-08-30': 2, '2026-09-01': 5 } }, 'me/other': { days: {} } } })
  expect(merged).toEqual({ repos: 1, days: 2 })
  expect(lifetime(history['me/radar'])).toEqual({ clones: 21, views: 7, since: '2026-08-30' })
  expect(() => importTracker(history, { nope: 1 })).toThrow('by_repo')
})

test('mergeHistory keeps every day from both sides and the larger count', () => {
  const mine: History = { 'me/a': { clones: { '2026-10-01': 2, '2026-10-02': 1 }, views: {} } }
  const theirs: History = { 'me/a': { clones: { '2026-10-02': 4, '2026-10-03': 1 }, views: { '2026-10-03': 7 } }, 'me/b': { clones: { '2026-10-01': 1 }, views: {} } }
  mergeHistory(mine, theirs)
  expect(mine['me/a']).toEqual({ clones: { '2026-10-01': 2, '2026-10-02': 4, '2026-10-03': 1 }, views: { '2026-10-03': 7 } })
  expect(mine['me/b']?.clones).toEqual({ '2026-10-01': 1 })
  expect(mergeHistory({}, undefined)).toEqual({})
})
