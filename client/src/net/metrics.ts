export type CorrectionKind = 'ack' | 'contact';

export type RingoutMetricsSnapshot = {
  latencyMs: number;
  rttMs: number;
  corrections: number;
  correctionsPerMin: number;
  ackCorrections: number;
  ackCorrectionsPerMin: number;
  contactCorrections: number;
  contactCorrectionsPerMin: number;
  meanCorrectionCm: number;
  resimSteps: number;
  snaps: number;
  rowsPerSec: number;
};

export type RingoutPerfSummary = {
  visibilityState: DocumentVisibilityState;
  samples: number;
  meanFrameTimeMs: number;
  p95FrameTimeMs: number;
  maxFrameTimeMs: number;
  meanRafIntervalMs: number;
  fps: number;
  drawCalls: number;
  bloomEnabled: boolean;
  nameplateTextures: number;
  histogramCpuMs: {
    under1ms: number;
    ms1to2: number;
    ms2to5: number;
    over5ms: number;
  };
  histogramRafMs: {
    under18ms: number;
    ms18to22: number;
    ms22to34: number;
    over34ms: number;
  };
};

export type RingoutMetrics = RingoutMetricsSnapshot & {
  lastErr: number;
  windowStart: number;
  reset: () => void;
  beginRecoveryWindow: (drainDelayMs: number) => void;
  setLatencyMs: (ms: number) => void;
  recordSentSeq: (seq: number, sentAtMs: number) => void;
  recordAckSeq: (ackSeq: number, receivedAtMs: number) => void;
  recordCorrection: (
    errMeters: number,
    pendingSteps: number,
    kind?: CorrectionKind
  ) => void;
  recordSnap: () => void;
  recordRow: () => void;
  recordFrame: (
    cpuMs: number,
    rafDeltaMs: number,
    drawCalls: number,
    bloomEnabled: boolean,
    nameplateTextures?: number
  ) => void;
  refresh: () => void;
  snapshot: () => RingoutMetricsSnapshot;
  perf: () => RingoutPerfSummary;
};

declare global {
  interface Window {
    __ringout?: RingoutMetrics;
  }
}

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

const FRAME_WINDOW_SIZE = 300;

