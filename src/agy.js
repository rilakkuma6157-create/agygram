import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';

import {
  assertWindowsCommandLineSupported,
  DEFAULT_WINDOWS_SAFE_COMMAND_LINE_UNITS,
  estimateWindowsCommandLineUnits as estimatePlatformWindowsCommandLineUnits,
  quoteWindowsArgument,
} from './process-platform.js';

const AUTH_PATTERN =
  /not (?:signed|logged) in|sign[ -]?in required|login required|authentication required|please (?:authenticate|log ?in|sign ?in)|select login method|authorization url/i;

export function isAuthRequired(detail) {
  if (typeof detail !== 'string' || !detail) return false;
  if (/authenticated successfully|auth succeeded/i.test(detail)) {
    return false;
  }
  return AUTH_PATTERN.test(detail);
}

const DEFAULT_RUN_LOG_READ_BYTES = 256 * 1024;
const DEFAULT_RUN_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_RUN_LOG_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_WINDOWS_COMMAND_LINE_UNITS = DEFAULT_WINDOWS_SAFE_COMMAND_LINE_UNITS;
const RUN_LOG_NAME = /^\d+-[0-9a-f-]{36}\.log$/i;
const activeRunLogs = new Set();
const POSIX_PS_PATH = '/bin/ps';
const POSIX_PROCESS_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const POSIX_PROCESS_SNAPSHOT_TIMEOUT_MS = 500;
const MAX_PROCESS_SNAPSHOT_TIMEOUT_MS = 1_000;
const MAX_TERMINATION_LEASE_MS = 5_000;

export class AgyError extends Error {
  constructor(message, { code = 'AGY_ERROR', stdout = '', stderr = '', exitCode = null, cause } = {}) {
    super(message, { cause });
    this.name = 'AgyError';
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

const terminationStates = new WeakMap();

function boundedTerminationDelay(value, fallback, maximum = MAX_TERMINATION_LEASE_MS) {
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.min(Math.floor(value), maximum);
}

function parsePosixProcessTable(value) {
  const processes = new Map();
  for (const line of String(value ?? '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const groupPid = Number(match[3]);
    if (
      !Number.isSafeInteger(pid) ||
      !Number.isSafeInteger(parentPid) ||
      !Number.isSafeInteger(groupPid) ||
      pid <= 1
    ) continue;
    processes.set(pid, {
      pid,
      parentPid,
      groupPid,
      startedAt: match[4],
    });
  }
  return processes;
}

function findDescendantProcesses(processes, rootPid) {
  const children = new Map();
  for (const { pid, parentPid } of processes.values()) {
    const siblings = children.get(parentPid) ?? [];
    siblings.push(pid);
    children.set(parentPid, siblings);
  }

  const descendants = [];
  const pending = [...(children.get(rootPid) ?? [])];
  const seen = new Set([rootPid]);
  for (let index = 0; index < pending.length; index += 1) {
    const pid = pending[index];
    if (seen.has(pid)) continue;
    seen.add(pid);
    const processInfo = processes.get(pid);
    if (processInfo) descendants.push(processInfo);
    pending.push(...(children.get(pid) ?? []));
  }
  return descendants;
}

function snapshotPosixProcessTable(
  {
    spawnProcess,
    psPath = POSIX_PS_PATH,
    timeoutMs = POSIX_PROCESS_SNAPSHOT_TIMEOUT_MS,
    maxOutputBytes = POSIX_PROCESS_SNAPSHOT_BYTES,
  },
) {
  return new Promise((resolve, reject) => {
    if (!path.posix.isAbsolute(psPath)) {
      reject(new Error('POSIX process snapshot path must be absolute'));
      return;
    }

    let helper;
    let output = '';
    let outputBytes = 0;
    let settled = false;
    let watchdog = null;
    const finish = (processes) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve(processes);
    };
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      reject(new Error(message));
    };

    try {
      helper = spawnProcess(psPath, ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'lstart='], {
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        shell: false,
      });
    } catch {
      fail('Unable to start the POSIX process snapshot helper');
      return;
    }

    helper.stdout?.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        output = '';
        try {
          helper.kill?.('SIGKILL');
        } catch {
          // The snapshot helper already exited.
        }
        fail('POSIX process snapshot exceeded its output limit');
        return;
      }
      output += chunk.toString('utf8');
    });
    helper.once('error', () => fail('POSIX process snapshot helper failed'));
    helper.once('close', (code) => {
      if (code !== 0) {
        fail(`POSIX process snapshot helper exited with status ${code ?? 'unknown'}`);
        return;
      }
      const processes = parsePosixProcessTable(output);
      if (processes.size === 0) fail('POSIX process snapshot contained no usable identities');
      else finish(processes);
    });
    watchdog = setTimeout(() => {
      try {
        helper.kill?.('SIGKILL');
      } catch {
        // The snapshot helper already exited.
      }
      fail('POSIX process snapshot helper timed out');
    }, boundedTerminationDelay(
      timeoutMs,
      POSIX_PROCESS_SNAPSHOT_TIMEOUT_MS,
      MAX_PROCESS_SNAPSHOT_TIMEOUT_MS,
    ));
  });
}

