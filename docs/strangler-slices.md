# Strangler slices for `src/App.tsx` (ISP-100 / #770)

`src/App.tsx` is the landing shell (nav + hero). Larger emergency UI lives in
`src/pages/Help.tsx` / `Help.jsx` and must stay last.

## Ordered slices

| Order | Slice | Blast radius | Done criteria | Status |
|------:|-------|--------------|---------------|--------|
| 1 | Nav | low | Typed props, no inline hex, flag `slice_nav` | extracted |
| 2 | Hero | low | Typed props, reveal contract, flag `slice_hero` | extracted |
| 3 | Footer | low | Shared layout footer or landing footer | planned |
| 4 | Trust | low | Tokenised cards | planned |
| 5 | Features | medium | Snapshot tests | planned |
| 6 | Map | high | Pin-sync with CommunityMap | planned |
| 7 | Help | critical | Dual-run shadow verify, last | planned-last |

## Coexistence flags

Set in `public/config.json` or via `VITE_FLAG_SLICE_NAV=true`:

- `slice_nav` — use `NavSection` (default on)
- `slice_hero` — use `HeroSection` (default on)

Turning a flag off falls back to the inlined legacy markup in `App.tsx`.

## Tokens

All extracted slices import colours from `src/theme/tokens.ts`. New hex in
`src/components/sections/` is a regression.
