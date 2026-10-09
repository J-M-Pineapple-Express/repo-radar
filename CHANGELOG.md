# Changelog

All notable changes to Repo Radar. Versions follow [semver](https://semver.org).

## [0.1.4] - 2026-10-09

### Added
- The widget shows its version next to the title.
- Update notes come with every update. The "ready · Restart" bar lists what's new since your version,
  and after the update a one-time "Updated to X" card shows the same, until you dismiss it.

## [0.1.3] - 2026-10-09

### Added
- The widget updates itself. On Windows it downloads a new release in the background and shows a
  "ready, Restart" bar; it also installs when you quit. On Mac the bar links the new release, since
  macOS can't apply an update to an unsigned app.
  Installs older than 0.1.3 need this one update by hand.

## [0.1.2] - 2026-10-09

### Fixed
- The widget no longer flags a version mismatch with the marketplace copy for up to an hour after a release.
  A sweep that sees a new release now re-reads the marketplace copy and the commits-since-release count right away,
  instead of waiting for the hourly pass.

## [0.1.1] - 2026-10-09

### Fixed
- The mod now installs from this repo, which is its own plugin marketplace:
  `/plugin marketplace add J-M-Pineapple-Express/repo-radar`, then `/plugin install repo-radar@repo-radar`.
  The README's old install commands pointed at a marketplace that didn't list Repo Radar.

## [0.1.0] - 2026-10-08

First release.

- **Widget:** an always-on-top desktop dashboard for Windows and Mac: a "Needs you" strip, star/clone/download/CI tiles, a 30-day clones chart, and Plugins / Apps / Other tabs.
- **Mod:** a Claude Code plugin with a `/repos` pane, toasts for new stars, forks, issues and releases, lifetime clone history, and `/repos widget` to open the widget.

[0.1.4]: https://github.com/J-M-Pineapple-Express/repo-radar/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/J-M-Pineapple-Express/repo-radar/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/J-M-Pineapple-Express/repo-radar/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/J-M-Pineapple-Express/repo-radar/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/J-M-Pineapple-Express/repo-radar/releases/tag/v0.1.0
