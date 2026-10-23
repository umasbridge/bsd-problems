# bsd-problems

Standalone vanilla JS app for the "My Problems" section of the BSD bridge app.
Served at `/bridge-problems/viewer.html` inside bsd-app.

## Files

- `viewer.html` — main app: all layout, CSS, render functions (renderProblemStage, mountPlayTable, renderDeal, etc.)
- `editor.js` — problem editor UI: tabs, panels, drag/drop
- `db.js` — Supabase client and all data access
- `lin.js` — LIN format parsing
- `play.js` — seat helpers and LIN deal/auction parsing (`globalThis.bpPlay`)
- `problem-player.js` — mounts the problem table: BridgePlayer for played-out problems, DealViewer otherwise
- `sql/` — schema reference (not served)

## Auth

Same-origin with bsd-app (served under the same domain), so the Supabase session
from localStorage is picked up automatically. No separate login needed.

## Dependencies

The problem table comes from bsd-app's `/bridge-lib` (ES modules, loaded at runtime):
`bridge-player/BridgePlayer.js` (user vs computer play), `deal-viewer/DealViewer.js`
(view / step through a deal), sharing `bridge-common/` and the `dds/` solver.

## After making changes here

This repo is consumed by bsd-app as a GitHub npm package. After editing:

```bash
# 1. Commit and push
git add -A
git commit -m "your message"
git push

# 2. Get the new commit hash
git rev-parse HEAD

# 3. In bsd-app/package.json, update the hash:
#    "bsd-problems": "github:umasbridge/bsd-problems#<new-hash>"

# 4. In bsd-app:
npm install
```

Then deploy bsd-app as normal (`npx --yes vercel --prod --force` from bsd-app).
