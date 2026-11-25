# Forever AH

Auction house tracker + web UI for WoW: Forever. Requires Node 22.5+ (uses built-in `node:sqlite`), no npm dependencies.

## Run it

```sh
npm run collect            # keep this running: polls the AH every POLL_MINUTES and stores snapshots
npm start                  # web UI at http://localhost:3000
npm run sync:professions   # one-time (~2 min): downloads every profession recipe + reagents
```

`.env` needs `BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET`. Optional: `REGION`, `RULESET_ID`, `HOUSES`, `POLL_MINUTES`, `PORT`, `DB_PATH`.

## What's in the UI

- **Market** – every listed item on the selected house: min/median buyout, 24h change, quantity, estimated sales, market value. Sortable and filterable. Press `/` anywhere to search any item.
- **Item page** – stock-style chart (min/median/mean price lines, listed-quantity and sold-volume bars, 24h/7d/30d/all), comparison across houses, item tooltip and vendor prices, recipes that craft it or use it, and a per-snapshot history table.
- **Professions** – search every recipe by name, crafted item, or reagent. Craft cost vs. sell value at live AH prices (min or median), profit after the 5% AH cut, margin, and demand. Filter to recipes a saved character knows.
- **Characters** – equipped gear and professions (with known recipes) from the Blizzard profile API.

## Sales are estimated

Blizzard's API has no sales data. The collector diffs each snapshot against the previous one: an auction that disappears sooner than its `time_left` bucket allows to expire is counted as sold, as are partial commodity buys. Cancellations look identical to sales, so treat the numbers as an upper bound. Estimates start after two consecutive collector runs.

## Characters: Battle.net login

"Log in with Battle.net" imports every character on your account. It needs a one-time setup: at https://develop.battle.net/access/clients, open your client and add this **Redirect URL**:

```
http://localhost:3000/auth/callback
```

Without it you can still add characters by name + realm slug.
