# Traky Wins Poll

Season-long NFL wins pool: 10 drafters, 3 teams each, 1 point per regular-season win.

**Site:** https://christianlcurry.github.io/traky-wins-poll/

See [NFL Wins Pool — Requirements.md](NFL%20Wins%20Pool%20—%20Requirements.md) for the full spec.

## How it runs

A GitHub Action ([.github/workflows/weekly.yml](.github/workflows/weekly.yml)) runs every Tuesday around 5am ET. It:

1. Fetches every 2026 regular-season result from ESPN (nflverse as a fallback)
2. Recomputes the whole season from Week 1
3. Commits `data/results.json` and `data/standings.json` if anything changed
4. Builds the Astro site and deploys it to GitHub Pages

A missed or failed week fixes itself on the next run.

## Commissioner cheat sheet

| Task | How |
| --- | --- |
| Re-run now | Actions tab → *Update standings and deploy* → **Run workflow** |
| See where a point came from | `data/results.json`, one row per completed game |
| Undo a bad update | `git revert` the "Standings through Week N" commit and push |
| New season | Update `data/rosters.json` (season + teams, using ESPN abbreviations) |

## Local development

```sh
npm install
npm run update   # fetch results, rewrite data/*.json
npm run dev      # http://localhost:4321/traky-wins-poll/
```

`npm run update -- --source=nflverse` forces the fallback source.
