import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  _private,
  AgyClient,
  AgyError,
  assertMinAgyVersion,
  assertArgvSupported,
  buildPromptWithHistory,
  cleanupAgyRunLogs,
  estimateWindowsCommandLineUnits,
  parseConversationId,
  parseListOutput,
  parseRunMetadata,
  runProcess,
  terminateProcess,
} from '../src/agy.js';

async function assertProcessGone(pid, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} remained alive after termination lease`);
}

test('parseConversationId supports metadata, resume hints, and JSON', () => {
  assert.equal(parseConversationId('<!-- agy:conversation_id=abc-123456 -->'), 'abc-123456');
  assert.equal(parseConversationId('Resume: agy --conversation deadbeef-1234'), 'deadbeef-1234');
  assert.equal(parseConversationId('{"metadata":{"conversationId":"json-id-1234"}}'), 'json-id-1234');
  assert.equal(parseConversationId('ordinary response without metadata'), null);
});

test('assertMinAgyVersion accepts compatible outputs and rejects old versions', () => {
  assert.deepEqual(
    assertMinAgyVersion('agy 1.2.3', '1.1.1'),
    { minimum: '1.1.1', detected: '1.2.3', comparable: true },
  );
  assert.deepEqual(
    assertMinAgyVersion('agy version unknown', '1.1.1'),
    { minimum: '1.1.1', detected: null, comparable: false },
  );
  assert.throws(
    () => assertMinAgyVersion('agy 1.0.9', '1.1.1'),
    (error) => error instanceof AgyError && error.code === 'AGY_VERSION_UNSUPPORTED',
  );
});

test('AgyClient compatibility check can warn instead of failing when enforcement is disabled', async () => {
  const client = new AgyClient();
  client.version = async () => 'agy 1.0.0';
  const compatibility = await client.assertCompatibleVersion({
    minVersion: '1.1.1',
    enforce: false,
  });
  assert.equal(compatibility.ok, false);
  assert.match(compatibility.reason, /unsupported/i);
});

test('parseRunMetadata recovers native IDs from an agy run log', () => {
  const metadata = parseRunMetadata(`
    project: created project "demo" (id=34fe801c-6f17-4624-88d4-18e9fad8dd51)
    Created conversation 010f1adb-b94b-4436-86e8-6afb2028c759
    Print mode: conversation=010f1adb-b94b-4436-86e8-6afb2028c759, sending message
  `);
  assert.deepEqual(metadata, {
    conversationId: '010f1adb-b94b-4436-86e8-6afb2028c759',
    projectId: '34fe801c-6f17-4624-88d4-18e9fad8dd51',
  });
});

test('parseRunMetadata never trusts model-shaped conversation metadata', () => {
  assert.deepEqual(
    parseRunMetadata(
      'conversationId: attacker-controlled-id\nagy --conversation deadbeef-1234\n' +
        '{"conversationId":"fake-json-id"}',
    ),
    { conversationId: null, projectId: null },
  );
});

test('parseRunMetadata selects the latest project ID by log position', () => {
  const metadata = parseRunMetadata(`
    project: created project "demo" (id=11111111-1111-1111-1111-111111111111)
    Backend project ID updated dynamically to: 22222222-2222-2222-2222-222222222222
  `);
  assert.equal(metadata.projectId, '22222222-2222-2222-2222-222222222222');
});

test('bounded run-log reading recovers metadata from both edges without loading the middle', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-run-log-'));
  const logFile = path.join(root, '1-00000000-0000-0000-0000-000000000001.log');
  try {
    await writeFile(
      logFile,
      [
        'Conversation using project ID: 11111111-1111-1111-1111-111111111111\n',
        'x'.repeat(512 * 1024),
        '\nPrint mode: conversation=22222222-2222-2222-2222-222222222222, sending message\n',
      ].join(''),
    );
    const excerpt = await _private.readBoundedRunLog(logFile, 4 * 1024);
    assert.ok(Buffer.byteLength(excerpt) < 5 * 1024);
    assert.match(excerpt, /middle omitted/);
    const metadata = await _private.readRunMetadata(logFile, 4 * 1024);
    assert.deepEqual(metadata, {
      conversationId: '22222222-2222-2222-2222-222222222222',
      projectId: '11111111-1111-1111-1111-111111111111',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleanupAgyRunLogs applies retention and oldest-first total-size rotation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-run-log-cleanup-'));
  const now = Date.now();
  const old = path.join(root, '1-00000000-0000-0000-0000-000000000001.log');
  const middle = path.join(root, '2-00000000-0000-0000-0000-000000000002.log');
  const newest = path.join(root, '3-00000000-0000-0000-0000-000000000003.log');
  try {
    await Promise.all([
      writeFile(old, 'old-old'),
      writeFile(middle, 'middle'),
      writeFile(newest, 'newest'),
      writeFile(path.join(root, 'do-not-delete.txt'), 'unrelated'),
    ]);
    await utimes(old, new Date(now - 20_000), new Date(now - 20_000));
    await utimes(middle, new Date(now - 2_000), new Date(now - 2_000));
    await utimes(newest, new Date(now - 1_000), new Date(now - 1_000));

    const result = await cleanupAgyRunLogs(root, {
      retentionMs: 10_000,
      maxTotalBytes: 6,
      now,
    });
    assert.equal(result.deletedFiles, 2);
    assert.equal(result.remainingFiles, 1);
    assert.equal(result.remainingBytes, 6);
    assert.deepEqual((await readdir(root)).sort(), [
      '3-00000000-0000-0000-0000-000000000003.log',
      'do-not-delete.txt',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('AgyClient aborts a run whose private log exceeds its hard per-run limit', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-log-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shim = path.join(root, 'fake-agy');
  await writeFile(
    shim,
    `#!/usr/bin/env node\nconst fs=require('node:fs');const i=process.argv.indexOf('--log-file');fs.writeFileSync(process.argv[i+1],'x'.repeat(8192));setInterval(()=>{},1000);\n`,
  );
  await chmod(shim, 0o755);
  const client = new AgyClient({
    bin: shim,
    timeoutMs: 5_000,
    runLogDir: path.join(root, 'logs'),
    runLogMaxFileBytes: 1_024,
    environment: { PATH: process.env.PATH },
  });
  await assert.rejects(
    client.prompt({
      prompt: 'safe',
      cwd: root,
      session: {
        conversationId: null,
        projectId: null,
        model: null,
        agent: null,
        mode: 'plan',
        sandbox: true,
        newProject: true,
      },
    }),
    (error) => error.code === 'AGY_RUN_LOG_LIMIT',
  );
});