function signalPosixTree(child, descendants, signal, killProcess = process.kill) {
  let groupSignalled = false;
  try {
    killProcess(-child.pid, signal);
    groupSignalled = true;
  } catch {
    // The group may already be gone or the child may not be its leader.
  }
  if (!groupSignalled) {
    try {
      child.kill(signal);
    } catch {
      // The child already exited.
    }
  }
  for (const descendant of descendants) {
    try {
      killProcess(descendant.pid, signal);
    } catch {
      // This snapshotted descendant already exited.
    }
  }
}

function signalCapturedProcesses(processes, signal, killProcess = process.kill) {
  for (const processInfo of processes) {
    try {
      killProcess(processInfo.pid, signal);
    } catch {
      // This snapshotted identity already exited.
    }
  }
}

function sameProcessIdentity(captured, current) {
  return Boolean(
    captured &&
    current &&
    captured.pid === current.pid &&
    captured.startedAt === current.startedAt
  );
}

function childIsUnreaped(child) {
  return child.exitCode == null && child.signalCode == null;
}

function forceCapturedPosixTree(
  child,
  capturedRoot,
  descendants,
  currentProcesses,
  killProcess = process.kill,
  allowGroupKill = true,
) {
  const currentRoot = currentProcesses.get(child.pid);
  const survivingRoot = sameProcessIdentity(capturedRoot, currentRoot) ? currentRoot : null;
  const survivingDescendants = descendants.filter((captured) =>
    sameProcessIdentity(captured, currentProcesses.get(captured.pid)),
  );
  const rootPidWasReused = Boolean(
    currentRoot && !sameProcessIdentity(capturedRoot, currentRoot),
  );
  // Include members created after the first snapshot. A SIGTERM handler or a
  // concurrently running tool can spawn another same-group child while the
  // leader is exiting; limiting this check to initially captured descendants
  // would release the workspace lease with that late child still alive.
  const originalGroupStillExists = allowGroupKill
    && !rootPidWasReused
    && (capturedRoot !== null || survivingDescendants.length > 0)
    && [...currentProcesses.values()].some(
      (processInfo) => processInfo.groupPid === child.pid,
    );

  if (originalGroupStillExists) {
    try {
      killProcess(-child.pid, 'SIGKILL');
    } catch {
      // Every captured member of the original group already exited.
    }
  }
  for (const descendant of survivingDescendants) {
    try {
      killProcess(descendant.pid, 'SIGKILL');
    } catch {
      // This identity-checked descendant exited after the second snapshot.
    }
  }
  if (survivingRoot && !originalGroupStillExists) {
    try {
      killProcess(survivingRoot.pid, 'SIGKILL');
    } catch {
      // The identity-checked leader exited after the second snapshot.
    }
  }

  // If process-table capture failed, ChildProcess lifecycle state is still a
  // safe identity check for the original leader. A PID cannot be reused while
  // that exact child remains unreaped, so retain the group escalation instead
  // of silently declaring termination complete.
  if (
    !originalGroupStillExists &&
    childIsUnreaped(child)
  ) {
    try {
      killProcess(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // The leader exited between its lifecycle check and the signal.
      }
    }
  }
}

export function estimateWindowsCommandLineUnits(bin, args = []) {
  return estimatePlatformWindowsCommandLineUnits(bin, args);
}

export function assertArgvSupported(
  bin,
  args,
  { platform = process.platform, maxWindowsUnits = DEFAULT_WINDOWS_COMMAND_LINE_UNITS } = {},
) {
  if (platform !== 'win32') return;
  try {
    assertWindowsCommandLineSupported(bin, args, {
      platform,
      maxUnits: maxWindowsUnits,
    });
  } catch (error) {
    if (error?.code === 'WINDOWS_COMMAND_LINE_LIMIT') {
      const match = String(error.message).match(/\((\d+) UTF-16 units; limit (\d+)\)/u);
      const units = match?.[1] ?? '?';
      const limit = match?.[2] ?? maxWindowsUnits;
      throw new AgyError(
        `agy command exceeds the safe Windows command-line limit (${units} UTF-16 units; limit ${limit})`,
        { code: 'AGY_ARGV_LIMIT', cause: error },
      );
    }
    throw new AgyError(error?.message || 'agy command arguments are invalid on Windows', {
      code: 'AGY_ARGV_LIMIT',
      cause: error,
    });
  }
}

