# RINGOUT

Server-authoritative physics arena for 2–4 players. Three.js client, SpacetimeDB module as the only server.

> Status: playable, deployed, and measured. Every number below was produced by
> a command or URL named next to it; nothing here is an estimate.

**[Play it](https://independent-scientist.github.io/ringout/)** — no install, and two browser tabs are two
players. **Netcode write-up:** [`docs/netcode.md`](docs/netcode.md). **Demo:** [70-second clip
(mp4)](docs/media/demo.mp4) of one full match on the deployed build.

![A round on the deployed build: four robots converging, an elimination, and the round banner](docs/media/hero.gif)

On a phone it locks to landscape and gives you a stick and a shove button:

![RINGOUT on a 844x390 phone viewport with the touch stick and shove button](docs/media/phone-landscape.png)

*That capture has the 250 ms latency shim switched on, which is why the HUD reads 769 ms end to end; the shim is
wired into both directions and the same slider is how the correction counters get measured.*

## What it is

Up to four robots stand on a disc that shrinks. No weapons, no health bars. You shove; the floor decides who
stays. Best of three rounds, ninety seconds per round.

## What is actually hard here

- **Server authority at 30 Hz.** Every position, impulse and elimination is computed in a SpacetimeDB module
  (`module/src/sim/step.ts`), driven by a schedule table. The client never decides.
- **Prediction and rollback measured under packet loss.** Your own body moves the instant you press a key; when
  the server's state arrives, unacknowledged inputs are replayed from the server's version and the visual error
  is smoothed away. The HUD splits reconciliations into `ack` corrections (a server row disagrees with the
  replayed single-body prediction — the netcode error) and `contact` corrections (the server applied a body-body
  collision or shove impulse the client deliberately does not predict — the design trade-off).
  At 250 ms one-way: a clean orbit produces `0 ack / 0 contact`; a 4-player brawl produces `~618 contact/min`,
  which is the physics working, not the netcode failing; and with `10%` of inputs dropped plus `500 ms` stalls
  every 5 s (`?autopilot=250&chaos=10&pin=1`) the ack rate is `33 per 30 s` with `0` snaps, recovering to
  `0 corr/min` within 2 s of the chaos stopping. Inputs are sent with the previous unacked frame attached, so a
  single lost packet costs nothing.
- **A latency simulator you can toggle.** 0 / 100 / 250 ms one-way, wired through both directions, with the
  resulting correction rate on screen. The hard part is observable on purpose.
- **One integrator, two runners.** The browser imports the module's simulation file through a Vite alias, so
  prediction cannot drift from authority by construction.

## Architecture

![RINGOUT architecture: a SpacetimeDB module and a Three.js client that share one simulation file](docs/media/architecture.svg)

The module owns the world: `player`, `match`, `match_score`, `body`, `input_frame`, `event` and the
`match_tick` schedule, written by the reducers (`join_lobby`, `create_match`, `join_match`, `set_ready`,
`start_match`, `submit_inputs`) and by the 30 Hz tick. Body rows stream to the browser over the WebSocket; the
client interpolates other players, predicts its own body, and renders. Both runners import
`module/src/sim/step.ts`, so prediction and authority cannot diverge by construction. The diagram's source is
[`docs/diagrams/architecture.html`](docs/diagrams/architecture.html).

## Measured metrics

Each row names how it was produced; the longer version, including what was rejected and why, is
[`docs/netcode.md`](docs/netcode.md).

| Metric | Value |
| --- | --- |
| Server tick | 33.33 ms mean, σ 1.15–2.51 ms (4 bots, 45 s) |
| Determinism | 1000 ticks, byte-identical state |
| Corrections at 250 ms, 0 % / 10 % input loss | 0 / 33 ack corrections per 30 s, 0 snaps |
| Contact corrections, 4-player brawl | ~618/min (not netcode error — see netcode.md) |
| Mean correction magnitude | 11.1 cm contact, 18–24 cm under chaos |
| Throughput, 3–4 players | 100–180 rows/s per client |
| Client bundle | 190.08 kB gzip |
| Frame time, laptop iGPU | 1.22 ms mean, 59.6 fps, 24 draw calls |
| RTT, Brazil → maincloud | 157–176 ms steady state |

## Design decisions, and what I rejected

- **Hand-rolled 2D capsule physics instead of Rapier/cannon.** The game is a top-down disc; a full 3D engine
  buys nothing and costs determinism, bundle size and server-copy complexity. The sim is ~120 lines.
- **Float32 simulation + reconciliation instead of fixed-point determinism.** Drift is absorbed by rollback;
  fixed-point would have cost a month for a benefit this game does not need. Documented in `docs/netcode.md`.
- **No client-side hit prediction.** Shove results come from the server only. Intent (wind-up, aim) is local.
  This trades ~RTT of feedback on impacts for the elimination of the worst mispredict class.
- **Row deltas, not snapshots.** Each body row carries `server_tick` and `last_seq`, so reconciliation needs no
  side channel and no per-tick snapshot table.

## Run it locally

```bash
spacetime start
spacetime publish ringout-dev --server local --delete-data=always --yes
spacetime generate --lang typescript --out-dir client/src/module_bindings --module-path module
npm install && npm run dev --workspace client      # http://localhost:5173
```

To test two players on one machine, open a second tab at `http://localhost:5173/?slot=2` — plain tabs share
localStorage and would be the same identity.

Requirements: Node 20+, the `spacetime` CLI, a WebGL2 browser. Controls: WASD to move, arrow keys to aim (with no
aim held you shove the way you were last moving), hold space to charge a shove, release to fire. Touch: left stick
to move and aim, right button to shove.

## Repo layout

`module/` server · `client/` browser · `shared/` constants · `tools/` harnesses · `docs/` architecture and
netcode.

## License

MIT (code). Asset credits in `docs/media/CREDITS.md`.
