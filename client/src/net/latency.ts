export type LatencyShim = {
  getLatencyMs: () => number;
  setLatencyMs: (ms: number) => void;
  send: (fn: () => void) => void;
  recv: (fn: () => void) => void;
  pump: () => void;
  dispose: () => void;
};

type QueuedAction = {
  at: number;
  fn: () => void;
};

/**
 * Starts a repeating timer backed by an inline Web Worker so Chromium does not
 * throttle it to 1 Hz when the window is minimised or occluded.
 */
export function startTicker(callback: () => void, intervalMs: number): () => void {
  if (typeof Worker !== 'undefined' && typeof Blob !== 'undefined') {
    try {
      const code = `setInterval(() => postMessage(0), ${intervalMs});`;
      const blob = new Blob([code], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      worker.onmessage = () => callback();
      return () => {
        worker.terminate();
        URL.revokeObjectURL(url);
      };
    } catch {
      // Fall back to window.setInterval below
    }
  }
  const id = window.setInterval(callback, intervalMs);
  return () => window.clearInterval(id);
}

/**
 * Bidirectional one-way latency shim (0 / 100 / 250 ms).
 * Delays both outgoing reducer calls and incoming row handlers in FIFO order.
 */
export function createLatencyShim(initialMs = 0): LatencyShim {
  let delayMs = Math.max(0, initialMs);
  const sendQueue: QueuedAction[] = [];
  const recvQueue: QueuedAction[] = [];

  function drain(queue: QueuedAction[], now: number): void {
    while (queue.length > 0 && queue[0]!.at <= now) {
      const next = queue.shift()!;
      next.fn();
    }
  }

  function pump(): void {
    const now = performance.now();
    drain(sendQueue, now);
    drain(recvQueue, now);
  }

  function enqueue(queue: QueuedAction[], fn: () => void): void {
    const now = performance.now();
    if (delayMs === 0 && queue.length === 0) {
      fn();
      return;
    }
    const lastAt = queue.length > 0 ? queue[queue.length - 1]!.at : 0;
    const targetAt = Math.max(lastAt, now + delayMs);
    queue.push({ at: targetAt, fn });
    window.setTimeout(pump, Math.max(0, targetAt - now));
  }

  const stopTicker = startTicker(pump, 8);

  if (import.meta.hot) {
    import.meta.hot.dispose(() => stopTicker());
  }

  return {
    getLatencyMs: () => delayMs,
    setLatencyMs(ms: number) {
      delayMs = Math.max(0, ms);
      const maxAllowedAt = performance.now() + delayMs;
      for (const item of sendQueue) {
        if (item.at > maxAllowedAt) item.at = maxAllowedAt;
      }
      for (const item of recvQueue) {
        if (item.at > maxAllowedAt) item.at = maxAllowedAt;
      }
      pump();
    },
    send(fn: () => void) {
      enqueue(sendQueue, fn);
    },
    recv(fn: () => void) {
      enqueue(recvQueue, fn);
    },
    pump,
    dispose() {
      stopTicker();
      sendQueue.length = 0;
      recvQueue.length = 0;
    },
  };
}