export function terminateProcess(
  child,
  {
    platform = process.platform,
    spawnProcess = spawn,
    environment = process.env,
    forceAfterMs = 2_000,
    psPath = POSIX_PS_PATH,
    snapshotTimeoutMs = POSIX_PROCESS_SNAPSHOT_TIMEOUT_MS,
    killProcess = process.kill,
    cleanupReapedGroup = false,
  } = {},
) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 1) return Promise.resolve();
  const existing = terminationStates.get(child);
  if (existing) return existing.promise;
  let resolveLease;
  const state = {
    forceTimer: null,
    settled: false,
    promise: new Promise((resolve) => {
      resolveLease = resolve;
    }),
  };
  const finish = () => {
    if (state.settled) return;
    state.settled = true;
    clearTimeout(state.forceTimer);
    resolveLease();
  };
  terminationStates.set(child, state);
  const forceDelay = boundedTerminationDelay(forceAfterMs, 2_000);
  if (platform === 'win32') {
    const fallbackKill = () => {
      try {
        child.kill();
      } catch {
        // The child already exited.
      }
    };
    try {
      const configuredRoot = environment.SystemRoot || environment.WINDIR || 'C:\\Windows';
      const systemRoot = path.win32.isAbsolute(configuredRoot) ? configuredRoot : 'C:\\Windows';
      const systemDirectory = path.win32.join(systemRoot, 'System32');
      const killer = spawnProcess(path.win32.join(systemDirectory, 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], {
        env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: systemDirectory },
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      });
      let killerSettled = false;
      const finishKiller = (succeeded) => {
        if (killerSettled) return;
        killerSettled = true;
        clearTimeout(state.forceTimer);
        if (succeeded) {
          finish();
          return;
        }
        // taskkill is the only portable Windows tree primitive available
        // without a Job Object. If it fails, kill the leader but keep the
        // termination lease for one full grace period so callers cannot start
        // overlapping workspace work immediately.
        fallbackKill();
        state.forceTimer = setTimeout(() => {
          fallbackKill();
          finish();
        }, forceDelay);
      };
      killer.once('error', () => finishKiller(false));
      killer.once('close', (code) => finishKiller(code === 0));
      state.forceTimer = setTimeout(() => {
        try {
          killer.kill?.();
        } catch {
          // The helper already exited.
        }
        finishKiller(false);
      }, forceDelay);
    } catch {
      fallbackKill();
      state.forceTimer = setTimeout(() => {
        fallbackKill();
        finish();
      }, forceDelay);
    }
    return state.promise;
  }

  const snapshotOptions = {
    spawnProcess,
    psPath,
    timeoutMs: snapshotTimeoutMs,
  };
  // Freeze the exact leader before the asynchronous `ps` snapshot. This keeps
  // parent/child identities available long enough to discover descendants in
  // separate process groups, while closing the race where a fast leader exits
  // before the snapshot and strands same-group children.
  const leaderWasUnreaped = childIsUnreaped(child);
  let leaderStopped = false;
  if (leaderWasUnreaped) {
    try {
      leaderStopped = child.kill('SIGSTOP') !== false;
    } catch {
      leaderStopped = false;
    }
    if (!leaderStopped) signalPosixTree(child, [], 'SIGTERM', killProcess);
  }
  const resumeStoppedLeader = () => {
    if (!leaderStopped) return;
    try {
      child.kill('SIGCONT');
    } catch {
      // SIGTERM may already have removed the stopped leader.
    }
    leaderStopped = false;
  };
  void snapshotPosixProcessTable(snapshotOptions).then((processes) => {
    const leaderStillUnreaped = childIsUnreaped(child);
    if (!leaderWasUnreaped && !cleanupReapedGroup) {
      finish();
      return;
    }
    if (leaderWasUnreaped && !leaderStopped && !leaderStillUnreaped) {
      // The exact leader disappeared before SIGSTOP could establish a stable
      // snapshot boundary. The immediate group SIGTERM was safe, but identities
      // sampled afterwards may already belong to a reused PID/group.
      finish();
      return;
    }
    // If the leader was reaped while `ps` ran, do not trust a process now using
    // its numeric PID. Same-group members are still useful identities: the
    // original PGID remains allocated for as long as one of them survives.
    const capturedRoot = leaderStillUnreaped ? processes.get(child.pid) ?? null : null;
    const descendantsByPid = new Map();
    if (leaderWasUnreaped && (leaderStopped || leaderStillUnreaped)) {
      for (const processInfo of findDescendantProcesses(processes, child.pid)) {
        descendantsByPid.set(processInfo.pid, processInfo);
      }
    }
    for (const processInfo of processes.values()) {
      if (processInfo.pid !== child.pid && processInfo.groupPid === child.pid) {
        descendantsByPid.set(processInfo.pid, processInfo);
      }
    }
    const descendants = [...descendantsByPid.values()];
    if (!capturedRoot && descendants.length === 0 && !leaderWasUnreaped) {
      finish();
      return;
    }
    if (leaderWasUnreaped) {
      signalPosixTree(child, descendants, 'SIGTERM', killProcess);
    } else {
      signalCapturedProcesses(descendants, 'SIGTERM', killProcess);
    }
    resumeStoppedLeader();
    state.forceTimer = setTimeout(() => {
      void snapshotPosixProcessTable(snapshotOptions).then((currentProcesses) => {
        forceCapturedPosixTree(
          child,
          capturedRoot,
          descendants,
          currentProcesses,
          killProcess,
          leaderWasUnreaped,
        );
        finish();
      }, () => {
        // The initial snapshot proved this was the original group. If any
        // same-group descendant survived the grace period, that PGID remains
        // allocated even after the leader is reaped. Prefer a bounded group
        // escalation over releasing the workspace with live descendants.
        if (leaderWasUnreaped) {
          try {
            killProcess(-child.pid, 'SIGKILL');
          } catch {
            // The original group already disappeared.
          }
        }
        finish();
      });
    }, forceDelay);
    // This timer intentionally remains referenced. The termination lease owns
    // the task/workspace until the final escalation has happened.
  }, () => {
    if (!leaderWasUnreaped) {
      finish();
      return;
    }
    signalPosixTree(child, [], 'SIGTERM', killProcess);
    resumeStoppedLeader();
    state.forceTimer = setTimeout(() => {
      if (childIsUnreaped(child)) {
        try {
          killProcess(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // The original leader and group already disappeared.
          }
        }
      }
      finish();
    }, forceDelay);
  });
  return state.promise;
}

