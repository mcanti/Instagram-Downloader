# Repository Guidelines

## Project Structure & Module Organization

This repository is a Manifest V3 browser extension. Runtime code lives in `src/js/`, with page/content-script modules at the top level and page-context integrations under `src/js/global/`. Shared styling is in `src/style/style.css`. The extension manifest is `manifest.json`; icons are in `icons/`, and the vendored Cookie helper is in `lib/`. Release and version helpers are in `scripts/`, while design notes and implementation plans are in `docs/`. There is currently no dedicated test directory.

## Build, Test, and Development Commands

- `make format` — format `src/` with the repository’s Prettier configuration.
- `make format-check` — verify formatting without modifying files; this is the CI check.
- `npx --yes prettier --check ./src` — run the formatting check directly when Make is unavailable.

There is no bundler or compilation step. For local testing, load the repository folder as an unpacked extension (`chrome://extensions/` in Chromium browsers) or load `manifest.json` as a temporary add-on in Firefox, then exercise posts, reels, stories, overlays, and downloads on Instagram.

## Coding Style & Naming Conventions

Use four spaces, LF line endings, semicolons, single quotes, and a 120-character print width, as defined in `.prettierrc.json`. Run `make format` before committing. Use lowercase kebab-case for filenames (for example, `media-overlay-handler.js`), descriptive camelCase for JavaScript variables/functions, and preserve the existing `IG_` constants because the README identifies them as compatibility-sensitive. Keep global-page scripts separate from content-script modules.

## Testing Guidelines

Automated tests are not configured. Every change should pass `make format-check` and be manually verified in a supported Chromium browser and, where relevant, Firefox. Check the affected Instagram surfaces and confirm download behavior, overlay visibility, keyboard shortcuts, and console errors. If adding tests, place them in a clearly named test directory and document the runner and command in this file.

## Commit & Pull Request Guidelines

Recent commits use short, imperative, lowercase subjects such as `download all`, `fix: ...`, and `feat: ...`; follow that style and keep each commit focused. PRs should complete `.github/pull_request_template.md`: describe the objective, classify release notes as `N/A` or `Added/Fixed/Improved`, explain manual validation, and include screenshots or recordings for UI changes. Link the relevant issue when one exists.

## Security & Configuration Tips

Do not broaden `host_permissions` or expose credentials. Changes to `manifest.json`, injected scripts, network tracking, or download handling require extra review because they run on Instagram pages and process user media.
