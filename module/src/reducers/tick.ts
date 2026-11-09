import spacetimedb, { matchTick } from '../schema';
import * as C from '../../../shared/src/constants';
import { IDLE_INTENT, applyCommands, intentToFrame } from '../../../shared/src/commands';
import { personaFromSeed, think } from '../ai/brain';
import { resetMatchToLobby } from '../match/reset';
import { radiusAt, resolveCollisions, stepBody } from '../sim/step';

function emitEvent(
  ctx: any,
  matchId: bigint,
  kind: string,
  a: any,
  b: any,
  x: number,
  z: number,
  dx: number,
  dz: number,
  tick: bigint
): void {
  ctx.db.event.insert({
    id: 0n,
    match_id: matchId,
    kind,
    a,
    b,
    x,
    z,
    dx,
    dz,
    tick,
  });
}

function pruneOldEvents(ctx: any, matchId: bigint, currentTick: bigint): void {
  const keepTicks = BigInt(C.EVENT_PRUNE_S * C.TICK_HZ);
  if (currentTick <= keepTicks) return;
  const cutoff = currentTick - keepTicks;
  for (const ev of ctx.db.event.match_id.filter(matchId)) {
    if (ev.tick < cutoff) {
      ctx.db.event.id.delete(ev.id);
    }
  }
}

function respawnBodiesForRound(ctx: any, bodies: any[], nextTick: bigint): void {
  const spawnRadius = C.SPAWN_R_FACTOR * C.ARENA_R_START;
  for (let idx = 0; idx < bodies.length; idx++) {
    const b = bodies[idx]!;
    const angle = (2 * Math.PI * idx) / bodies.length;
    const px = Math.cos(angle) * spawnRadius;
    const pz = Math.sin(angle) * spawnRadius;
    const aimX = -Math.cos(angle);
    const aimZ = -Math.sin(angle);

    ctx.db.body.id.update({
      ...b,
      px,
      pz,
      vx: 0,
      vz: 0,
      kx: 0,
      kz: 0,
      aim_x: aimX,
      aim_z: aimZ,
      charge: 0,
      alive: true,
      elim_order: 0,
      server_tick: nextTick,
      cooldown_until: 0n,
    });
  }
}

function selectRoundWinner(aliveBodies: any[], timedOut: boolean): any | undefined {
  if (aliveBodies.length === 1) {
    return aliveBodies[0];
  }
  if (aliveBodies.length > 1 && timedOut) {
    const sortedByCentreDist = [...aliveBodies].sort(
      (a, b) => Math.hypot(a.px, a.pz) - Math.hypot(b.px, b.pz)
    );
    const closest = sortedByCentreDist[0]!;
    const runnerUp = sortedByCentreDist[1]!;
    const closestDist = Math.hypot(closest.px, closest.pz);
    const runnerUpDist = Math.hypot(runnerUp.px, runnerUp.pz);
    if (Math.abs(runnerUpDist - closestDist) > C.EPSILON) {
      return closest;
    }
  }
  return undefined;
}

function recordRoundWinByIdentity(
  ctx: any,
  matchId: bigint,
  winnerOwner: any
): { winnerWins: number; scoreA: number; scoreB: number } {
  const scoreRows = [...ctx.db.matchScore.match_id.filter(matchId)].sort((a, b) =>
    Number(a.id - b.id)
  );
  let winnerWins = 1;
  for (let i = 0; i < scoreRows.length; i++) {
    const row = scoreRows[i]!;
    if (row.owner.equals(winnerOwner)) {
      winnerWins = row.wins + 1;
      const updated = { ...row, wins: winnerWins };
      ctx.db.matchScore.id.update(updated);
      scoreRows[i] = updated;
      break;
    }
  }
  const scoreA = scoreRows[0]?.wins ?? 0;
  const scoreB = scoreRows[1]?.wins ?? 0;
  return { winnerWins, scoreA, scoreB };
}