test('AgyClient checks the final opened run-log handle when agy exits before the watcher tick', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-log-final-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shim = path.join(root, 'fast-fake-agy');
  await writeFile(
    shim,
    `#!/usr/bin/env node\nconst fs=require('node:fs');const i=process.argv.indexOf('--log-file');fs.writeFileSync(process.argv[i+1],'x'.repeat(8192));process.stdout.write('done');\n`,
  );
  await chmod(shim, 0o755);
  const client = new AgyClient({
    bin: shim,
    timeoutMs: 5_000,
    runLogDir: path.join(root, 'logs'),
    runLogMaxFileBytes: 1_024,
    environment: { PATH: process.env.PATH },
  });
  await assert.rejects(
    client.prompt({
      prompt: 'safe',
      cwd: root,
      session: {
        conversationId: null,
        projectId: null,
        model: null,
        agent: null,
        mode: 'plan',
        sandbox: true,
        newProject: true,
      },
    }),
    (error) => error.code === 'AGY_RUN_LOG_LIMIT',
  );
});

test('parseListOutput handles current agy model and empty agent output', () => {
  assert.deepEqual(parseListOutput('Gemini 3.5 Flash (High)\nClaude Opus 4.6 (Thinking)\n'), [
    'Gemini 3.5 Flash (High)',
    'Claude Opus 4.6 (Thinking)',
  ]);
  assert.deepEqual(parseListOutput('Available agents:\n'), []);
});

