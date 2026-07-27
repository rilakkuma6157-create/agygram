# Changelog

## 3.2.1 — 2026-07-27

- Fix hourly maintenance crash caused by unawaited `snapshotPosixProcessTable()` promise rejecting with `spawnProcess` undefined, triggering unhandledRejection that crashed the service runner.

## 3.2.0 — 2026-07-23

- Add structured JSON-lines service logging (`{time, level, pid, msg}`) replacing the previous free-text format.
- Add a file-based health snapshot (`DATA_DIR/health.json`) written every maintenance cycle for external monitors.
- Add `agygram backup` CLI command to snapshot state files (`sessions.json`, `jobs.json`, `usage.json`, `health.json`).
- Add owner Telegram notification on agy execution failures (1-hour per-error-code cooldown).
- Add `unhandledRejection` logging in the service runner before the default crash behavior.
- Add memory/uptime resource logging and POSIX orphan-process detection to the hourly maintenance cycle.
- Add actionable error messages for permanent Telegram failures (401 Unauthorized, 409 Conflict) at startup.
- Add `MAX_RESULT_STORAGE_BYTES >= AGY_MAX_OUTPUT_BYTES` cross-validation to `loadConfig()`.
- Add `activeCount`/`queuedCount` getters to `TaskManager` and `running`/`waiting` to the internal semaphore.
- Introduce ESLint (flat config) with a `npm run lint` script; fix two missing imports in `src/bot/handlers.js` that caused `ReferenceError` on `/reset` and `/workspace <path>`.
- Remove unused imports in `job-store.js`, `state.js`, and `usage-store.js`.

## 3.1.10 — 2026-07-19

- Internal cleanup: split the Telegram bot orchestration out of `src/index.js` into `src/bot/{app,control,panels,jobs,handlers,util}.js`.
- Share atomic file writes (`src/atomic-write.js`) and managed DATA_DIR layout (`src/managed-runtime.js`) across stores, doctor, and bot startup.
- Route Windows argv quoting through `process-platform.js` instead of a second copy in `agy.js`.
- Merge `tests/` into `test/`; ship a path-safe optional PM2 DNS IPv4 workaround (`dns-ipv4-preload.cjs`, `AGYGRAM_DNS_IPV4=1`) and remove the incomplete `dns-ipv4-fix.mjs` experiment plus hardcoded host paths in `ecosystem.config.cjs`.

## 3.1.9 — 2026-07-19

- Fix release CI by removing a stale hardcoded version literal from `test/version.test.js`; the test now validates strict SemVer and cross-file version consistency without per-release test edits.

## 3.1.8 — 2026-07-19

- Render single-chunk Markdown responses as Telegram HTML (`parse_mode: HTML`) so bold/code/link/code-block output displays correctly in chat.
- Keep multi-chunk deliveries in plain text to avoid malformed rich-text boundaries when Telegram messages are split.

## 3.1.7 — 2026-07-19

- Fix release CI failure by extending the service `.env` allowlist to include the new version-guard and queue-overload configuration keys.

## 0.3.15 — 2026-07-19

- Add startup agy version compatibility guardrails with warn-first defaults, plus configurable strict enforcement.
- Add adaptive queue overload handling so backlog pressure fails fast instead of making users wait on stale work.
- Reduce user-facing friction by softening update-check outage messaging and by throttling repeated startup warnings.

## 0.3.14 — 2026-07-19

- Add inline buttons for confirmation and retry on failed, cancelled, or interrupted jobs.
- Throttle chunked Telegram message delivery to prevent HTTP 429 flood errors.
- Check file sizes and send a warning with the local path before sending files exceeding Telegram's 50MB limit.
- Notify chats on bot startup about successfully recovered or interrupted tasks from a server restart, with direct retry options.

## 0.3.13 — 2026-07-13

- Add Telegram `/doctor` with install, Node.js, workspace, `agy`, auth, and
  busy-state checks so operators can diagnose servers without SSH.
- Replace `/start` with a Telegram onboarding checklist and next-action buttons.
- Improve `/update` with release notes, release URL, and explicit apply/cancel
  buttons.
- Improve `/auth` and `/yolo` Telegram copy for clearer headless OAuth and
  high-risk auto-approve expectations.
- Add README onboarding sections for Telegram-first UX, safe no-service trials,
  screenshot/GIF capture guidance, and GitHub issue templates.

## 0.3.12 — 2026-07-13

- Improve first-run onboarding in the English and Korean READMEs with a
  clearer 3-minute setup path, success checklist, and copy/paste prompt for
  remote coding agents.
- Make the interactive setup wizard show explicit steps and Telegram next
  actions after configuration is saved.

## 0.3.11 — 2026-07-13

- Make `/clear` sweep a much wider private-chat message range so older
  pre-tracking bot messages are more likely to be removed.
