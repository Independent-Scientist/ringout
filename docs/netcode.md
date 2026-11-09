# Netcode

How RINGOUT keeps four players on one disc feeling immediate while a server owns every position. Every number
here was produced by a command or URL named beside it; none of them are estimates.

## The invariants

1. **The module decides.** Position, velocity, impulses, eliminations and the round clock exist only in
   `module/src/`. The client never tells the server where it is; it tells the server what it pressed.
2. **One integrator.** `module/src/sim/step.ts` is imported by the server tick *and* by the browser, through the
   `@sim` Vite alias. There is no second copy of the physics to drift.
3. **Prediction is a view.** The client's predicted body is a guess about the future, never a claim about the
   present. When the server disagrees, the server wins, silently.
4. **The wire carries deltas, not snapshots.** Each `body` row carries `server_tick` and `last_seq`, so a client
   can reconcile from the row itself without a side channel or a snapshot table.

## What travels

**Up:** `submit_inputs` — a batch of up to four samples, each `{ seq, dt, moveX, moveZ, aimX, aimZ, dash }`.
**Down:** row deltas for `body`, `event`, `match`, `match_score` and `player`. At 30 Hz with four bodies that is
about 120–180 rows/s per client (HUD: `throughput`).

Inputs are validated once per call, not once per sample: the sender must be in the match, the match must be
accepting input, and the body must be alive. A duplicate `seq` is **skipped silently**; anything else that fails
increments `player.violations` and throws, which rolls the reducer back. That split matters: after redundancy
landed, a resent frame is normal traffic, not cheating.

## Movement and momentum

The body carries two velocities, and the distinction is the whole game feel:

```
v  control   target = stick * MAX_SPEED, approached by a servo (MOVE_ACCEL 10/s)
k  knockback written only by shove lunges and body-body impulses, removed only by friction (1.6/s)
position += (v + k) * dt
```

Anything the world does to a body lands on `k`, so the stick cannot delete it: while `|k| > 2 u/s` the player is
staggered and steers at 35 % authority (`STAGGER_CONTROL`), which is enough to lean against a shove and not
enough to cancel one. Friction is applied per stepped input and never on a tick the server invents for itself: an
integration the client did not predict becomes an acknowledgement correction, so coasting a body through a
missing packet trades a 33 ms hang for permanent prediction noise (measured: 0 ack corrections without it, 39 in
40 s with it, same build, same link).

This replaced a single-channel model where every impulse was written into `v` and the servo — 33 % of the gap
per tick at 30 Hz — erased it inside 100 ms. A victim walking into a shove ended up 0.60 m *behind* their start
position; with the split they keep 69 % of the knockback at 250 ms and travel 2.82 m in the first second. The
measurement lives in `tools/momentum.test.ts` and runs on the same `stepBody` the server and the browser import.

## CPU seats and the command path

A CPU is a `player` row with `is_bot`, a synthetic identity (`0xb07…`, which no client can ever connect as) and a
`bot` row holding its memory. Its brain (`module/src/ai/brain.ts`) is a pure function of the body, its rivals,
the tick and a seed, and its only output is a list of `Command`s:

```ts
{ kind: 'steer', mx, mz } | { kind: 'aim', ax, az } | { kind: 'charge', hold }
```

A bot on a server that reads the live world every tick has zero latency, which is not a fair fight against a
player on a 170 ms link. So the client reports the round trip it measures (`report_latency`, refreshed only when
the number moves by 20 ms), the module averages it over the humans in the match, and the brain is only allowed to
*look* once per that interval: between decisions it replays the commands it already issued, aim included, so a
dodge that breaks the line of a stale aim actually works. Measured on the same build: 8.1 aim changes per second
at 0 ms reported, 5.1 at 170 ms.

The tick feeds those commands through the same `createCommandExecutor()` a keyboard uses, producing one
`InputFrame`, which joins the same queue and the same `stepBody` call as a human's. There is no bot branch in the physics, no
bot-only velocity, and no way for a bot to teleport: if the command vocabulary cannot express it, the server
cannot do it. The lobby reducer refuses a fifth seat, and a match whose last human leaves returns itself to the
lobby instead of playing to an audience of CPUs.

## Prediction and reconciliation

```
press key ──▶ predict: stepBody(local copy, this input)
          ──▶ send inputs (with the previous unacked frame)
                     │
       server: validate, integrate, ack last_seq, broadcast body row
                     │
   row arrives ──▶ find the input with matching seq in the ring buffer
                ──▶ restart from the server's body at that seq
                ──▶ replay every input newer than the ack
                ──▶ compare with what we drew; if the error > 2 cm, smooth it out over the next frames
```

