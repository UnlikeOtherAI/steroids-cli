/**
 * System pressure monitoring — prevents runners from consuming all
 * available memory/disk and crashing the host.
 *
 * On macOS, swap files live on the boot APFS container and share free
 * space with the system volume. A single runaway provider process can
 * generate 20+ GB of swap and fill the drive.
 */

import { execFileSync } from 'node:child_process';
import { statfsSync } from 'node:fs';

// ── Thresholds ──────────────────────────────────────────────────────

/** Minimum free bytes on the boot volume before we refuse to spawn. */
const BOOT_VOLUME_MIN_FREE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB

/** Memory-free percentage below which we pause (macOS `memory_pressure`). */
const MEMORY_FREE_MIN_PCT = 20;

/** Maximum swap-used MB before we pause. */
const SWAP_USED_MAX_MB = 8_000; // 8 GB

/** How long to wait between pressure checks when paused (ms). */
const PRESSURE_POLL_INTERVAL_MS = 15_000;

/** Maximum total time we'll wait for pressure to drop before aborting (ms). */
const PRESSURE_MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes

// ── Types ───────────────────────────────────────────────────────────

export interface PressureSnapshot {
  bootVolumeFreeBytes: number;
  memoryFreePct: number;
  swapUsedMb: number;
}

export interface PressureCheckResult {
  ok: boolean;
  reason?: string;
  snapshot: PressureSnapshot;
}

// ── Snapshot collection ─────────────────────────────────────────────

function getBootVolumeFreeBytes(): number {
  try {
    const stats = statfsSync('/');
    return stats.bfree * stats.bsize;
  } catch {
    return Number.MAX_SAFE_INTEGER; // Can't check → don't block
  }
}

function getMemoryFreePct(): number {
  if (process.platform !== 'darwin') return 100;
  try {
    const out = execFileSync('memory_pressure', [], {
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    const match = out.match(/free percentage:\s*(\d+)%/);
    return match ? parseInt(match[1], 10) : 100;
  } catch {
    return 100; // Can't check → don't block
  }
}

function getSwapUsedMb(): number {
  if (process.platform !== 'darwin') return 0;
  try {
    const out = execFileSync('sysctl', ['vm.swapusage'], {
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    const match = out.match(/used\s*=\s*([\d.]+)M/);
    return match ? parseFloat(match[1]) : 0;
  } catch {
    return 0;
  }
}

export function takePressureSnapshot(): PressureSnapshot {
  return {
    bootVolumeFreeBytes: getBootVolumeFreeBytes(),
    memoryFreePct: getMemoryFreePct(),
    swapUsedMb: getSwapUsedMb(),
  };
}

// ── Pressure check ──────────────────────────────────────────────────

export function checkSystemPressure(snapshot?: PressureSnapshot): PressureCheckResult {
  const s = snapshot ?? takePressureSnapshot();

  if (s.bootVolumeFreeBytes < BOOT_VOLUME_MIN_FREE_BYTES) {
    const freeGb = (s.bootVolumeFreeBytes / (1024 * 1024 * 1024)).toFixed(1);
    return {
      ok: false,
      reason: `Boot volume critically low: ${freeGb} GB free (min ${BOOT_VOLUME_MIN_FREE_BYTES / (1024 * 1024 * 1024)} GB)`,
      snapshot: s,
    };
  }

  if (s.memoryFreePct < MEMORY_FREE_MIN_PCT) {
    return {
      ok: false,
      reason: `Memory pressure critical: ${s.memoryFreePct}% free (min ${MEMORY_FREE_MIN_PCT}%)`,
      snapshot: s,
    };
  }

  if (s.swapUsedMb > SWAP_USED_MAX_MB) {
    return {
      ok: false,
      reason: `Swap usage excessive: ${s.swapUsedMb.toFixed(0)} MB (max ${SWAP_USED_MAX_MB} MB)`,
      snapshot: s,
    };
  }

  return { ok: true, snapshot: s };
}

// ── Blocking wait with backoff ──────────────────────────────────────

/**
 * Wait for system pressure to drop below thresholds.
 * Returns true if pressure cleared, false if timed out.
 */
export async function waitForPressureRelief(
  log: (msg: string) => void = console.log
): Promise<boolean> {
  const initial = checkSystemPressure();
  if (initial.ok) return true;

  log(`[pressure] Pausing: ${initial.reason}`);

  const deadline = Date.now() + PRESSURE_MAX_WAIT_MS;
  let waited = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, PRESSURE_POLL_INTERVAL_MS));
    waited += PRESSURE_POLL_INTERVAL_MS;

    const check = checkSystemPressure();
    if (check.ok) {
      log(`[pressure] Pressure cleared after ${(waited / 1000).toFixed(0)}s — resuming`);
      return true;
    }

    if (waited % 60_000 < PRESSURE_POLL_INTERVAL_MS) {
      log(`[pressure] Still waiting (${(waited / 1000).toFixed(0)}s): ${check.reason}`);
    }
  }

  log(`[pressure] Timed out after ${(PRESSURE_MAX_WAIT_MS / 1000).toFixed(0)}s — aborting task`);
  return false;
}
