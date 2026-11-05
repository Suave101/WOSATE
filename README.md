# WOWATE
Web Open source AADL Tool Environment

WOWATE is a browser-based, static prototype inspired by OSATE, with focused support for AGREE-style contract checks.

## Features
- Runs fully client-side (no backend required)
- GitHub Pages friendly (plain `index.html` + JS + CSS)
- Basic AADL structure checks:
  - `package <name>` present
  - closing `end <name>;` present and matching
- Basic AGREE checks:
  - detects `annex agree {** ... **};`
  - verifies presence of `assume`/`guarantee`
  - warns when contract lines are missing trailing `;`

## Local usage
Open `/home/runner/work/WOWATE/WOWATE/index.html` in a browser, or serve the repository root as static files.

## GitHub Pages deployment
1. Push this repository to GitHub.
2. In repository **Settings → Pages**, set source to **Deploy from a branch**.
3. Select the branch and root folder (`/`).

The app then runs directly on `github.io` as a static site.