The ring buffer holds inputs by `seq`; `last_seq` from the server is the ack. Replay uses the same `stepBody`,
with the same per-input `dt`, so a correct prediction replays to exactly the state we already had — which is why
a clean run reports zero corrections.

**Two kinds of correction, deliberately separated** in the HUD:

- **ack** — the server's row disagrees with our replay of a single body. This is netcode error: a dropped input,
  a stalled send, a timing mismatch. It should be near zero and it is what the chaos knob measures.
- **contact** — the server applied a collision or a shove impulse that the client does not predict. This is
  design, not failure: predicting body-body impulses would mean predicting the other player's next input.

`RENDER_DELAY_MS = 100`: remote bodies are drawn at `now − 100 ms` so there is always a sample to interpolate
between. Extrapolation is capped at 150 ms, after which a remote body holds still rather than sliding into a wall.

## Feedback you can feel, authority you cannot fake

The shove is the one action where the round trip is visible: hold to charge, release to fire. Waiting for the
server to acknowledge the release costs a full RTT (~160 ms from Brazil to maincloud), which reads as a broken
button. So the client fires its own feedback on the release edge — punch animation, sound, arc and dust — after
checking `canShove()` against the predicted body (charge over the threshold, cooldown expired). The impulse still
comes from the server, and when the server's `shove` event arrives within 600 ms it is recognised as an echo and
suppressed, so the punch does not replay half a second later.

The honest cost: if the server rejects the shove for a reason the client could not predict, the player saw a
punch that did not land.

## Input redundancy

One dropped frame used to cost a whole integration step, because the server integrates whatever arrived and the
missing `dt` was simply gone. Now every `submit_inputs` call carries the previous unacked sample as well, and
the server skips duplicates. A single lost packet therefore costs nothing; two in a row cost 33 ms.

## Measured

| Claim | Value | How it was measured |
| --- | --- | --- |
| Server tick | 33.33 ms mean, σ 1.15–2.51 ms | `node tools/bots.ts --n 4 --seconds 45 --print-metrics` |
| Determinism | 1000 ticks, byte-identical state | `node tools/determinism.test.ts` |
| Corrections, 4-player brawl, 250 ms | 2 ack (3.9/min) / 5 contact (9.76/min), 0 snaps, 112 resim steps | `?brawl=1&autopilot=250&seconds=25` |
| Shove retention, victim pushing back | 69 % of knockback at 250 ms, 2.82 m slide in 1 s | `node tools/momentum.test.ts` |
| CPU match | 408 shove releases, 478 contacts, eliminations, both round outcomes | `node tools/cpu-match.ts` |
| Client bundle | 190.08 kB gzip | `npm run build --workspace client`, then gzip |
| Frame time | 1.22 ms mean, 59.6 fps, 24 draw calls | `window.__ringout.perf()` on the deployed build |
| RTT, Brazil → maincloud | 157–176 ms steady state (400+ for the first seconds) | HUD `ping` on the deployed build, sampled once a second |

Contact corrections scale with contact, not with latency, which is why they are reported separately. The chaos
harness (`?autopilot=250&chaos=10&pin=1`) drops 10 % of inputs and stalls the send path every 5 s, prints
`RINGOUT_METRICS` when its window closes, and needs a second client to be a two-body comparison.

## What I rejected, and why

- **Fixed-point determinism.** Rollback absorbs float drift, so fixed-point would buy a month of work and a
  slower sim for a property this game does not need. It would matter for lockstep, and this is not lockstep.
- **A full physics engine (Rapier, cannon).** The disc is 2D in the XZ plane with circles; ~120 lines of
  hand-rolled integration is deterministic, dependency-free and runs inside a SpacetimeDB module.
- **Client-side hit prediction.** Predicting the *result* of a shove means predicting another player's input.
  The worst mispredict class (a knocked-out body that the client thought survived) is worth more than the ~RTT
  of impact feedback, so impacts stay server-only and only intent is local.
- **Snapshot interpolation instead of row deltas.** A snapshot table is another thing to write at 30 Hz per
  match; the body row already carries everything reconciliation needs.

## Failure modes

| Symptom | Cause | Where to look |
| --- | --- | --- |
| Own body snaps back | replaying with the wrong `dt`, or comparing smoothed state | `client/src/net/prediction.ts` |
| Remote bodies vibrate | render delay below jitter, or zero | `RENDER_DELAY_MS` |
| Corrections spike after alt-tab | accumulated wall-clock delta | frame delta clamp in the client loop |
| `ack` corrections grow with loss | input redundancy disabled, or the server rejecting resends | `submit_inputs` validation |
| Punch plays, no impulse | server rejected the shove the client predicted | `canShove()` conditions |
