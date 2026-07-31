# Contributing to Messenger Desktop (Unofficial)

Thanks for taking the time to contribute. This project is a small, security-focused
Electron wrapper around messenger.com, and every contribution — a bug report, a
typo fix, a new theme, or a feature — is welcome.

By participating, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Table of Contents

- [Ways to Contribute](#ways-to-contribute)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Coding Standards](#coding-standards)
- [Security Rules for Contributors](#security-rules-for-contributors)
- [Commit Messages](#commit-messages)
- [Pull Request Process](#pull-request-process)
- [Building Installers](#building-installers)
- [Release Process](#release-process)

---

## Ways to Contribute

You don't need to write code to help:

- **Report a bug** you hit while using the app
- **Test a release** on a platform the maintainer can't easily reach (macOS, ARM Linux, Windows on ARM)
- **Improve the docs** — the README, this file, or the [website](https://github.com/WinTer1165/Webpage-for-Messenger-Desktop-Client-Unofficial)
- **Fix a bug** or **build a feature** from the issue tracker
- **Add a theme** — themes live in the renderer and are self-contained

If you're looking for somewhere to start, check the
[open issues](https://github.com/WinTer1165/Messenger-Desktop-Client-Unofficial/issues).

---

## Reporting Bugs

Search the [existing issues](https://github.com/WinTer1165/Messenger-Desktop-Client-Unofficial/issues)
first — someone may have already reported it.

**Do not open a public issue for a security vulnerability.** Follow the
[Security Policy](SECURITY.md) instead.

A good bug report includes:

- **App version** — from the title bar's About button, or the installer filename
- **Operating system and architecture** — e.g. "Windows 11 24H2 x64", "macOS 15 Apple Silicon", "Ubuntu 24.04 x86_64"
- **How you installed it** — installer, portable zip, dmg, AppImage, or deb
- **What you did**, step by step, so someone else can reproduce it
- **What you expected** versus **what actually happened**
- **Screenshots or a screen recording**, if the problem is visual
- **Console output**, if the app misbehaves — launch it from a terminal to see the logs:

  ```bash
  # Windows (Git Bash / PowerShell), from the install directory
  "./Messenger Desktop (Unofficial).exe"

  # macOS
  "/Applications/Messenger Desktop (Unofficial).app/Contents/MacOS/Messenger Desktop (Unofficial)"

  # Linux
  ./Messenger-Desktop-Unofficial-*.AppImage
  ```

Messenger's web app changes often, and breakage frequently traces back to a
markup change on their side. Mentioning when it last worked helps a lot.

---

## Suggesting Features

Open an issue describing:

- **The problem you're trying to solve**, not just the solution you have in mind
- **How you'd expect it to work** in the UI
- **Whether you're willing to implement it** — that's very welcome, but please
  agree on the approach in the issue before writing a large patch

Bear in mind the project's scope: this is a desktop shell around messenger.com.
Features that require scraping, automating, or modifying Messenger's behaviour
beyond presentation are usually out of scope, and tend to break on every
Facebook deploy.

---

## Development Setup

### Prerequisites

- **Node.js 24** (this is what CI builds with — [nodejs.org](https://nodejs.org/))
- **npm** (ships with Node)
- **Git**

### Getting started

```bash
git clone https://github.com/WinTer1165/Messenger-Desktop-Client-Unofficial.git
cd Messenger-Desktop-Client-Unofficial

npm ci          # use `ci`, not `install`, to match the lockfile exactly
npm run build   # compile TypeScript and copy renderer HTML into dist/
npm start       # launch the app
```

`npm run dev` does a build and launch in one step. `npm run build:watch` runs
`tsc --watch` if you'd rather recompile on save and restart the app manually.

> **Windows note:** the `build` script uses `cp` to copy renderer HTML, so run it
> from **Git Bash**, or make sure Git's `usr/bin` directory is on your `PATH`.
> Plain `cmd.exe` has no `cp`.

### Before you push

```bash
npm test   # runs `tsc --noEmit` (typecheck) and `eslint src --ext .ts`
```

Both must pass. You can run them individually with `npm run typecheck` and
`npm run lint`.

---

## Project Structure

```
src/
├── main/                 # Main process — the only place with Node/OS access
│   ├── main.ts           #   App lifecycle, session config, window/view creation
│   ├── window-manager.ts #   Window state persistence (size, position, maximized)
│   ├── ipc-handlers.ts   #   Validated IPC endpoints exposed to the renderer
│   ├── tray.ts           #   System tray icon, unread badge, context menu
│   ├── menu.ts           #   Application menu and keyboard shortcuts
│   ├── settings.ts       #   Persisted settings (theme, minimize-to-tray, DND)
│   └── updater.ts        #   electron-updater wiring
├── preload/              # Context-bridge scripts — the trust boundary
│   ├── preload.ts        #   Bridge for the Messenger web view
│   └── titlebar-preload.ts
├── renderer/             # Custom title bar UI (HTML + TS), no Node access
└── shared/types.ts       # Types shared across processes
```

Build output goes to `dist/`; packaged apps go to `release/`. Both are ignored
by git — never commit them.

Packaging is configured in [`electron-builder.yml`](electron-builder.yml), and
CI lives in [`.github/workflows/build-and-release.yml`](.github/workflows/build-and-release.yml).

---

## Coding Standards

The TypeScript config is strict and ESLint runs `strictTypeChecked`. In practice:

- **No `any`.** `@typescript-eslint/no-explicit-any` is an error. Use `unknown`
  and narrow it, or write a proper type in `src/shared/types.ts`.
- **Annotate return types** on exported functions — it's a warning, but keep the
  build warning-free.
- **`const` by default**, never `var`, and always `===` over `==`.
- **Unused locals and parameters fail the build.** Prefix intentionally unused
  parameters with `_`.
- **No `eval`**, `new Function`, or implied eval — these are hard errors, and
  they're there for a reason (see below).
- Match the surrounding style. Comments should explain *why* something is done,
  not restate what the code says.

---

## Security Rules for Contributors

This app loads a third-party website (messenger.com) inside Electron, so the
process boundaries are load-bearing. A pull request that weakens any of the
following will not be merged without an extremely good reason:

| Setting | Required value | Why |
|---|---|---|
| `contextIsolation` | `true` | Keeps page scripts out of the preload/Node realm |
| `sandbox` | `true` | OS-level renderer isolation |
| `nodeIntegration` | `false` | Web content must never reach Node APIs |
| `webSecurity` | `true` | Keeps the same-origin policy intact |
| `allowRunningInsecureContent` | `false` | No mixed content |

In addition:

- **Don't strip Messenger's Content-Security-Policy.** `main.ts` deliberately
  leaves it in place.
- **Keep the navigation allowlist.** `will-navigate` and `setWindowOpenHandler`
  restrict navigation to Messenger/Facebook domains; external links should open
  in the user's real browser, not in-app.
- **Keep the permission allowlist.** Only the permissions Messenger genuinely
  needs (media, notifications, and friends) are granted; everything else is
  denied and logged.
- **Validate every IPC payload.** Anything crossing from the renderer is
  untrusted input, even though the renderer is ours.
- **Expose the minimum through the context bridge.** Add narrow, specific
  functions — never a generic "call anything" escape hatch.
- **Don't add telemetry, analytics, or any network call to a third party.** The
  app talks to Facebook and to GitHub (for updates), and that's it.

If you're unsure whether a change has security implications, say so in the pull
request — it's much easier to discuss up front.

---

## Commit Messages

Write messages that explain the change and why it was needed:

```
Short summary in the imperative mood, under ~72 characters

Explain what was wrong and why this change fixes it. Wrap the body at
about 72 columns. Reference issues where relevant.

Fixes #123
```

Conventional-commit prefixes (`fix:`, `feat:`, `docs:`, `ci:`, `refactor:`) are
used in parts of the history and are welcome, but not mandatory.

---

## Pull Request Process

1. **Fork** the repository and create a branch off `main`:
   ```bash
   git checkout -b fix/tray-badge-count
   ```
2. **Make your change**, keeping it focused — one logical change per PR. Large
   unrelated reformatting makes review much harder.
3. **Run `npm test`** and make sure it passes.
4. **Test the app manually.** There's no automated UI test suite, so describe in
   the PR what you actually exercised, and on which OS.
5. **Update the docs** if you changed behaviour — the README describes features,
   shortcuts, and settings.
6. **Open the pull request** against `main` with:
   - What changed and why
   - The platform(s) you tested on
   - Screenshots for anything visual
   - `Fixes #N` if it closes an issue

Expect review comments — they're about the code, not about you. Once CI is green
and review is resolved, a maintainer will merge it.

---

## Building Installers

Each target must be built on its own operating system; electron-builder can't
produce macOS builds from Windows or Linux.

```bash
npm run dist:win     # NSIS installer (x64 + ARM64) and unpacked dirs
npm run dist:mac     # .dmg for Apple Silicon and Intel
npm run dist:linux   # AppImage (x86_64, ARM64) and .deb (amd64)
```

Output lands in `release/`. Builds are unsigned unless signing credentials are
configured — see [CREATE_CERTIFICATE.md](CREATE_CERTIFICATE.md) for the Windows
self-signed certificate workflow.

---

## Release Process

Releases are cut by maintainers. Pushing a `v*` tag triggers
[`.github/workflows/build-and-release.yml`](.github/workflows/build-and-release.yml),
which builds on Windows, macOS, and Linux runners and publishes every artifact
to a GitHub Release:

```bash
# after bumping "version" in package.json
git tag v2.1.0
git push origin v2.1.0
```

The release must include the `latest*.yml` files and `.blockmap` files —
`electron-updater` uses them as the update feed and for differential downloads.
Removing them breaks auto-updates for everyone already on an older version.

---

## Questions

- **Bugs and features:** [Issues](https://github.com/WinTer1165/Messenger-Desktop-Client-Unofficial/issues)
- **Everything else:** [Discussions](https://github.com/WinTer1165/Messenger-Desktop-Client-Unofficial/discussions)
- **Security vulnerabilities:** see [SECURITY.md](SECURITY.md) — do not open a public issue

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE) that covers this project.
