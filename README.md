# 📡 Repo Radar

A GitHub dashboard for people who ship Claude Code plugins and small apps. It comes in two parts that share one data file:

- **The widget:** a small always-on-top window for Windows and macOS.
- **The mod:** a Claude Code plugin with a `/repos` pane, toasts, and `/repos widget` to open the widget.

**Install the mod and you get both.** On your first session it downloads the widget's installer for you. After that, the widget opens beside every session.

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
  - plugins and marketplaces that fail `claude plugin validate`, checked on what's on GitHub
  - READMEs that name an older version than your latest release
  - public repos missing a description, topics, a license or a README, so people can find them

  Each item has a button that opens **Claude Code** in that repo with the task written out: 🔧 Fix, 👀 Review or 🚢 Ship it. Claude works in a branch and asks before it pushes, comments, merges or publishes. ✓ Done hides an item, and ✓ Close closes an issue.
- **Tiles and a 30-day chart:** stars, lifetime clones, release downloads and CI status. Clones count outside people only: unique cloners, without your CI builds or your own machine.
- **🧩 Plugins · 📦 Apps · 🗂 Other:** your repos, sorted by what they are. Each row shows only the numbers that matter for its kind, plus this week's trend. Open a repo for its chart, where visitors came from, and the pages they read.
- **⭐ Following:** repos you've starred or watch. New releases get a NEW badge, and Windows or macOS notifies you about repos you watch. If a repo has a plugin, marketplace or skill, **Install** shows the exact commands first, then runs them.
- **Lifetime history:** GitHub keeps only 14 days of traffic. Repo Radar saves every day of clones, views and referrers, so your totals keep growing.
- **Notifications** for new stars, forks, issues and releases, and 🎉 milestones.

## Install

In Claude Code:

```
/plugin marketplace add J-M-Pineapple-Express/repo-radar
/plugin install repo-radar@repo-radar
```

Start a new session and the widget's installer opens: click through it, and the widget appears. From then on it opens with each session. It updates itself on Windows, and points you to the new release on macOS.

- `/repos` opens the pane in Claude Code, with the same ⚠️ Needs Attention list.
- `/repos widget` opens the widget, or installs it if it isn't there.
- Don't want it opening every session? Turn off **Open the widget with each session** in `/config`.
- On macOS, drag Repo Radar to Applications. The first time, right-click it and choose **Open**, since the app isn't signed.

Prefer the widget alone? Download it from [Releases](https://github.com/J-M-Pineapple-Express/repo-radar/releases): `RepoRadar-Setup-x.y.z.exe` for Windows, `RepoRadar-x.y.z-arm64.dmg` (Apple silicon) or `-x64.dmg` (Intel) for macOS.

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
