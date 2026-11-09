/**
 * One palette for pickups and the aura they leave on a body, so the amber fist, the amber
 * ring under the robot and the amber HUD chip always agree.
 */
export const BOOST_COLORS: Record<number, number> = {
  1: 0xffb020, // POWER — amber
  2: 0xff3b3b, // HASTE — red
  3: 0x4aa8ff, // HEAVY — blue
};

export const BOOST_NAMES: Record<number, string> = { 1: 'POWER', 2: 'HASTE', 3: 'SLOWED' };

export function boostColorHex(kind: number): number {
  return BOOST_COLORS[kind] ?? 0xffffff;
}

export function boostColorCss(kind: number): string {
  return `#${boostColorHex(kind).toString(16).padStart(6, '0')}`;
}

export function boostName(kind: number): string {
  return BOOST_NAMES[kind] ?? '';
}