function createMetrics(): RingoutMetrics {
  let totalCorrectionSumCm = 0;
  let hasRttSample = false;
  let liveRttMs = 0;
  let liveAckCorrections = 0;
  let liveContactCorrections = 0;
  let liveMeanCorrectionCm = 0;
  let liveResimSteps = 0;
  let liveSnaps = 0;
  let rateWindowStart = performance.now();
  const recentRowTimestamps: number[] = [];
  const recentAckCorrectionTimestamps: number[] = [];
  const recentContactCorrectionTimestamps: number[] = [];
  const sentSeqTimes = new Map<number, number>();

  const frameCpuSamples: number[] = [];
  const frameRafSamples: number[] = [];
  let lastDrawCalls = 0;
  let lastBloomEnabled = true;
  let lastNameplateTextures = 0;

  const state: RingoutMetrics = {
    latencyMs: 0,
    rttMs: 0,
    corrections: 0,
    correctionsPerMin: 0,
    ackCorrections: 0,
    ackCorrectionsPerMin: 0,
    contactCorrections: 0,
    contactCorrectionsPerMin: 0,
    meanCorrectionCm: 0,
    resimSteps: 0,
    lastErr: 0,
    snaps: 0,
    rowsPerSec: 0,
    windowStart: performance.now(),

    reset() {
      const now = performance.now();
      liveRttMs = 0;
      liveAckCorrections = 0;
      liveContactCorrections = 0;
      liveMeanCorrectionCm = 0;
      liveResimSteps = 0;
      liveSnaps = 0;
      state.rttMs = 0;
      state.corrections = 0;
      state.correctionsPerMin = 0;
      state.ackCorrections = 0;
      state.ackCorrectionsPerMin = 0;
      state.contactCorrections = 0;
      state.contactCorrectionsPerMin = 0;
      state.meanCorrectionCm = 0;
      state.resimSteps = 0;
      state.lastErr = 0;
      state.snaps = 0;
      state.rowsPerSec = 0;
      state.windowStart = now;
      rateWindowStart = now;
      totalCorrectionSumCm = 0;
      hasRttSample = false;
      recentRowTimestamps.length = 0;
      recentAckCorrectionTimestamps.length = 0;
      recentContactCorrectionTimestamps.length = 0;
      sentSeqTimes.clear();
      frameCpuSamples.length = 0;
      frameRafSamples.length = 0;
    },

    beginRecoveryWindow(drainDelayMs: number) {
      rateWindowStart = performance.now() + Math.max(0, drainDelayMs);
    },

    setLatencyMs(ms: number) {
      const previous = state.latencyMs;
      state.latencyMs = ms;
      if (ms < previous) {
        rateWindowStart = performance.now() + ms * 2 + 100;
      }
    },

    recordSentSeq(seq: number, sentAtMs: number) {
      sentSeqTimes.set(seq, sentAtMs);
      if (sentSeqTimes.size > 256) {
        const oldestKey = sentSeqTimes.keys().next().value;
        if (oldestKey !== undefined) {
          sentSeqTimes.delete(oldestKey);
        }
      }
    },

    recordAckSeq(ackSeq: number, receivedAtMs: number) {
      const sentAt = sentSeqTimes.get(ackSeq);
      if (sentAt !== undefined) {
        const sampleRtt = Math.max(0, receivedAtMs - sentAt);
        liveRttMs = hasRttSample
          ? Math.round(liveRttMs * 0.7 + sampleRtt * 0.3)
          : Math.round(sampleRtt);
        hasRttSample = true;
      }
      for (const key of sentSeqTimes.keys()) {
        if (key <= ackSeq) {
          sentSeqTimes.delete(key);
        }
      }
    },

    recordCorrection(
      errMeters: number,
      pendingSteps: number,
      kind: CorrectionKind = 'ack'
    ) {
      const now = performance.now();
      liveResimSteps += pendingSteps;
      state.lastErr = errMeters;
      if (kind === 'contact') {
        liveContactCorrections += 1;
        recentContactCorrectionTimestamps.push(now);
      } else {
        liveAckCorrections += 1;
        totalCorrectionSumCm += errMeters * 100;
        liveMeanCorrectionCm = roundTwo(totalCorrectionSumCm / liveAckCorrections);
        recentAckCorrectionTimestamps.push(now);
      }
    },

    recordSnap() {
      liveSnaps += 1;
    },

    recordRow() {
      const now = performance.now();
      recentRowTimestamps.push(now);
    },

    recordFrame(
      cpuMs: number,
      rafDeltaMs: number,
      drawCalls: number,
      bloomEnabled: boolean,
      nameplateTextures = 0
    ) {
      lastDrawCalls = drawCalls;
      lastBloomEnabled = bloomEnabled;
      lastNameplateTextures = nameplateTextures;
      if (rafDeltaMs <= 0 || rafDeltaMs > 250) return;
      frameCpuSamples.push(cpuMs);
      frameRafSamples.push(rafDeltaMs);
      if (frameCpuSamples.length > FRAME_WINDOW_SIZE) {
        frameCpuSamples.shift();
      }
      if (frameRafSamples.length > FRAME_WINDOW_SIZE) {
        frameRafSamples.shift();
      }
    },

    refresh() {
      const now = performance.now();
      state.rttMs = liveRttMs;
      state.ackCorrections = liveAckCorrections;
      state.contactCorrections = liveContactCorrections;
      state.corrections = liveAckCorrections;
      state.meanCorrectionCm = liveMeanCorrectionCm;
      state.resimSteps = liveResimSteps;
      state.snaps = liveSnaps;

      const rowCutoff = now - 5000;
      while (recentRowTimestamps.length > 0 && recentRowTimestamps[0]! < rowCutoff) {
        recentRowTimestamps.shift();
      }
      const rowWindowSec = Math.min(5, Math.max(0.5, (now - state.windowStart) / 1000));
      state.rowsPerSec = roundTwo(recentRowTimestamps.length / rowWindowSec);

      const corrCutoff = Math.max(rateWindowStart, now - 60000);
      while (
        recentAckCorrectionTimestamps.length > 0 &&
        recentAckCorrectionTimestamps[0]! < corrCutoff
      ) {
        recentAckCorrectionTimestamps.shift();
      }
      while (
        recentContactCorrectionTimestamps.length > 0 &&
        recentContactCorrectionTimestamps[0]! < corrCutoff
      ) {
        recentContactCorrectionTimestamps.shift();
      }
      if (now <= rateWindowStart) {
        state.ackCorrectionsPerMin = 0;
        state.contactCorrectionsPerMin = 0;
        state.correctionsPerMin = 0;
      } else {
        const elapsedMin = Math.max(1 / 60, (now - corrCutoff) / 60000);
        const windowMin = Math.min(1, elapsedMin);
        state.ackCorrectionsPerMin = roundTwo(
          recentAckCorrectionTimestamps.length / windowMin
        );
        state.contactCorrectionsPerMin = roundTwo(
          recentContactCorrectionTimestamps.length / windowMin
        );
        state.correctionsPerMin = state.ackCorrectionsPerMin;
      }
    },

    snapshot(): RingoutMetricsSnapshot {
      return {
        latencyMs: state.latencyMs,
        rttMs: state.rttMs,
        corrections: state.corrections,
        correctionsPerMin: state.correctionsPerMin,
        ackCorrections: state.ackCorrections,
        ackCorrectionsPerMin: state.ackCorrectionsPerMin,
        contactCorrections: state.contactCorrections,
        contactCorrectionsPerMin: state.contactCorrectionsPerMin,
        meanCorrectionCm: state.meanCorrectionCm,
        resimSteps: state.resimSteps,
        snaps: state.snaps,
        rowsPerSec: state.rowsPerSec,
      };
    },

    perf(): RingoutPerfSummary {
      const visibilityState = document.visibilityState;
      const count = frameCpuSamples.length;
      if (count === 0) {
        return {
          visibilityState,
          samples: 0,
          meanFrameTimeMs: 0,
          p95FrameTimeMs: 0,
          maxFrameTimeMs: 0,
          meanRafIntervalMs: 0,
          fps: 0,
          drawCalls: lastDrawCalls,
          bloomEnabled: lastBloomEnabled,
          nameplateTextures: lastNameplateTextures,
          histogramCpuMs: { under1ms: 0, ms1to2: 0, ms2to5: 0, over5ms: 0 },
          histogramRafMs: { under18ms: 0, ms18to22: 0, ms22to34: 0, over34ms: 0 },
        };
      }

      let cpuSum = 0;
      let cpuMax = 0;
      let under1ms = 0;
      let ms1to2 = 0;
      let ms2to5 = 0;
      let over5ms = 0;

      for (let i = 0; i < count; i++) {
        const v = frameCpuSamples[i]!;
        cpuSum += v;
        if (v > cpuMax) cpuMax = v;
        if (v < 1) under1ms++;
        else if (v < 2) ms1to2++;
        else if (v <= 5) ms2to5++;
        else over5ms++;
      }

      const sortedCpu = [...frameCpuSamples].sort((a, b) => a - b);
      const p95Index = Math.min(count - 1, Math.floor(count * 0.95));

      let rafSum = 0;
      let under18ms = 0;
      let ms18to22 = 0;
      let ms22to34 = 0;
      let over34ms = 0;
      for (let i = 0; i < frameRafSamples.length; i++) {
        const r = frameRafSamples[i]!;
        rafSum += r;
        if (r <= 18) under18ms++;
        else if (r <= 22) ms18to22++;
        else if (r <= 34) ms22to34++;
        else over34ms++;
      }

      const meanRaf = rafSum / Math.max(1, frameRafSamples.length);
      return {
        visibilityState,
        samples: count,
        meanFrameTimeMs: roundTwo(cpuSum / count),
        p95FrameTimeMs: roundTwo(sortedCpu[p95Index] ?? 0),
        maxFrameTimeMs: roundTwo(cpuMax),
        meanRafIntervalMs: roundTwo(meanRaf),
        fps: roundTwo(1000 / Math.max(1, meanRaf)),
        drawCalls: lastDrawCalls,
        bloomEnabled: lastBloomEnabled,
        nameplateTextures: lastNameplateTextures,
        histogramCpuMs: { under1ms, ms1to2, ms2to5, over5ms },
        histogramRafMs: { under18ms, ms18to22, ms22to34, over34ms },
      };
    },
  };

  window.__ringout = state;
  return state;
}

export const metrics = createMetrics();
