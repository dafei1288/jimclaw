export function getHeartbeatIntervalMs(): number {
  const raw = Number(process.env.JIMCLAW_HEARTBEAT_INTERVAL_MS || 45000);
  if (!Number.isFinite(raw) || raw <= 0) return 45000;
  return Math.max(10, Math.floor(raw));
}

export async function runWithHeartbeat<T>(args: {
  run: () => Promise<T>;
  onHeartbeat: () => Promise<void> | void;
  intervalMs?: number;
}): Promise<T> {
  const interval = args.intervalMs ?? getHeartbeatIntervalMs();
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    Promise.resolve(args.onHeartbeat()).finally(() => {
      ticking = false;
    });
  }, interval);

  try {
    return await args.run();
  } finally {
    clearInterval(timer);
  }
}
