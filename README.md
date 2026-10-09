# 📡 Repo Radar

A GitHub dashboard for people who ship Claude Code plugins and small apps. It comes in two parts that share one data file:

- **The widget:** a small always-on-top window for Windows and macOS.
- **The mod:** a Claude Code plugin with a `/repos` pane, toasts, and `/repos widget` to open the widget.

It sweeps every repo of every account the [GitHub CLI](https://cli.github.com) is signed into.

## What it shows

- **⚠️ Needs Attention,** your to-do list:
  - failing CI
  - Dependabot security alerts
  - releases missing files the previous release had
  - plugin versions that don't match across `plugin.json`, your marketplace's copy and the latest release
  - issues waiting on your reply, longest wait first
  - open PRs
  - work committed since your last release

  Each item has a button that opens **Claude Code** in that repo with the task written out: 🔧 Fix, 👀 Review or 🚢 Ship it. Claude works in a branch and asks before it pushes, comments, merges or publishes. ✓ Done hides an item, and ✓ Close closes an issue.
- **Tiles and a 30-day chart:** stars, lifetime clones, release downloads and CI status.
- **🧩 Plugins · 📦 Apps · 🗂 Other:** your repos, sorted by what they are. Each row shows only the numbers that matter for its kind, plus this week's trend. Open a repo for its chart, where visitors came from, and the pages they read.
- **⭐ Following:** repos you've starred or watch. New releases get a NEW badge, and Windows or macOS notifies you about repos you watch. If a repo has a plugin, marketplace or skill, **Install** shows the exact commands first, then runs them.
- **Lifetime history:** GitHub keeps only 14 days of traffic. Repo Radar saves every day of clones, views and referrers, so your totals keep growing.
- **Notifications** for new stars, forks, issues and releases, and 🎉 milestones.

## Install

**The widget:** download the installer for your system from [Releases](https://github.com/J-M-Pineapple-Express/repo-radar/releases):
- Windows: `RepoRadar-Setup-x.y.z.exe`
- macOS: `RepoRadar-x.y.z-arm64.dmg` (Apple silicon) or `-x64.dmg` (Intel)

**The mod:** in Claude Code:

```
/plugin marketplace add AfterRealm/marketplace
/plugin install repo-radar@afterrealm
```

Then type `/repos` for the pane, or `/repos widget` to open the widget.

**Both need the GitHub CLI signed in:** run `gh auth login`. Sign in to more than one account and Repo Radar shows them all.

## Privacy

Everything stays on your computer. Repo Radar talks only to GitHub, using the tokens `gh` already has, and never writes them to disk. Your history lives in `~/.claude/repo-radar/data.json`.

## Build it yourself

```
cd widget
npm install
npm start          # run the widget
npm run dist:win   # or dist:mac, to build installers
```

The mod is in `mod/`. Load it while developing with `claude --plugin-dir mod`.

## License

MIT