test('AgyClient builds argument arrays without shell interpolation', () => {
  const client = new AgyClient({ timeoutMs: 20_000 });
  const prompt = 'test "quoted" $(touch /tmp/never) --flag';
  const args = client.buildPromptArgs({
    prompt,
    addDirs: ['/tmp/safe dir'],
    session: {
      conversationId: 'conv-12345678',
      projectId: null,
      model: 'Gemini 3.5 Flash (High)',
      agent: null,
      mode: 'accept-edits',
      sandbox: true,
      newProject: false,
    },
  });
  assert.deepEqual(args.slice(0, 2), ['--conversation', 'conv-12345678']);
  assert.ok(args.includes('--sandbox'));
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.equal(args.at(-1), prompt);
});

test('AgyClient adds unsandboxed auto-approve only when explicitly enabled', () => {
  const session = {
    conversationId: null,
    projectId: null,
    model: null,
    agent: null,
    mode: 'accept-edits',
    sandbox: false,
    newProject: true,
  };
  const safeClient = new AgyClient({ timeoutMs: 20_000 });
  const yoloClient = new AgyClient({ timeoutMs: 20_000, allowUnsandboxedAutoApprove: true });

  const safeArgs = safeClient.buildPromptArgs({ prompt: 'x', session });
  const yoloArgs = yoloClient.buildPromptArgs({ prompt: 'x', session });

  assert.equal(safeArgs.includes('--dangerously-skip-permissions'), false);
  assert.equal(yoloArgs.includes('--sandbox'), false);
  assert.equal(yoloArgs.includes('--dangerously-skip-permissions'), true);
});

test('runProcess passes hostile-looking values literally', async () => {
  const payload = '$(printf injected); `whoami`; hello world';
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', payload], {
    timeoutMs: 5_000,
  });
  assert.equal(result.stdout, payload);
});

test('runProcess and AgyClient default to a fail-closed child environment', async () => {
  const secretName = `AGY_TEST_PARENT_SECRET_${process.pid}`;
  process.env[secretName] = 'must-not-leak';
  try {
    const script = `process.stdout.write(process.env[${JSON.stringify(secretName)}] || '')`;
    const result = await runProcess(process.execPath, ['-e', script], { timeoutMs: 2_000 });
    assert.equal(result.stdout, '');
    assert.deepEqual(new AgyClient().environment, {});
  } finally {
    delete process.env[secretName];
  }
});

test('Windows command-line sizing uses UTF-16 units and fails before spawn', () => {
  assert.equal(estimateWindowsCommandLineUnits('agy', ['😀']), 7);
  assert.doesNotThrow(() =>
    assertArgvSupported('agy', ['short prompt'], { platform: 'win32', maxWindowsUnits: 100 }),
  );
  assert.throws(
    () => assertArgvSupported('agy', ['x'.repeat(100)], { platform: 'win32', maxWindowsUnits: 50 }),
    (error) => error instanceof AgyError && error.code === 'AGY_ARGV_LIMIT' && !error.message.includes('xxxxx'),
  );
});

test('Windows process termination falls back when taskkill exits non-zero', async () => {
  const killer = new EventEmitter();
  killer.unref = () => {};
  killer.kill = () => true;
  let fallbackCalls = 0;
  const child = { pid: 1234, kill: () => { fallbackCalls += 1; return true; } };

  const lease = terminateProcess(child, {
    platform: 'win32',
    spawnProcess: () => killer,
    environment: { SystemRoot: 'C:\\Windows' },
    forceAfterMs: 100,
  });
  killer.emit('close', 1);
  await lease;

  assert.equal(fallbackCalls, 2);
});

test('Windows process termination has a bounded helper watchdog', async () => {
  const killer = new EventEmitter();
  killer.unref = () => {};
  let helperKillCalls = 0;
  killer.kill = () => { helperKillCalls += 1; return true; };
  let fallbackCalls = 0;
  const child = { pid: 5678, kill: () => { fallbackCalls += 1; return true; } };

  await terminateProcess(child, {
    platform: 'win32',
    spawnProcess: () => killer,
    forceAfterMs: 10,
  });

  assert.equal(helperKillCalls, 1);
  assert.equal(fallbackCalls, 2);
});

