# bsd-problems

Standalone vanilla JS app for the "My Problems" section of the BSD bridge app.
Served at `/bridge-problems/viewer.html` inside bsd-app.

## Files

- `viewer.html` — main app: all layout, CSS, render functions (renderProblemStage, renderDeal, renderBidding, etc.)
- `editor.js` — problem editor UI: tabs, panels, drag/drop
- `db.js` — Supabase client and all data access
- `lin.js` — LIN format parsing
- `play.js` — card play logic
- `playset.js` — play set management
- `problem-player.js` — card play UI
- `sql/` — schema reference (not served)

## Auth

Same-origin with bsd-app (served under the same domain), so the Supabase session
from localStorage is picked up automatically. No separate login needed.

## Dependencies

Uses `../bridge-lib/ips/` for the IPS card play engine (loaded as browser script tags).

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