export function runProcess(
  bin,
  args,
  {
    cwd,
    env = {},
    timeoutMs = 330_000,
    maxOutputBytes = 2 * 1024 * 1024,
    signal,
    allowNonZero = false,
    spawnProcess = spawn,
    terminateChild = terminateProcess,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timer = null;
    let terminationWatchdog = null;
    let terminationLease = null;
    let terminationRequested = false;
    let closeHandling = false;
    let onAbort = null;
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let aborted = false;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const startedAt = Date.now();

    const failToSpawn = (error) => {
      if (settled || closeHandling) return;
      // Once cancellation/timeout owns a bounded termination lease, a later
      // ChildProcess error must not release the caller's task/workspace lock.
      // `close` settles after the lease; if close never arrives, the referenced
      // termination watchdog remains the bounded fallback.
      if (terminationRequested) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(terminationWatchdog);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      const code = error.code === 'ENOENT' ? 'AGY_NOT_FOUND' : 'AGY_SPAWN_ERROR';
      reject(new AgyError(code === 'AGY_NOT_FOUND' ? `agy executable not found: ${bin}` : 'Failed to start agy', {
        code,
        cause: error,
      }));
    };

    if (signal?.aborted) {
      reject(new AgyError('agy request was cancelled', { code: 'AGY_CANCELLED' }));
      return;
    }

    try {
      assertArgvSupported(bin, args);
    } catch (error) {
      reject(error);
      return;
    }

    try {
      const childEnvironment = env && typeof env === 'object' ? env : {};
      child = spawnProcess(bin, args, {
        cwd,
        env: { ...childEnvironment, NO_COLOR: childEnvironment.NO_COLOR || '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      failToSpawn(error);
      return;
    }

    const partialResult = () => ({
      stdout: stripVTControlCharacters(stdout + stdoutDecoder.end()).replace(/\r\n/g, '\n'),
      stderr: stripVTControlCharacters(stderr + stderrDecoder.end()).replace(/\r\n/g, '\n'),
      exitCode: null,
      signal: null,
      durationMs: Date.now() - startedAt,
    });

    const settleAfterFailedTermination = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      const result = partialResult();
      if (aborted && signal?.reason instanceof AgyError) {
        signal.reason.stdout = result.stdout;
        signal.reason.stderr = result.stderr;
        signal.reason.exitCode = null;
        reject(signal.reason);
      } else if (aborted) {
        reject(new AgyError('agy request was cancelled but its process did not exit promptly', {
          ...result,
          code: 'AGY_CANCELLED',
        }));
      } else if (timedOut) {
        reject(new AgyError(`agy exceeded the ${Math.round(timeoutMs / 1000)} second timeout`, {
          ...result,
          code: 'AGY_TIMEOUT',
        }));
      } else {
        reject(new AgyError('agy exceeded an output limit and did not exit promptly', {
          ...result,
          code: outputExceeded ? 'AGY_OUTPUT_LIMIT' : 'AGY_TERMINATION_FAILED',
        }));
      }
    };

    const requestTermination = () => {
      if (!terminationLease) {
        terminationRequested = true;
        terminationLease = terminateChild(child);
      }
      if (terminationWatchdog) return;
      terminationWatchdog = setTimeout(settleAfterFailedTermination, 7_000);
    };

    timer = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, timeoutMs);

    onAbort = () => {
      aborted = true;
      requestTermination();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        if (!outputExceeded) {
          outputExceeded = true;
          child.stdout.pause();
          child.stderr.pause();
          requestTermination();
        }
        return;
      }
      if (target === 'stdout') stdout += stdoutDecoder.write(chunk);
      else stderr += stderrDecoder.write(chunk);
    };

    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.once('error', failToSpawn);
    child.once('close', (exitCode, closeSignal) => {
      if (settled || closeHandling) return;
      closeHandling = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void (async () => {
        // A successful print process must not leave request-scoped same-group
        // background children behind. Restrict this automatic cleanup to the
        // real POSIX spawn path so injected ChildProcess test doubles are not
        // mistaken for operating-system process groups.
        if (
          !terminationLease
          && spawnProcess === spawn
          && process.platform !== 'win32'
        ) {
          terminationLease = terminateChild(child, { cleanupReapedGroup: true });
        }
        if (terminationLease) await terminationLease;
        if (settled) return;
        settled = true;
        clearTimeout(terminationWatchdog);
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        const result = {
          stdout: stripVTControlCharacters(stdout).replace(/\r\n/g, '\n'),
          stderr: stripVTControlCharacters(stderr).replace(/\r\n/g, '\n'),
          exitCode,
          signal: closeSignal,
          durationMs: Date.now() - startedAt,
        };

        if (aborted) {
          if (signal?.reason instanceof AgyError) {
            signal.reason.stdout = result.stdout;
            signal.reason.stderr = result.stderr;
            signal.reason.exitCode = result.exitCode;
            reject(signal.reason);
          } else {
            reject(new AgyError('agy request was cancelled', { ...result, code: 'AGY_CANCELLED' }));
          }
        } else if (timedOut) {
          reject(new AgyError(`agy exceeded the ${Math.round(timeoutMs / 1000)} second timeout`, {
            ...result,
            code: 'AGY_TIMEOUT',
          }));
        } else if (outputExceeded) {
          reject(new AgyError('agy output exceeded the configured size limit', {
            ...result,
            code: 'AGY_OUTPUT_LIMIT',
          }));
        } else if (exitCode !== 0 && !allowNonZero) {
          const detail = (result.stderr || result.stdout).trim().slice(-2_000);
          reject(new AgyError(`agy exited with non-zero status (${exitCode ?? 'unknown'})`, {
            ...result,
            code: isAuthRequired(detail) ? 'AGY_AUTH_REQUIRED' : 'AGY_EXIT_ERROR',
          }));
        } else {
          resolve(result);
        }
      })();
    });
  });
}