test('POSIX termination keeps group escalation when process snapshots fail', { skip: process.platform === 'win32' }, async () => {
  const signals = [];
  const child = {
    pid: 123_456,
    exitCode: null,
    signalCode: null,
    kill: (signal) => {
      signals.push([123_456, signal]);
      return true;
    },
  };
  const failedSnapshot = () => {
    const helper = new EventEmitter();
    helper.stdout = new PassThrough();
    helper.kill = () => true;
    queueMicrotask(() => helper.emit('error', new Error('ps unavailable')));
    return helper;
  };

  await terminateProcess(child, {
    platform: process.platform,
    spawnProcess: failedSnapshot,
    forceAfterMs: 10,
    snapshotTimeoutMs: 10,
    killProcess: (pid, signal) => signals.push([pid, signal]),
  });

  assert.deepEqual(signals, [
    [123_456, 'SIGSTOP'],
    [-123_456, 'SIGTERM'],
    [123_456, 'SIGCONT'],
    [-123_456, 'SIGKILL'],
  ]);
});

test('POSIX termination force-kills the captured group when the second snapshot fails', {
  skip: process.platform === 'win32',
}, async () => {
  const signals = [];
  let snapshotCalls = 0;
  const child = {
    pid: 123_457,
    // Model a leader that exits on SIGTERM while a same-group descendant remains.
    exitCode: null,
    signalCode: null,
    kill: () => true,
  };
  const snapshotThenFailure = () => {
    snapshotCalls += 1;
    const helper = new EventEmitter();
    helper.stdout = new PassThrough();
    helper.kill = () => true;
    queueMicrotask(() => {
      if (snapshotCalls === 1) {
        helper.stdout.end(
          '123457 1 123457 Sun Jul 12 10:00:00 2026\n' +
          '123458 123457 123457 Sun Jul 12 10:00:01 2026\n',
        );
        helper.emit('close', 0);
      } else {
        helper.emit('error', new Error('second ps unavailable'));
      }
    });
    return helper;
  };

  await terminateProcess(child, {
    platform: process.platform,
    spawnProcess: snapshotThenFailure,
    forceAfterMs: 10,
    snapshotTimeoutMs: 10,
    killProcess: (pid, signal) => {
      signals.push([pid, signal]);
      if (pid === -123_457 && signal === 'SIGTERM') child.exitCode = 0;
    },
  });

  assert.deepEqual(signals, [
    [-123_457, 'SIGTERM'],
    [123_458, 'SIGTERM'],
    [-123_457, 'SIGKILL'],
  ]);
});

test('POSIX force escalation never signals a PID whose start identity changed', { skip: process.platform === 'win32' }, async () => {
  const tables = [
    [
      '100 1 100 Sun Jul 12 10:00:00 2026',
      '200 100 200 Sun Jul 12 10:00:01 2026',
    ].join('\n'),
    '200 1 200 Sun Jul 12 10:00:05 2026',
  ];
  const signals = [];
  const child = {
    pid: 100,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  };
  const snapshot = () => {
    const helper = new EventEmitter();
    helper.stdout = new PassThrough();
    helper.kill = () => true;
    const table = tables.shift() ?? '';
    queueMicrotask(() => {
      helper.stdout.end(table);
      helper.emit('close', 0);
    });
    return helper;
  };

  await terminateProcess(child, {
    platform: process.platform,
    spawnProcess: snapshot,
    forceAfterMs: 10,
    snapshotTimeoutMs: 10,
    killProcess: (pid, signal) => {
      signals.push([pid, signal]);
      if (pid === -100 && signal === 'SIGTERM') child.exitCode = 0;
    },
  });

  assert.deepEqual(signals, [
    [-100, 'SIGTERM'],
    [200, 'SIGTERM'],
  ]);
});

test('POSIX force escalation rejects an entire group whose leader PID was reused', { skip: process.platform === 'win32' }, async () => {
  const tables = [
    '100 1 100 Sun Jul 12 10:00:00 2026',
    [
      '100 1 100 Sun Jul 12 10:00:05 2026',
      '300 100 100 Sun Jul 12 10:00:05 2026',
    ].join('\n'),
  ];
  const signals = [];
  const child = {
    pid: 100,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  };
  const snapshot = () => {
    const helper = new EventEmitter();
    helper.stdout = new PassThrough();
    helper.kill = () => true;
    const table = tables.shift() ?? '';
    queueMicrotask(() => {
      helper.stdout.end(table);
      helper.emit('close', 0);
    });
    return helper;
  };

  await terminateProcess(child, {
    platform: process.platform,
    spawnProcess: snapshot,
    forceAfterMs: 10,
    snapshotTimeoutMs: 10,
    killProcess: (pid, signal) => {
      signals.push([pid, signal]);
      if (pid === -100 && signal === 'SIGTERM') child.exitCode = 0;
    },
  });

  assert.deepEqual(signals, [[-100, 'SIGTERM']]);
});