- Make `/clear` result text explain Telegram deletion limits instead of
  surfacing noisy failed-candidate counts.

## 0.3.10 — 2026-07-13

- Make `/clear` respond immediately with a progress message, then edit that
  message with the final cleanup result after Telegram deletion calls finish.

## 0.3.9 — 2026-07-13

- Add `/clear` and a `🧹 정리` menu button to delete recently tracked Telegram
  chat messages without resetting agy session state.

## 0.3.8 — 2026-07-13

- Add a Telegram `닫기` button to action panels such as `/menu`, `/help`,
  `/info`, `/status`, `/jobs`, auth status, and update prompts. The button
  deletes the bot menu message when Telegram permits it.

## 0.3.7 — 2026-07-13

- Keep the new `/auth` preflight tests aligned with Windows executable policy;
  the project intentionally rejects `.cmd` shims as agy binaries.

## 0.3.6 — 2026-07-13

- Make `/auth` run a short real headless authentication probe first and return
  immediately when `agy` is already signed in, instead of opening the OAuth TUI
  and waiting for a URL that is not needed.
- Keep the OAuth start message accurate for both already-authenticated and
  login-required sessions.

## 0.3.5 — 2026-07-13

- Make Telegram OAuth output action-focused: show only the auth URL, code
  prompt, errors, and final result instead of streaming Antigravity TUI frames.
- Strip PTY keyboard-protocol fragments, spinner frames, and the internal
  `AGY_AUTH_OK` verification token from Telegram auth messages.
- Add a Telegram-native `/menu` button panel for status, session info, model,
  agent, skill, mode, sandbox, YOLO, auth, update, jobs, and last-result access.
- Make `/help` concise and button-first while preserving the full command list
  through `/help full`.

## 0.3.4 — 2026-07-13

- Keep managed update scheduling path handling portable across POSIX and
  Windows test hosts.

## 0.3.3 — 2026-07-13

- Allow Telegram `/update` to recognize managed immutable release installs,
  not only clean git checkouts.
- Schedule managed release updates through the native service environment so
  `/update apply` can move a service from one immutable release to the next.

## 0.3.2 — 2026-07-13

- Add Telegram button-driven YOLO mode for explicitly enabled unsandboxed
  auto-approve runs.
- Add paginated Telegram skill selection with search, persisted per session and
  applied to subsequent agy prompts.
- Document the skill discovery paths, dynamic Telegram menu limitation, and
  the two-step environment opt-in required for YOLO behavior.

## 0.3.1 — 2026-07-13

- Add Telegram inline-button menus for `/model`, `/agent`, `/mode`, and
  `/sandbox` while preserving direct text arguments for automation.
- Bind interactive menus to the opening user and chat/topic, expire them after
  ten minutes, and keep callback payloads tokenized so long model or agent
  names do not exceed Telegram limits.

## 0.3.0 — 2026-07-12

- Rename the public project identity to `agygram`, including repository URLs,
  package metadata, release asset names, documentation, and native service
  labels.
- Keep managed install, update, and uninstall compatible with legacy
  `antigravity-telegram-cli` manifests and release markers.

## 0.2.0 — 2026-07-12

- Add `agygram setup`, an interactive onboarding wizard that validates the
  Telegram bot token, auto-detects a private Telegram chat/user after `/start`,
  writes the external `.env`, and prepares data/workspace paths.
- Add managed installer `--setup` so first install can go from verified release
  download to service installation without hand-editing `.env` on macOS/Linux.
- Refresh English and Korean READMEs around the shorter setup journey.

## 0.1.3 — 2026-07-12

- Remove personal Telegram identifiers from all public examples and history.
- Synchronize Telegram command menus at default and allowed-chat Korean scopes
  so stale commands from earlier bot deployments are removed.

## 0.1.2 — 2026-07-12

- Add owner-only Telegram `/update` and `/update apply` for verified immutable
  GitHub releases in official clean source checkouts.

## 0.1.1 — 2026-07-12

- Make the POSIX `tmux` OAuth transport complete the entire first-run agy
  onboarding from Telegram: Google OAuth selection, default theme, terms,
  workspace trust, clean exit, and a final real headless authentication check.
- Keep optional agy interaction-data analytics disabled during automatic
  onboarding.
- Fix TTY menu timing and make the manual Enter recovery command functional.

## 0.1.0 — 2026-07-12

Initial public release.

- Headless Telegram control for Google Antigravity CLI on macOS, Linux, and Windows.
- Safe plan/sandbox defaults, allowlists, owner-only OAuth, durable jobs, limits, recovery, uploads, and result delivery.
- Native per-user launchd, systemd, and Task Scheduler integration.
- Versioned one-line installer/updater and data-preserving uninstaller.