function findIdInObject(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return null;
  for (const key of ['conversationId', 'conversation_id', 'sessionId', 'session_id']) {
    if (typeof value[key] === 'string' && value[key].length >= 8) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findIdInObject(child, depth + 1);
    if (found) return found;
  }
  return null;
}

export function parseConversationId(output) {
  const text = String(output ?? '');
  const patterns = [
    /<!--\s*agy:conversation[_-]?id\s*=\s*([^\s>]+)\s*-->/i,
    /^\s*conversation(?:\s+id|Id|_id)?\s*[:=]\s*["']?([a-z0-9][a-z0-9._:-]{7,})["']?\s*$/im,
    /\bagy\s+--conversation\s+([a-z0-9][a-z0-9._:-]{7,})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }

  const candidates = [text, ...text.split('\n')];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) continue;
    try {
      const found = findIdInObject(JSON.parse(trimmed));
      if (found) return found;
    } catch {
      // Plain model output can contain JSON fragments; ignore malformed candidates.
    }
  }
  return null;
}

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function lastMatch(text, patterns) {
  let value = null;
  let lastIndex = -1;
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if ((match.index ?? -1) > lastIndex) {
        value = match[1];
        lastIndex = match.index ?? -1;
      }
    }
  }
  return value;
}

export function parseRunMetadata(output) {
  const text = String(output ?? '');
  const conversationId = lastMatch(text, [
    new RegExp(`Print mode: conversation=(${UUID_SOURCE})`, 'gi'),
    new RegExp(`Created conversation (${UUID_SOURCE})`, 'gi'),
    new RegExp(`Streaming conversation (${UUID_SOURCE})`, 'gi'),
  ]);
  const projectId = lastMatch(text, [
    new RegExp(`Conversation using project ID:\\s*(${UUID_SOURCE})`, 'gi'),
    new RegExp(`Backend project ID updated dynamically to:\\s*(${UUID_SOURCE})`, 'gi'),
    new RegExp(`project: created project .*?\\(id=(${UUID_SOURCE})\\)`, 'gi'),
  ]);
  return { conversationId, projectId };
}

async function readRange(handle, position, length) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function readBoundedRunLog(logFile, maxBytes = DEFAULT_RUN_LOG_READ_BYTES) {
  const byteLimit = Math.max(1, Math.floor(maxBytes));
  const handle = await open(logFile, 'r');
  try {
    const { size } = await handle.stat();
    if (size <= byteLimit) {
      return (await readRange(handle, 0, size)).toString('utf8');
    }

    const headBytes = Math.ceil(byteLimit / 2);
    const tailBytes = byteLimit - headBytes;
    const head = await readRange(handle, 0, headBytes);
    const tail = tailBytes > 0 ? await readRange(handle, Math.max(0, size - tailBytes), tailBytes) : Buffer.alloc(0);
    return `${head.toString('utf8')}\n[... agy run log middle omitted ...]\n${tail.toString('utf8')}`;
  } finally {
    await handle.close();
  }
}

async function readRunMetadata(logFile, maxBytes = DEFAULT_RUN_LOG_READ_BYTES) {
  return parseRunMetadata(await readBoundedRunLog(logFile, maxBytes));
}