test('POSIX termination rejects an initial snapshot captured after the leader was reaped', { skip: process.platform === 'win32' }, async () => {
  const child = {
    pid: 100,
    exitCode: null,
    signalCode: null,
    kill: (signal) => signal !== 'SIGSTOP',
  };
  const helper = new EventEmitter();
  helper.stdout = new PassThrough();
  helper.kill = () => true;
  const signals = [];
  queueMicrotask(() => {
    helper.stdout.end([
      '100 1 100 Sun Jul 12 10:00:05 2026',
      '200 100 100 Sun Jul 12 10:00:05 2026',
    ].join('\n'));
    child.exitCode = 0;
    helper.emit('close', 0);
  });

  await terminateProcess(child, {
    platform: process.platform,
    spawnProcess: () => helper,
    forceAfterMs: 10,
    snapshotTimeoutMs: 10,
    killProcess: (pid, signal) => signals.push([pid, signal]),
  });

  assert.deepEqual(signals, [[-100, 'SIGTERM']]);
});

test('a child error during termination cannot settle runProcess before its lease', async () => {
  const child = new EventEmitter();
  child.pid = 424_242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  let releaseTermination;
  const terminationLease = new Promise((resolve) => {
    releaseTermination = resolve;
  });
  const controller = new AbortController();
  const outcome = runProcess('fake-agy', [], {
    signal: controller.signal,
    timeoutMs: 10_000,
    spawnProcess: () => child,
    terminateChild: () => terminationLease,
  }).then(
    () => ({ settled: true, error: null }),
    (error) => ({ settled: true, error }),
  );

  controller.abort();
  child.emit('error', new Error('late child error'));
  child.emit('close', null, 'SIGTERM');
  const early = await Promise.race([
    outcome,
    new Promise((resolve) => setTimeout(() => resolve({ settled: false }), 25)),
  ]);
  assert.equal(early.settled, false);

  releaseTermination();
  const final = await outcome;
  assert.equal(final.error?.code, 'AGY_CANCELLED');
});

test('runProcess preserves UTF-8 split across pipe chunks', async () => {
  const script = [
    "const b=Buffer.from('한😀')",
    'process.stdout.write(b.subarray(0,1))',
    'setTimeout(()=>process.stdout.write(b.subarray(1,4)),5)',
    'setTimeout(()=>process.stdout.write(b.subarray(4)),10)',
  ].join(';');
  const result = await runProcess(process.execPath, ['-e', script], { timeoutMs: 2_000 });
  assert.equal(result.stdout, '한😀');
});

test('runProcess terminates timed out process groups', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 }),
    (error) => error instanceof AgyError && error.code === 'AGY_TIMEOUT',
  );
});

