import * as C from '../../../shared/src/constants';

/**
 * Return a match to the lobby without removing its CPU seats.
 *
 * Every terminal path uses this — the round clock timing out, the match finishing, the
 * rematch button, and the sweep that fires when the last human leaves — because a cleanup
 * that only some exits run leaves ghost bodies behind and the lobby then refuses to start.
 *
 * Humans who dropped are deleted; CPU seats survive with their brain wiped, so a solo player
 * keeps the opponents they seated and can start again with one click.
 */
export function resetMatchToLobby(ctx: any, currentMatch: any, scheduledId?: bigint): void {
  for (const b of ctx.db.body.match_id.filter(currentMatch.id)) {
    // A connected human keeps their seat; a socket that dropped mid-match loses it.
    if (b.disconnected_at > 0n) {
      ctx.db.Player.id.delete(b.owner);
    }
    ctx.db.body.id.delete(b.id);
  }

  for (const bot of ctx.db.bot.match_id.filter(currentMatch.id)) {
    ctx.db.bot.owner.update({
      ...bot,
      target_id: 0n,
      release_at_tick: 0n,
      hold_started_tick: 0n,
      next_decision_tick: 0n,
      aim_x: 0,
      aim_z: 0,
      steer_x: 0,
      steer_z: 0,
    });
  }

  for (const pick of ctx.db.pickup.match_id.filter(currentMatch.id)) {
    ctx.db.pickup.id.delete(pick.id);
  }

  for (const score of ctx.db.matchScore.match_id.filter(currentMatch.id)) {
    ctx.db.matchScore.id.delete(score.id);
  }
  for (const frame of ctx.db.inputFrame.match_id.filter(currentMatch.id)) {
    ctx.db.inputFrame.id.delete(frame.id);
  }
  for (const event of ctx.db.event.match_id.filter(currentMatch.id)) {
    ctx.db.event.id.delete(event.id);
  }

  if (scheduledId !== undefined) {
    ctx.db.matchTick.scheduled_id.delete(scheduledId);
  } else {
    for (const sched of ctx.db.matchTick.match_id.filter(currentMatch.id)) {
      ctx.db.matchTick.scheduled_id.delete(sched.scheduled_id);
    }
  }

  for (const p of ctx.db.Player.iter()) {
    if (p.match_id === currentMatch.id && !p.is_bot) {
      ctx.db.Player.id.update({ ...p, ready: false });
    }
  }

  ctx.db.match.id.update({
    ...currentMatch,
    status: 'lobby',
    round: 1,
    score_a: 0,
    score_b: 0,
    tick: 0n,
    countdown_ends: 0n,
    round_ends: 0n,
    arena_radius: C.ARENA_R_START,
    winner: undefined,
  });
}