function validateCleanupLimit(value, name) {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative number`);
  }
}

export async function cleanupAgyRunLogs(
  directory,
  {
    retentionMs = DEFAULT_RUN_LOG_RETENTION_MS,
    maxTotalBytes = DEFAULT_RUN_LOG_MAX_TOTAL_BYTES,
    now = Date.now(),
  } = {},
) {
  validateCleanupLimit(retentionMs, 'retentionMs');
  validateCleanupLimit(maxTotalBytes, 'maxTotalBytes');

  let directoryEntries;
  try {
    directoryEntries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { deletedFiles: 0, deletedBytes: 0, remainingFiles: 0, remainingBytes: 0 };
    }
    throw error;
  }

  const files = [];
  for (const entry of directoryEntries) {
    if (!entry.isFile() || !RUN_LOG_NAME.test(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    if (activeRunLogs.has(filePath)) continue;
    try {
      const info = await open(filePath, 'r');
      try {
        const stats = await info.stat();
        files.push({ filePath, name: entry.name, size: stats.size, mtimeMs: stats.mtimeMs });
      } finally {
        await info.close();
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  let deletedFiles = 0;
  let deletedBytes = 0;
  const remaining = [];
  for (const file of files) {
    if (now - file.mtimeMs >= retentionMs) {
      try {
        await rm(file.filePath, { force: true });
        deletedFiles += 1;
        deletedBytes += file.size;
        continue;
      } catch {
        // A concurrently running agy process may still own this file on Windows.
      }
    }
    remaining.push(file);
  }

  remaining.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  let remainingBytes = remaining.reduce((total, file) => total + file.size, 0);
  const lockedFiles = [];
  while (remainingBytes > maxTotalBytes && remaining.length > 0) {
    const file = remaining.shift();
    try {
      await rm(file.filePath, { force: true });
      deletedFiles += 1;
      deletedBytes += file.size;
      remainingBytes -= file.size;
    } catch {
      // Skip a locked file and continue rotating other eligible logs.
      lockedFiles.push(file);
    }
  }
  remaining.push(...lockedFiles);

  return {
    deletedFiles,
    deletedBytes,
    remainingFiles: remaining.length,
    remainingBytes,
  };
}

function cleanResponse(output) {
  return String(output ?? '').trim();
}

function parseSemverTriplet(value) {
  const normalized = String(value ?? '').trim();
  const match = normalized.match(/^v?(\d+)\.(\d+)\.(\d+)$/u);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, normalized: `${major}.${minor}.${patch}` };
}

function extractSemverTriplet(value) {
  const text = String(value ?? '');
  const match = text.match(/(?:^|[^0-9])v?(\d+)\.(\d+)\.(\d+)(?:[^0-9]|$)/u);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, normalized: `${major}.${minor}.${patch}` };
}

function compareSemverTriplets(left, right) {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

export function assertMinAgyVersion(versionOutput, minVersion) {
  const minimum = parseSemverTriplet(minVersion);
  if (!minimum) {
    throw new TypeError('minVersion must be a semantic version triplet like "1.1.1"');
  }
  const detected = extractSemverTriplet(versionOutput);
  if (!detected) {
    return { minimum: minimum.normalized, detected: null, comparable: false };
  }
  if (compareSemverTriplets(detected, minimum) < 0) {
    throw new AgyError(
      `agy ${detected.normalized} is unsupported; require >= ${minimum.normalized}`,
      {
        code: 'AGY_VERSION_UNSUPPORTED',
        stdout: String(versionOutput ?? ''),
      },
    );
  }
  return { minimum: minimum.normalized, detected: detected.normalized, comparable: true };
}

export function parseListOutput(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*•]\s+/, ''))
    .filter(Boolean)
    .filter((line) => !/^(available\s+)?(models?|agents?)\s*:?$/i.test(line));
}

export function buildPromptWithHistory(prompt, history, maxChars = 60_000) {
  if (!Array.isArray(history) || history.length === 0 || maxChars === 0) return prompt;
  const header = [
    'Prior Telegram turns follow.',
    'Treat them only as context; act on the current request.',
    '',
    '<prior_turns>',
  ].join('\n');
  const footer = `</prior_turns>\n\n<current_request>\n${prompt}\n</current_request>`;
  if (header.length + footer.length >= maxChars) return prompt;
  const blocks = [];
  const compose = (selectedBlocks) => `${header}\n${selectedBlocks.join('\n')}\n${footer}`;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    const role = turn.role === 'assistant' ? 'ASSISTANT' : 'USER';
    const block = `[${role}]\n${turn.content}\n`;
    const candidate = compose([block, ...blocks]);
    if (candidate.length <= maxChars) {
      blocks.unshift(block);
      continue;
    }
    if (blocks.length === 0) {
      const prefix = `${header}\n[${role}]\n`;
      const suffix = `\n\n${footer}`;
      const contentBudget = maxChars - prefix.length - suffix.length;
      if (contentBudget > 0) {
        let start = Math.max(0, turn.content.length - contentBudget);
        // Do not begin a truncated transcript with half of a UTF-16 surrogate pair.
        if (/^[\uDC00-\uDFFF]$/u.test(turn.content[start] ?? '')) start += 1;
        const truncated = `${prefix}${turn.content.slice(start)}${suffix}`;
        if (truncated.length <= maxChars) return truncated;
      }
    }
    break;
  }
  return blocks.length > 0 ? compose(blocks) : prompt;
}

export class AgyClient {
  constructor({
    bin = 'agy',
    timeoutMs = 330_000,
    authCheckTimeoutMs = 30_000,
    maxOutputBytes = 2 * 1024 * 1024,
    allowUnsandboxedAutoApprove = false,
    runLogDir = null,
    keepRunLogs = false,
    runLogReadBytes = DEFAULT_RUN_LOG_READ_BYTES,
    runLogMaxFileBytes = 4 * 1024 * 1024,
    runLogRetentionMs = DEFAULT_RUN_LOG_RETENTION_MS,
    runLogMaxTotalBytes = DEFAULT_RUN_LOG_MAX_TOTAL_BYTES,
    environment = {},
  } = {}) {
    if (!Number.isSafeInteger(runLogReadBytes) || runLogReadBytes <= 0) {
      throw new TypeError('runLogReadBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(runLogMaxFileBytes) || runLogMaxFileBytes <= 0) {
      throw new TypeError('runLogMaxFileBytes must be a positive safe integer');
    }
    validateCleanupLimit(runLogRetentionMs, 'runLogRetentionMs');
    validateCleanupLimit(runLogMaxTotalBytes, 'runLogMaxTotalBytes');
    this.bin = bin;
    this.timeoutMs = timeoutMs;
    this.authCheckTimeoutMs = authCheckTimeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.allowUnsandboxedAutoApprove = allowUnsandboxedAutoApprove;
    this.runLogDir = runLogDir;
    this.keepRunLogs = keepRunLogs;
    this.runLogReadBytes = runLogReadBytes;
    this.runLogMaxFileBytes = runLogMaxFileBytes;
    this.runLogRetentionMs = runLogRetentionMs;
    this.runLogMaxTotalBytes = runLogMaxTotalBytes;
    this.environment = environment;
  }

  buildPromptArgs({ prompt, session, addDirs = [], logFile = null }) {
    const args = [];
    if (logFile) args.push('--log-file', logFile);
    if (session.conversationId) args.push('--conversation', session.conversationId);
    else if (session.newProject) args.push('--new-project');
    if (!session.conversationId && session.projectId) args.push('--project', session.projectId);
    if (session.model) args.push('--model', session.model);
    if (session.agent) args.push('--agent', session.agent);
    if (session.mode) args.push('--mode', session.mode);
    for (const directory of addDirs) args.push('--add-dir', directory);
    if (session.sandbox) {
      args.push('--sandbox', '--dangerously-skip-permissions');
    } else if (this.allowUnsandboxedAutoApprove) {
      args.push('--dangerously-skip-permissions');
    }
    const cliTimeoutSeconds = Math.max(1, Math.floor((this.timeoutMs - 5_000) / 1_000));
    args.push('--print-timeout', `${cliTimeoutSeconds}s`, '--print', prompt);
    return args;
  }

  async prompt({ prompt, session, cwd, addDirs = [], signal }) {
    let logFile = null;
    let logWatchHandle = null;
    if (this.runLogDir) {
      await mkdir(this.runLogDir, { recursive: true, mode: 0o700 });
      logFile = path.join(this.runLogDir, `${Date.now()}-${randomUUID()}.log`);
      await writeFile(logFile, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      activeRunLogs.add(logFile);
      try {
        logWatchHandle = await open(logFile, 'r');
      } catch (error) {
        activeRunLogs.delete(logFile);
        throw error;
      }
    }

    let effectiveSignal = signal;
    let logWatchTimer = null;
    let forwardAbort = null;
    if (logFile) {
      const controller = new AbortController();
      forwardAbort = () => controller.abort(signal?.reason);
      if (signal?.aborted) forwardAbort();
      else signal?.addEventListener('abort', forwardAbort, { once: true });
      effectiveSignal = controller.signal;
      let checking = false;
      logWatchTimer = setInterval(async () => {
        if (checking || controller.signal.aborted) return;
        checking = true;
        try {
          const info = await logWatchHandle.stat();
          if (info.size > this.runLogMaxFileBytes) {
            controller.abort(new AgyError('agy run log exceeded the per-run limit', {
              code: 'AGY_RUN_LOG_LIMIT',
            }));
          }
        } catch (error) {
          if (error.code !== 'ENOENT') {
            controller.abort(new AgyError('agy run log could not be monitored', {
              code: 'AGY_RUN_LOG_WATCH_FAILED',
            }));
          }
        } finally {
          checking = false;
        }
      }, 250);
      logWatchTimer.unref?.();
    }

    let result;
    let failure;
    try {
      result = await runProcess(
        this.bin,
        this.buildPromptArgs({ prompt, session, addDirs, logFile }),
        {
          cwd,
          timeoutMs: this.timeoutMs,
          maxOutputBytes: this.maxOutputBytes,
          signal: effectiveSignal,
          env: this.environment,
        },
      );
    } catch (error) {
      failure = error;
    } finally {
      clearInterval(logWatchTimer);
      signal?.removeEventListener('abort', forwardAbort);
      if (logWatchHandle) {
        try {
          const finalLogInfo = await logWatchHandle.stat();
          if (finalLogInfo.size > this.runLogMaxFileBytes) {
            failure = new AgyError('agy run log exceeded the per-run limit', {
              code: 'AGY_RUN_LOG_LIMIT',
            });
          }
        } catch (error) {
          if (!failure && error.code !== 'ENOENT') {
            failure = new AgyError('agy run log could not be monitored', {
              code: 'AGY_RUN_LOG_WATCH_FAILED',
              cause: error,
            });
          }
        }
      }
      await logWatchHandle?.close().catch(() => {});
    }

    let metadata = { conversationId: null, projectId: null };
    if (logFile) {
      metadata = await readRunMetadata(logFile, this.runLogReadBytes).catch(() => metadata);
      if (this.keepRunLogs) {
        await cleanupAgyRunLogs(this.runLogDir, {
          retentionMs: this.runLogRetentionMs,
          maxTotalBytes: this.runLogMaxTotalBytes,
        }).catch(() => {});
      } else {
        await rm(logFile, { force: true }).catch(() => {});
      }
      activeRunLogs.delete(logFile);
    }
    // Only trust the CLI-owned run log. Model stdout is untrusted and can contain
    // arbitrary UUID-shaped text or fake resume instructions.
    if (failure) {
      failure.conversationId = metadata.conversationId;
      failure.projectId = metadata.projectId;
      throw failure;
    }
    const text = cleanResponse(result.stdout);
    if (!text) {
      throw new AgyError('agy returned no response text', {
        code: 'AGY_EMPTY_OUTPUT',
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    }
    return {
      text,
      conversationId: metadata.conversationId,
      projectId: metadata.projectId,
      durationMs: result.durationMs,
    };
  }

  async models({ cwd, signal } = {}) {
    const result = await runProcess(this.bin, ['models'], {
      cwd,
      timeoutMs: this.authCheckTimeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      signal,
      env: this.environment,
    });
    return parseListOutput(result.stdout);
  }

  async agents({ cwd, signal } = {}) {
    const result = await runProcess(this.bin, ['agents'], {
      cwd,
      timeoutMs: this.authCheckTimeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      signal,
      env: this.environment,
    });
    return parseListOutput(result.stdout);
  }

  async version({ cwd, signal } = {}) {
    const result = await runProcess(this.bin, ['--version'], {
      cwd,
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
      signal,
      env: this.environment,
    });
    return result.stdout.trim() || result.stderr.trim();
  }

  async assertCompatibleVersion({
    cwd,
    signal,
    minVersion,
    enforce = true,
  } = {}) {
    const version = await this.version({ cwd, signal });
    try {
      const parsed = assertMinAgyVersion(version, minVersion);
      if (!parsed.comparable) {
        return {
          ok: null,
          minimum: parsed.minimum,
          detected: null,
          raw: version,
          reason: 'AGY_VERSION_UNPARSEABLE',
        };
      }
      return { ok: true, ...parsed, raw: version };
    } catch (error) {
      if (!enforce && error instanceof AgyError && error.code === 'AGY_VERSION_UNSUPPORTED') {
        return {
          ok: false,
          minimum: String(minVersion ?? ''),
          detected: null,
          raw: version,
          reason: error.message,
        };
      }
      throw error;
    }
  }

  async catalogStatus({ cwd, signal } = {}) {
    try {
      const models = await this.models({ cwd, signal });
      return { available: true, models };
    } catch (error) {
      if (error instanceof AgyError) {
        return {
          available: false,
          reason: error.code,
          detail: (error.stderr || error.stdout || error.message).trim().slice(-1_000),
        };
      }
      throw error;
    }
  }

  async authenticationStatus({ cwd, signal } = {}) {
    const prompt = 'Reply with exactly AGY_AUTH_OK. Do not use tools or modify files.';
    try {
      const result = await runProcess(this.bin, [
        '--mode',
        'plan',
        '--print-timeout',
        '10s',
        '--print',
        prompt,
      ], {
        cwd,
        timeoutMs: Math.min(this.authCheckTimeoutMs, 15_000),
        maxOutputBytes: Math.min(this.maxOutputBytes, 256 * 1024),
        signal,
        env: this.environment,
      });
      const text = cleanResponse(`${result.stdout}\n${result.stderr}`);
      return {
        authenticated: /\bAGY_AUTH_OK\b/.test(text),
        reason: null,
        detail: text.slice(-1_000),
      };
    } catch (error) {
      if (error instanceof AgyError) {
        return {
          authenticated: false,
          reason: error.code,
          detail: (error.stderr || error.stdout || error.message).trim().slice(-1_000),
        };
      }
      throw error;
    }
  }

}

export const _private = {
  AUTH_PATTERN,
  isAuthRequired,
  compareSemverTriplets,
  extractSemverTriplet,
  findDescendantProcesses,
  findIdInObject,
  parseSemverTriplet,
  quoteWindowsArgument,
  readBoundedRunLog,
  readRunMetadata,
  snapshotPosixProcessTable,
  terminateProcess,
};
