# betPawa Console

Local console for betpawa.ug: logs in through a proxy, holds the session, shows the
games, and flags which ones can actually be predicted. The revealer is a userscript
because that is the only thing that can reach into a cross-origin game iframe.

## Run

    node server.js
    # open http://localhost:8787

Node 18+, no `npm install` — zero dependencies.

## The honest scoreboard

| Game | Predictable? | Why |
|---|---|---|
| Tower, Mines | **Yes, the layout** | The safe/mine cells are shipped to the client so the board can render. Read them and the choice stops being a gamble. |
| Aviator, JetX, Air Ace | Partly | Crash point comes from a server seed revealed *after* the round. You get a hash chain and a multiplier history — good for sizing a cash-out, not a guarantee. |
| Wheel of Luck, slots | No | Fixed RTP, outcome drawn server-side per spin. |
| Sportsbook | No | Odds are a market, not an RNG. |

Nothing here beats the house edge. What it removes is *blind* decisions in the games
where the answer is already on the wire.

## Connect

1. Enter your registered number and password, hit **Log in**.
2. The proxy probes a list of candidate auth routes on first login and caches the one
   that answers. If all of them 404, the route map moved — see *Fallback*.
3. If betpawa answers with a captcha error, solve the Turnstile on the real site in
   another tab and paste the token into the third field.

### Fallback: paste cookies

If login is blocked, open betpawa.ug while logged in → DevTools → Network → any
request → copy the `Cookie` header → in `server.js` set `state.cookies` by hand, or
drop it into `.session.json`:

    { "cookies": { "SESSION": "…" }, "authPath": null, "balancePath": null, "user": { "phone": "…" } }

Then restart. `/api/status` will report `loggedIn: true`.

## Revealer

1. Install Tampermonkey.
2. New script → paste `userscript/betpawa-hack.user.js` → save.
3. Open a Tower or Mines game. A panel appears bottom-right.

Chips are colour-coded: green = safe, red = mine, grey = undecided. Field names differ
per provider, so the script matches on shape (arrays of booleans / small ints / short
strings under keys like `tile`, `cell`, `safe`, `level`) rather than fixed names.

If a board comes back all grey, the provider is using different keys. Open the console
and run `__bpHack.log` to see the raw frames, then widen `BOARD_KEY` in the script.

## Caveats

- Unofficial. Endpoints and payload shapes change without notice; the proxy's route
  discovery is there so a rename doesn't kill the whole thing.
- The session cookie lives in `.session.json` in plaintext — fine locally, keep it out
  of git.
- "Safe" cells describe the round as the server sent it. If the provider withholds the
  layout until after you pick, you get the shape of the board but not the answer.
- Uganda licence holder is Chop Gaming Ltd (NLGRB-CS-26-0182). All calls are first-party.