export type Health = 'green' | 'yellow' | 'red' | 'archived'

export type Repo = {
  name: string
  owner: string
  url: string
  isPrivate: boolean
  isFork: boolean
  stars: number
  forks: number
  issues: number
  prs: number
  release: string | null
  pushedAt: string | null
  language: string | null
  languageColor: string | null
  health: Health
  canPush: boolean
  traffic?: Traffic
}

/** `clones` is the last 14 days, oldest first; the lifetime totals count every day on record since `since`. */
export type Traffic = { clones: number[]; clonesLifetime: number; viewsLifetime: number; since: string | null }

/** Counts per repo at one moment, kept across sessions to say what changed. */
export type Ledger = {
  at: number
  repos: Record<string, { stars: number; forks: number; issues: number; release: string | null }>
}

export type Account = { host: string; login: string; repos: Repo[]; error?: string }

/** `watchedSince`: the first day Repo Radar's own traffic history covers (views have no older source). */
export type Snapshot = { accounts: Account[]; fetchedAt: number; trafficAt: number; watchedSince: string }

export type Status = 'idle' | 'loading' | 'ready' | 'no-auth' | 'error'

declare module 'claude-code' {
  interface PluginState {
    'repo-radar': {
      snapshot: Snapshot | null
      status: Status
      message: string
      expanded: string[]
      digest: string
      hidden: string[]
    }
  }
}