export const tick = spacetimedb.reducer(
  { onSchedule: matchTick },
  { arg: matchTick.rowType },
  (ctx, { arg }) => {
    const currentMatch = ctx.db.match.id.find(arg.match_id);
    if (!currentMatch || currentMatch.status === 'lobby') {
      ctx.db.matchTick.scheduled_id.delete(arg.scheduled_id);
      return;
    }

    const nextTick = currentMatch.tick + 1n;
    pruneOldEvents(ctx, currentMatch.id, nextTick);

    if (currentMatch.status === 'finished') {
      for (const frame of ctx.db.inputFrame.match_id.filter(currentMatch.id)) {
        ctx.db.inputFrame.id.delete(frame.id);
      }
      if (nextTick >= currentMatch.round_ends) {
        resetMatchToLobby(ctx, currentMatch, arg.scheduled_id);
        return;
      }
      ctx.db.match.id.update({ ...currentMatch, tick: nextTick });
      return;
    }

    const now = ctx.timestamp.microsSinceUnixEpoch;
    const allBodies = [...ctx.db.body.match_id.filter(currentMatch.id)].sort((a, b) =>
      Number(a.id - b.id)
    );

    const botSeats = new Map<string, any>();
    for (const botRow of ctx.db.bot.match_id.filter(currentMatch.id)) {
      botSeats.set(botRow.owner.toHexString(), botRow);
    }
    const isBotSeat = (owner: any) => botSeats.has(owner.toHexString());

    // CPU seats are handicapped by the average round trip the humans in this match reported:
    // the brain looks at the world once per that interval and holds its decision in between.
    const reportedLatencies = [...ctx.db.Player.iter()].filter(
      (p) => p.match_id === currentMatch.id && !p.is_bot && p.latency_ms > 0
    );
    const meanLatencyMs =
      reportedLatencies.length > 0
        ? reportedLatencies.reduce((sum, p) => sum + p.latency_ms, 0) / reportedLatencies.length
        : 0;
    const latencyTicks = Math.round((meanLatencyMs / 1000) * C.TICK_HZ);

    const bodies = allBodies.filter((b) => {
      if (b.disconnected_at > 0n && now - b.disconnected_at >= C.DISCONNECT_GRACE_US) {
        emitEvent(ctx, currentMatch.id, 'elim', b.owner, undefined, b.px, b.pz, 0, 0, nextTick);
        ctx.db.body.id.delete(b.id);
        for (const input of ctx.db.inputFrame.owner.filter(b.owner)) {
          ctx.db.inputFrame.id.delete(input.id);
        }
        ctx.db.Player.id.delete(b.owner);
        console.info(`removed disconnected body ${b.name} (${b.id}) after 15s grace`);
        return false;
      }
      return true;
    });

    // CPUs never disconnect, so a match whose last human left would keep playing to nobody.
    // A disconnected human still counts while their grace period runs; once the sweep removes
    // that body there is no one left to play for.
    if (!bodies.some((b) => !isBotSeat(b.owner))) {
      console.info(`match ${currentMatch.id} has no human left, returning to lobby`);
      resetMatchToLobby(ctx, currentMatch, arg.scheduled_id);
      return;
    }

    if (bodies.length < 2) {
      const connectedBodies = bodies.filter((b) => b.disconnected_at === 0n);
      if (connectedBodies.length === 0) {
        for (const b of bodies) {
          ctx.db.Player.id.delete(b.owner);
          ctx.db.body.id.delete(b.id);
        }
        resetMatchToLobby(ctx, currentMatch, arg.scheduled_id);
        return;
      }

      const survivor = connectedBodies[0]?.owner;
      if (survivor) {
        emitEvent(ctx, currentMatch.id, 'match_end', survivor, undefined, 0, 0, 0, 0, nextTick);
        ctx.db.match.id.update({
          ...currentMatch,
          status: 'finished',
          tick: nextTick,
          winner: survivor,
          round_ends: nextTick + BigInt(C.MATCH_END_S * C.TICK_HZ),
        });
      } else {
        resetMatchToLobby(ctx, currentMatch, arg.scheduled_id);
      }
      return;
    }

    const isFrozen = currentMatch.status === 'countdown' || currentMatch.status === 'round_end';
    const roundTicks =
      currentMatch.status === 'playing' && nextTick > currentMatch.countdown_ends
        ? nextTick - currentMatch.countdown_ends
        : 0n;
    const nextArenaRadius =
      currentMatch.status === 'playing'
        ? radiusAt(Number(roundTicks) / C.TICK_HZ)
        : C.ARENA_R_START;

    const consumedInputIds: bigint[] = [];
    const updatedBodies = bodies.map((b) => {
      const pendingInputs = [...ctx.db.inputFrame.owner.filter(b.owner)]
        .filter((i) => i.match_id === currentMatch.id && !i.applied)
        .sort((x, y) => x.seq - y.seq);

      // A CPU has no connection and no input rows. Its brain emits commands, the commands go
      // through the same executor a keyboard uses, and the resulting frame joins the same
      // queue below, so the physics cannot tell the two apart.
      const botRow = botSeats.get(b.owner.toHexString());
      if (botRow && b.alive && !isFrozen) {
        const persona = personaFromSeed(botRow.seed);
        const decision = think(
          { px: b.px, pz: b.pz, charge: b.charge, cooldown_until: b.cooldown_until },
          bodies
            .filter((other) => other.id !== b.id)
            .map((other) => ({ id: other.id, px: other.px, pz: other.pz, alive: other.alive })),
          nextArenaRadius,
          nextTick,
          {
            targetId: botRow.target_id,
            releaseAtTick: botRow.release_at_tick,
            holdStartedTick: botRow.hold_started_tick,
            nextDecisionTick: botRow.next_decision_tick,
            aimX: botRow.aim_x,
            aimZ: botRow.aim_z,
            steerX: botRow.steer_x,
            steerZ: botRow.steer_z,
          },
          persona,
          Math.max(persona.reactionTicks, latencyTicks)
        );
        const frame = intentToFrame(applyCommands(IDLE_INTENT, decision.commands));
        pendingInputs.push({
          id: 0n,
          match_id: currentMatch.id,
          owner: b.owner,
          seq: b.last_seq + 1,
          mx: frame.mx,
          mz: frame.mz,
          ax: frame.ax,
          az: frame.az,
          dash: frame.dash,
          applied: false,
        });
        ctx.db.bot.owner.update({
          ...botRow,
          target_id: decision.memory.targetId,
          release_at_tick: decision.memory.releaseAtTick,
          hold_started_tick: decision.memory.holdStartedTick,
          next_decision_tick: decision.memory.nextDecisionTick,
          aim_x: decision.memory.aimX,
          aim_z: decision.memory.aimZ,
          steer_x: decision.memory.steerX,
          steer_z: decision.memory.steerZ,
        });
      }

      if (pendingInputs.length === 0) {
        return { ...b };
      }

      if (!b.alive && currentMatch.status === 'playing') {
        for (const input of pendingInputs) {
          if (input.id > 0n) consumedInputIds.push(input.id); // CPU frames carry no row
        }
        return { ...b };
      }

      let next = { ...b };
      for (const input of pendingInputs) {
        if (!isFrozen && next.alive) {
          const chargeAfterHold = Math.min(
            1,
            next.charge + (input.dash ? C.DT / C.CHARGE_TIME : 0)
          );
          if (!input.dash && chargeAfterHold > C.SHOVE_MIN_CHARGE) {
            if (nextTick >= next.cooldown_until) {
              next = stepBody(next, input, C.DT, nextArenaRadius, nextTick, false);
              next = { ...next, last_seq: input.seq, server_tick: nextTick };
              emitEvent(
                ctx,
                currentMatch.id,
                'shove',
                b.owner,
                undefined,
                next.px,
                next.pz,
                next.aim_x,
                next.aim_z,
                nextTick
              );
              if (input.id > 0n) consumedInputIds.push(input.id); // CPU frames carry no row
              continue;
            }
            const player = ctx.db.Player.id.find(b.owner);
            if (player) {
              ctx.db.Player.id.update({ ...player, violations: player.violations + 1 });
            }
          }
        }

        const stepTarget = isFrozen ? { ...next, alive: true } : next;
        const stepped = stepBody(stepTarget, input, C.DT, nextArenaRadius, nextTick, isFrozen);
        next = {
          ...stepped,
          alive: isFrozen ? next.alive : stepped.alive,
          last_seq: input.seq,
          server_tick: nextTick,
        };
        if (input.id > 0n) consumedInputIds.push(input.id); // CPU frames carry no row
      }
      return next;
    });

    if (currentMatch.status === 'playing') {
      const contacts = resolveCollisions(updatedBodies, C.DT);
      for (const contact of contacts) {
        if (contact.impulse >= C.HIT_MIN_IMPULSE) {
          const bodyA = updatedBodies[contact.indexA];
          const bodyB = updatedBodies[contact.indexB];
          emitEvent(
            ctx,
            currentMatch.id,
            'hit',
            bodyA?.owner,
            bodyB?.owner,
            contact.x,
            contact.z,
            0,
            0,
            nextTick
          );
        }
      }

      let maxElimOrder = bodies.reduce((m, b) => Math.max(m, b.elim_order), 0);
      for (let i = 0; i < updatedBodies.length; i++) {
        const original = bodies[i]!;
        const updated = updatedBodies[i]!;
        if (!original.alive) continue;

        const outOfBounds = Math.hypot(updated.px, updated.pz) > nextArenaRadius + C.ELIM_MARGIN;
        if (!updated.alive || outOfBounds) {
          maxElimOrder += 1;
          updated.alive = false;
          updated.elim_order = maxElimOrder;
          updated.vx = 0;
          updated.vz = 0;
          updated.kx = 0;
          updated.kz = 0;
          updated.charge = 0;
          emitEvent(
            ctx,
            currentMatch.id,
            'elim',
            updated.owner,
            undefined,
            updated.px,
            updated.pz,
            0,
            0,
            nextTick
          );
        }
      }
    }

    let bodyWrites = 0;
    let newlyEliminated = 0;
    for (let index = 0; index < bodies.length; index++) {
      const original = bodies[index]!;
      const updated = updatedBodies[index]!;
      if (original.alive && !updated.alive) {
        newlyEliminated += 1;
      }
      const hasChanged =
        original.last_seq !== updated.last_seq ||
        original.px !== updated.px ||
        original.pz !== updated.pz ||
        original.vx !== updated.vx ||
        original.vz !== updated.vz ||
        original.kx !== updated.kx ||
        original.kz !== updated.kz ||
        original.aim_x !== updated.aim_x ||
        original.aim_z !== updated.aim_z ||
        original.charge !== updated.charge ||
        original.alive !== updated.alive ||
        original.elim_order !== updated.elim_order ||
        original.cooldown_until !== updated.cooldown_until;

      if (hasChanged) {
        ctx.db.body.id.update({ ...updated, server_tick: nextTick });
        bodyWrites += 1;
      }
    }

    for (const inputId of consumedInputIds) {
      ctx.db.inputFrame.id.delete(inputId);
    }

    if (currentMatch.status === 'countdown') {
      if (nextTick >= currentMatch.countdown_ends) {
        ctx.db.match.id.update({
          ...currentMatch,
          status: 'playing',
          tick: nextTick,
          arena_radius: C.ARENA_R_START,
          round_ends: nextTick + BigInt(C.ROUND_CAP_S * C.TICK_HZ),
        });
      } else {
        ctx.db.match.id.update({ ...currentMatch, tick: nextTick });
      }
      return;
    }

    if (currentMatch.status === 'round_end') {
      if (nextTick >= currentMatch.round_ends) {
        respawnBodiesForRound(ctx, updatedBodies, nextTick);
        const countdownTicks = BigInt(C.COUNTDOWN_S * C.TICK_HZ);
        const roundCapTicks = BigInt(C.ROUND_CAP_S * C.TICK_HZ);
        ctx.db.match.id.update({
          ...currentMatch,
          status: 'countdown',
          tick: nextTick,
          arena_radius: C.ARENA_R_START,
          countdown_ends: nextTick + countdownTicks,
          round_ends: nextTick + countdownTicks + roundCapTicks,
        });
      } else {
        ctx.db.match.id.update({ ...currentMatch, tick: nextTick });
      }
      return;
    }

    // status === 'playing'
    const aliveBodies = updatedBodies.filter((b) => b.alive);
    const timedOut = nextTick >= currentMatch.round_ends;
    if (aliveBodies.length <= 1 || timedOut) {
      const winnerBody = selectRoundWinner(aliveBodies, timedOut);
      if (newlyEliminated > 0) {
        console.info(
          `elim_tick match=${currentMatch.id} tick=${nextTick} newly_elim=${newlyEliminated} body_writes=${bodyWrites} events_written=${newlyEliminated + 1} inputs_deleted=${consumedInputIds.length}`
        );
      }

      if (winnerBody) {
        const { winnerWins, scoreA, scoreB } = recordRoundWinByIdentity(
          ctx,
          currentMatch.id,
          winnerBody.owner
        );

        emitEvent(
          ctx,
          currentMatch.id,
          'round_end',
          winnerBody.owner,
          undefined,
          winnerBody.px,
          winnerBody.pz,
          0,
          0,
          nextTick
        );

        if (winnerWins >= C.ROUNDS_TO_WIN) {
          emitEvent(
            ctx,
            currentMatch.id,
            'match_end',
            winnerBody.owner,
            undefined,
            winnerBody.px,
            winnerBody.pz,
            0,
            0,
            nextTick
          );
          ctx.db.match.id.update({
            ...currentMatch,
            status: 'finished',
            score_a: scoreA,
            score_b: scoreB,
            winner: winnerBody.owner,
            tick: nextTick,
            arena_radius: nextArenaRadius,
            round_ends: nextTick + BigInt(C.MATCH_END_S * C.TICK_HZ),
          });
        } else {
          ctx.db.match.id.update({
            ...currentMatch,
            status: 'round_end',
            round: currentMatch.round + 1,
            score_a: scoreA,
            score_b: scoreB,
            tick: nextTick,
            arena_radius: nextArenaRadius,
            round_ends: nextTick + BigInt(C.ROUND_END_S * C.TICK_HZ),
          });
        }
      } else {
        // Simultaneous elimination or exact equidistant timeout tie -> draw: replay round, no score change
        emitEvent(ctx, currentMatch.id, 'round_end', undefined, undefined, 0, 0, 0, 0, nextTick);
        ctx.db.match.id.update({
          ...currentMatch,
          status: 'round_end',
          tick: nextTick,
          arena_radius: nextArenaRadius,
          round_ends: nextTick + BigInt(C.ROUND_END_S * C.TICK_HZ),
        });
      }
      return;
    }

    ctx.db.match.id.update({
      ...currentMatch,
      tick: nextTick,
      arena_radius: nextArenaRadius,
    });

    if (nextTick % BigInt(C.TICK_HZ) === 0n) {
      console.info(`match ${currentMatch.id} tick ${nextTick} bodies ${aliveBodies.length}`);
    }
  }
);