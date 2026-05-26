# Agent Rules

- This app calculates BELT attendance according to Microsoft's attendance checking rules.
- It finds the best 8 weeks within the last 12 weeks, where "best" means the highest number of attended days.
- It then averages attendance across those selected 8 weeks.
- A week is counted as compliant only if it passes the 3/5 threshold.
- Always run `npm run typecheck` and fix type errors, then run `npm run format` after every change so lint and format fixes are applied in write mode.