test('a successful POSIX run cannot leave a same-group background child', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-success-group-'));
  const pidFile = path.join(root, 'background.pid');
  const leaderScript = [
    "const {spawn}=require('node:child_process')",
    "const fs=require('node:fs')",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
    `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid))`,
    'child.unref()',
  ].join(';');
  let backgroundPid = null;
  try {
    const result = await runProcess(process.execPath, ['-e', leaderScript], { timeoutMs: 5_000 });
    assert.equal(result.exitCode, 0);
    backgroundPid = Number(await readFile(pidFile, 'utf8'));
    await assertProcessGone(backgroundPid);
  } finally {
    if (backgroundPid) {
      try {
        process.kill(backgroundPid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('process-group SIGKILL escalation survives leader exit', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-process-group-'));
  const pidFile = path.join(root, 'grandchild.pid');
  const grandchildScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const leaderScript = [
    "const {spawn}=require('node:child_process')",
    "const fs=require('node:fs')",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(grandchildScript)}],{stdio:'ignore'})`,
    `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid))`,
    "process.on('SIGTERM',()=>process.exit(0))",
    'setInterval(()=>{},1000)',
  ].join(';');
  let grandchildPid = null;
  try {
    const startedAt = Date.now();
    await assert.rejects(
      runProcess(process.execPath, ['-e', leaderScript], { timeoutMs: 500 }),
      (error) => error.code === 'AGY_TIMEOUT',
    );
    assert.ok(Date.now() - startedAt >= 1_900, 'runProcess released before SIGKILL escalation');
    grandchildPid = Number(await readFile(pidFile, 'utf8'));
    await assertProcessGone(grandchildPid);
  } finally {
    if (grandchildPid) {
      try {
        process.kill(grandchildPid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('termination snapshot kills a descendant in a separate POSIX process group', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-detached-descendant-'));
  const pidFile = path.join(root, 'detached.pid');
  const descendantScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const leaderScript = [
    "const {spawn}=require('node:child_process')",
    "const fs=require('node:fs')",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(descendantScript)}],{detached:true,stdio:'ignore'})`,
    'child.unref()',
    `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid))`,
    "process.on('SIGTERM',()=>process.exit(0))",
    'setInterval(()=>{},1000)',
  ].join(';');
  let descendantPid = null;
  try {
    await assert.rejects(
      runProcess(process.execPath, ['-e', leaderScript], { timeoutMs: 150 }),
      (error) => error.code === 'AGY_TIMEOUT',
    );
    descendantPid = Number(await readFile(pidFile, 'utf8'));
    await assertProcessGone(descendantPid);
  } finally {
    if (descendantPid) {
      try {
        process.kill(-descendantPid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('force escalation catches a same-group child spawned by the leader SIGTERM handler', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-late-group-child-'));
  const pidFile = path.join(root, 'late-child.pid');
  const lateChildScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const leaderScript = [
    "const {spawn}=require('node:child_process')",
    "const fs=require('node:fs')",
    'let stopping=false',
    "process.on('SIGTERM',()=>{if(stopping)return;stopping=true;" +
      `const child=spawn(process.execPath,['-e',${JSON.stringify(lateChildScript)}],{stdio:'ignore'});` +
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));process.exit(0)})`,
    'setInterval(()=>{},1000)',
  ].join(';');
  let lateChildPid = null;
  try {
    await assert.rejects(
      runProcess(process.execPath, ['-e', leaderScript], { timeoutMs: 150 }),
      (error) => error.code === 'AGY_TIMEOUT',
    );
    lateChildPid = Number(await readFile(pidFile, 'utf8'));
    await assertProcessGone(lateChildPid);
  } finally {
    if (lateChildPid) {
      try {
        process.kill(lateChildPid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('history fallback labels prior turns and current request', () => {
  const prompt = buildPromptWithHistory(
    'now fix it',
    [
      { role: 'user', content: 'inspect the test', at: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'I found the failure', at: '2026-01-01T00:00:01Z' },
    ],
    10_000,
  );
  assert.match(prompt, /\[USER\]\ninspect the test/);
  assert.match(prompt, /\[ASSISTANT\]\nI found the failure/);
  assert.match(prompt, /<current_request>\nnow fix it/);
});

test('history fallback never exceeds its configured argv budget', () => {
  const prompt = buildPromptWithHistory(
    'x',
    [{ role: 'assistant', content: 'z'.repeat(2_000) }],
    240,
  );
  assert.ok(prompt.length <= 240, `expected <= 240, received ${prompt.length}`);
  assert.match(prompt, /<current_request>\nx/);
});

test('history fallback handles exact small-budget boundaries and surrogate pairs', () => {
  for (let maxChars = 1; maxChars <= 400; maxChars += 1) {
    const prompt = buildPromptWithHistory(
      'x',
      [{ role: 'assistant', content: maxChars % 2 === 0 ? '' : '😀'.repeat(500) }],
      maxChars,
    );
    assert.ok(prompt === 'x' || prompt.length <= maxChars, `${prompt.length} exceeded ${maxChars}`);
    for (let index = 0; index < prompt.length; index += 1) {
      const unit = prompt.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = prompt.charCodeAt(index + 1);
        assert.ok(next >= 0xdc00 && next <= 0xdfff, 'found an unpaired high surrogate');
      }
      if (unit >= 0xdc00 && unit <= 0xdfff) {
        const previous = prompt.charCodeAt(index - 1);
        assert.ok(previous >= 0xd800 && previous <= 0xdbff, 'found an unpaired low surrogate');
      }
    }
  }
});

test('runProcess reports missing executables without leaking arguments', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-missing-'));
  try {
    await assert.rejects(
      runProcess(path.join(root, 'not-an-executable'), ['secret-prompt'], { timeoutMs: 1_000 }),
      (error) => error instanceof AgyError && error.code === 'AGY_NOT_FOUND' && !error.message.includes('secret-prompt'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('catalog probe fails closed when agy is unavailable', async () => {
  const client = new AgyClient({ bin: '/definitely/missing/agy', authCheckTimeoutMs: 100 });
  const catalog = await client.catalogStatus({ cwd: process.cwd() });
  assert.equal(catalog.available, false);
  assert.equal(catalog.reason, 'AGY_NOT_FOUND');
});

test('authenticationStatus verifies an already authenticated headless run', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-auth-ok-'));
  const shim = path.join(root, process.platform === 'win32' ? 'fake-agy.cmd' : 'fake-agy');
  try {
    await writeFile(
      shim,
      process.platform === 'win32'
        ? '@echo off\r\necho AGY_AUTH_OK\r\n'
        : '#!/bin/sh\necho AGY_AUTH_OK\n',
    );
    if (process.platform !== 'win32') await chmod(shim, 0o755);
    const client = new AgyClient({ bin: shim, authCheckTimeoutMs: 1_000 });
    const status = await client.authenticationStatus({ cwd: root });
    assert.equal(status.authenticated, true);
    assert.equal(status.reason, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('authenticationStatus reports authentication-required output without throwing', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-auth-needed-'));
  const shim = path.join(root, process.platform === 'win32' ? 'fake-agy.cmd' : 'fake-agy');
  try {
    await writeFile(
      shim,
      process.platform === 'win32'
        ? '@echo off\r\necho Authentication required. Please visit the URL to log in: 1>&2\r\nexit /b 1\r\n'
        : '#!/bin/sh\necho "Authentication required. Please visit the URL to log in:" >&2\nexit 1\n',
    );
    if (process.platform !== 'win32') await chmod(shim, 0o755);
    const client = new AgyClient({ bin: shim, authCheckTimeoutMs: 1_000 });
    const status = await client.authenticationStatus({ cwd: root });
    assert.equal(status.authenticated, false);
    assert.equal(status.reason, 'AGY_AUTH_REQUIRED');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('isAuthRequired correctly distinguishes real auth requirements from benign startup logs', () => {
  assert.equal(
    _private.isAuthRequired('OAuth: authenticated successfully as test@gmail.com\nsomething went wrong'),
    false,
  );
  assert.equal(
    _private.isAuthRequired('Auth succeeded, refreshing features and managers\nProcess terminated'),
    false,
  );
  assert.equal(
    _private.isAuthRequired('Authentication required. Please visit the URL to log in:'),
    true,
  );
  assert.equal(
    _private.isAuthRequired('error getting token source: You are not logged into Antigravity.'),
    true,
  );
  assert.equal(
    _private.isAuthRequired('Error: command failed with exit code 1'),
    false,
  );
});

test('runProcess does not classify exit 1 as AGY_AUTH_REQUIRED when OAuth startup log is present', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-fake-auth-'));
  const shim = path.join(root, 'fake-agy');
  try {
    await writeFile(
      shim,
      '#!/bin/sh\necho "OAuth: authenticated successfully as user@example.com" >&2\necho "fatal execution error" >&2\nexit 1\n',
    );
    await chmod(shim, 0o755);
    await assert.rejects(
      runProcess(shim, ['--print', 'hi'], { cwd: root, timeoutMs: 1_000 }),
      (err) => {
        assert.equal(err instanceof AgyError, true);
        assert.equal(err.code, 'AGY_EXIT_ERROR');
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
