import path from 'node:path';
import dotenv from 'dotenv';

import { cleanupAgyRunLogs, _private as agyPrivate } from './agy.js';
import { ActivityTracker } from './activity.js';
import { cleanupAtomicArtifacts } from './artifacts.js';
import { runTelegramApp } from './bot/app.js';
import { detach } from './bot/util.js';
import { loadConfig } from './config.js';
import { cleanupExpiredUploads } from './files.js';
import { HealthWriter } from './health.js';
import { acquireInstanceLock } from './instance-lock.js';
import { JobStore } from './job-store.js';
import {
  assertManagedRuntimeTrust,
  ensureManagedDataLayout,
} from './managed-runtime.js';
import { reconcileCrossStoreRecovery } from './recovery.js';
import { ResultStore } from './results.js';
import { assertRuntimeFilesystemTrust } from './runtime-trust.js';
import {
  releaseInstanceLockIfQuiescent,
  waitForLifecycleQuiescence,
} from './shutdown.js';
import {
  buildServiceStopRequestPath,
  ServiceStopRequestMonitor,
} from './service/stop-request.js';
import {
  parseFileRunnerArguments,
  resolveRuntimeEnvFile,
} from './service/runtime-paths.js';
import { StateStore } from './state.js';
import {
  hasActiveTelegramCalls,
  classifyTelegramError,
  shutdownTelegramCalls,
  waitForTelegramIdle,
} from './telegram.js';
import { UsageStore } from './usage-store.js';
import { prepareWorkspaces, resolveWorkspace } from './workspace.js';

const runtimeArguments = parseFileRunnerArguments(process.argv.slice(2));
const pinnedServicePath = runtimeArguments.dataDir ? process.env.PATH : undefined;
const pinnedStopRequestPath = process.env.AGYGRAM_SERVICE_STOP_REQUEST_PATH;
const runtimeEnvFile = resolveRuntimeEnvFile({
  projectDir: process.cwd(),
  configuredEnvFile: runtimeArguments.envFile,
});

// On POSIX, verify the optional secret file and its full path before dotenv
// evaluates it. Runtime data directories are checked again after config load.
if (process.platform !== 'win32') {
  await assertRuntimeFilesystemTrust({ envFile: runtimeEnvFile, dataDirectories: [] });
}
const environmentResult = dotenv.config({
  path: runtimeEnvFile,
  override: runtimeArguments.envFile != null,
  quiet: true,
});
if (runtimeArguments.envFile && environmentResult.error) throw environmentResult.error;
if (runtimeArguments.dataDir) process.env.DATA_DIR = runtimeArguments.dataDir;
if (pinnedServicePath != null) process.env.PATH = pinnedServicePath;
if (pinnedStopRequestPath != null) {
  process.env.AGYGRAM_SERVICE_STOP_REQUEST_PATH = pinnedStopRequestPath;
}

async function main() {
  const config = loadConfig();
  const uploadActiveLeaseMaxAgeMs =
    config.agyQueueTimeoutMs + config.agyTimeoutMs + 5 * 60 * 1_000;
  if (process.platform === 'win32' && !config.windowsAclVerified) {
    throw new Error(
      `Windows ACL verification is required. Restrict ${runtimeEnvFile} and DATA_DIR to the service user, then set WINDOWS_ACL_VERIFIED=true.`,
    );
  }

  const { managedDataFiles, managedDataDirectories } = await ensureManagedDataLayout(config);
  await assertManagedRuntimeTrust({
    config,
    envFile: runtimeEnvFile,
    managedDataFiles,
    managedDataDirectories,
  });

  const instanceLock = await acquireInstanceLock(path.join(config.dataDir, 'bot.lock'));
  let maintenanceTimer = null;
  let serviceStopMonitor = null;
  let runtimeTasks = null;
  let runtimeAuth = null;
  let runtimeLifecycle = null;
  let runtimeAdmissions = null;
  const backgroundActivities = new ActivityTracker();
  try {
    const configuredStopRequestPath = process.env.AGYGRAM_SERVICE_STOP_REQUEST_PATH;
    if (configuredStopRequestPath) {
      const expectedStopRequestPath = buildServiceStopRequestPath(config.dataDir);
      const normalizeStopPath = (value) => {
        const resolved = path.resolve(value);
        return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
      };
      if (normalizeStopPath(configuredStopRequestPath) !== normalizeStopPath(expectedStopRequestPath)) {
        throw new Error('service stop-request path does not match DATA_DIR');
      }
      serviceStopMonitor = new ServiceStopRequestMonitor({
        requestPath: expectedStopRequestPath,
      });
      await serviceStopMonitor.start();
    }

    const results = await new ResultStore(config.resultsDir, {
      maxResultBytes: config.agyMaxOutputBytes,
      maxTotalBytes: config.maxResultStorageBytes,
      retentionMs: config.resultRetentionHours * 60 * 60 * 1_000,
    }).init({ cleanup: false });

    const cleanupRuntime = () => Promise.all([
      cleanupExpiredUploads(config.uploadsDir, {
        retentionMs: config.uploadRetentionHours * 60 * 60 * 1_000,
        maxTotalBytes: config.maxUploadStorageBytes,
        activeLeaseMaxAgeMs: uploadActiveLeaseMaxAgeMs,
      }).catch((error) => console.warn('Upload cleanup failed', error.message)),
      cleanupAgyRunLogs(config.agyRunLogDir, {
        retentionMs: config.agyRunLogRetentionHours * 60 * 60 * 1_000,
        maxTotalBytes: config.maxAgyRunLogStorageBytes,
      }).catch((error) => console.warn('agy run-log cleanup failed', error.message)),
      results.cleanup().catch((error) => console.warn('Result cleanup failed', error.message)),
      cleanupAtomicArtifacts({
        stateFile: config.stateFile,
        jobFile: config.jobFile,
        usageFile: config.usageFile,
        resultsDir: config.resultsDir,
        retentionMs: 24 * 60 * 60 * 1_000,
        maxCorruptBackups: 3,
      }).catch((error) => console.warn('Atomic artifact cleanup failed', error.message)),
    ]);

    const allowedRoots = await prepareWorkspaces(config.workspaceDir, config.allowedWorkspaceRoots);
    const defaultWorkspace = await resolveWorkspace(config.workspaceDir, {
      defaultWorkspace: config.workspaceDir,
      allowedRoots,
    });

    const state = new StateStore(config.stateFile, {
      mode: config.defaultMode,
      sandbox: config.defaultSandbox,
      workspaceDir: defaultWorkspace,
    }, {
      maxSessions: config.maxStateSessions,
      maxBytes: config.maxStateBytes,
      retentionMs: config.stateRetentionHours * 60 * 60 * 1_000,
    });
    await state.init();
    const jobs = new JobStore(config.jobFile, {
      maxJobs: config.jobHistoryLimit,
      maxBytes: config.jobJournalMaxBytes,
      maxResponseChars: config.jobResponseMaxChars,
      updateTombstoneRetentionMs: config.updateTombstoneRetentionMs,
      maxUpdateTombstones: config.maxUpdateTombstones,
      maxUpdateTombstoneBytes: config.maxUpdateTombstoneBytes,
      secrets: [config.botToken],
    });
    await jobs.init();
    const recoveryCandidates = jobs.restartRecoveryCandidates();
    const recovery = await reconcileCrossStoreRecovery({ jobs, state, results });
    if (recovery.candidates > 0) {
      console.warn('Reconciled interrupted jobs after restart', recovery);
    }
    // Result cleanup is deliberately deferred until cross-store recovery has
    // acquired and reconciled every crash-window result. Session TTL pruning is
    // also delayed so it cannot erase the only durable completion marker first.
    await cleanupRuntime();
    await state.pruneExpired();
    const usage = await new UsageStore(config.usageFile, {
      windowMs: config.usageWindowMs,
      maxJobsPerUser: config.maxAgyJobsPerUserPerWindow,
      maxJobsGlobal: config.maxAgyJobsGlobalPerWindow,
      dailyRuntimeMsPerUser: config.maxAgyRuntimeMsPerUserPerDay,
      dailyRuntimeMsGlobal: config.maxAgyRuntimeMsGlobalPerDay,
      reservationMs: config.agyTimeoutMs,
      retentionDays: config.usageRetentionDays,
      maxBytes: config.usageStoreMaxBytes,
    }).init();
    const health = new HealthWriter(config.dataDir);
    const runMaintenance = () => Promise.all([
      cleanupRuntime(),
      state.pruneExpired().catch((error) => console.warn('State cleanup failed', error.message)),
      usage.prune().catch((error) => console.warn('Usage cleanup failed', error.message)),
      health.write().catch((error) => console.warn('Health snapshot failed', error.message)),
    ]).then(async () => {
      const mem = process.memoryUsage();
      console.log(
        'Maintenance cycle complete · rss %d MiB · heap %d/%d MiB · external %d MiB · uptime %d s',
        Math.round(mem.rss / 1024 / 1024),
        Math.round(mem.heapUsed / 1024 / 1024),
        Math.round(mem.heapTotal / 1024 / 1024),
        Math.round(mem.external / 1024 / 1024),
        Math.round(process.uptime()),
      );
      if (process.platform !== 'win32') {
        try {
          const table = await agyPrivate.snapshotPosixProcessTable({});
          const orphans = agyPrivate.findDescendantProcesses(table, process.pid);
          if (orphans.length > 0 && !runtimeTasks?.hasAnyActive()) {
            console.warn(
              'Detected %d descendant process(es) with no active agy task — possible orphan leak: %s',
              orphans.length,
              orphans.map((p) => `pid=${p.pid}`).join(', '),
            );
          }
        } catch {
          // Process table snapshot is best-effort; skip on failure.
        }
      }
    });
    maintenanceTimer = setInterval(() => {
      detach(runMaintenance(), 'runtime-maintenance', backgroundActivities);
    }, 60 * 60 * 1_000);
    maintenanceTimer.unref?.();

    await runTelegramApp({
      config,
      defaultWorkspace,
      allowedRoots,
      results,
      state,
      jobs,
      usage,
      recoveryCandidates,
      uploadActiveLeaseMaxAgeMs,
      backgroundActivities,
      serviceStopMonitor,
      onRuntimeReady: ({ tasks, auth, admissions, lifecycle }) => {
        runtimeTasks = tasks;
        runtimeAuth = auth;
        runtimeAdmissions = admissions;
        runtimeLifecycle = lifecycle;
        health.register(() => ({
          activeTasks: tasks?.activeCount ?? 0,
          queuedTasks: tasks?.queuedCount ?? 0,
          pendingAdmissions: admissions?.size ?? 0,
          stopping: lifecycle?.stopping ?? false,
        }));
      },
    });
  } finally {
    clearInterval(maintenanceTimer);
    serviceStopMonitor?.close();
    const shutdownReason = new Error('Application shutting down');
    backgroundActivities.close();
    runtimeAdmissions?.close(shutdownReason);
    runtimeTasks?.cancelAll(shutdownReason);
    runtimeAuth?.cancelAll();
    shutdownTelegramCalls(shutdownReason);

    const shutdownTimeoutMs = 8_000;
    const [
      tasksIdle,
      authIdle,
      admissionsIdle,
      backgroundIdle,
      transportIdle,
      lifecycleIdle,
    ] = await Promise.all([
      runtimeTasks?.waitForIdle(shutdownTimeoutMs) ?? true,
      runtimeAuth?.waitForIdle(shutdownTimeoutMs) ?? true,
      runtimeAdmissions?.waitForIdle(shutdownTimeoutMs) ?? true,
      backgroundActivities.waitForIdle(shutdownTimeoutMs),
      waitForTelegramIdle(shutdownTimeoutMs),
      waitForLifecycleQuiescence(runtimeLifecycle, shutdownTimeoutMs),
    ]);
    await releaseInstanceLockIfQuiescent({
      instanceLock,
      lifecycle: runtimeLifecycle,
      componentResults: [
        { name: 'tasks', component: runtimeTasks, idle: tasksIdle },
        { name: 'auth', component: runtimeAuth, idle: authIdle },
        { name: 'admissions', component: runtimeAdmissions, idle: admissionsIdle },
        { name: 'background', component: backgroundActivities, idle: backgroundIdle },
        { name: 'lifecycle', component: null, idle: lifecycleIdle },
      ],
      transportIdle,
      transportActive: hasActiveTelegramCalls(),
    });
  }
}

main().catch((error) => {
  const classification = classifyTelegramError(error);
  if (classification.status === 401) {
    console.error(
      'Fatal: Telegram returned 401 Unauthorized. The BOT_TOKEN is invalid or revoked. '
      + 'Verify the token with @BotFather and update .env. Restarting will not help until the token is fixed.',
    );
  } else if (classification.status === 409) {
    console.error(
      'Fatal: Telegram returned 409 Conflict. Another bot instance is polling with the same token. '
      + 'Stop the other instance or check for a stale process. Restarting will not help until the conflict is resolved.',
    );
  } else {
    console.error('Fatal startup error', error);
  }
  process.exitCode = 1;
});
