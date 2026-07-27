#!/bin/sh

set -eu

BOOTSTRAP_VERSION="3.2.1"
PROGRAM_NAME=agygram
TEMP_DIR=

fail() {
  printf '%s\n' "$PROGRAM_NAME install: $*" >&2
  exit 1
}

cleanup() {
  status=$?
  trap - 0 HUP INT TERM
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR" || printf '%s\n' "$PROGRAM_NAME install: warning: could not remove temporary directory" >&2
  fi
  exit "$status"
}

trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

node_bin=$(command -v node 2>/dev/null || true)
[ -n "$node_bin" ] || fail 'Node.js 22 or 24 is required'

node_major=$(NODE_OPTIONS= NODE_PATH= NODE_TLS_REJECT_UNAUTHORIZED=1 "$node_bin" -p "process.versions.node.split('.')[0]" 2>/dev/null || true)
case "$node_major" in
  22|24) ;;
  *) fail 'Node.js 22 or 24 is required' ;;
esac

install_root_argument_seen=false
expect_install_root=false
for argument in "$@"; do
  if [ "$expect_install_root" = true ]; then
    [ -n "$argument" ] || fail '--install-root requires a non-empty path'
    if printf '%s' "$argument" | LC_ALL=C grep -q '[[:cntrl:]]'; then
      fail '--install-root contains control characters'
    fi
    case "$argument" in
      /*) ;;
      *) fail '--install-root must be an absolute path' ;;
    esac
    expect_install_root=false
    continue
  fi
  case "$argument" in
    --)
      fail '-- option delimiters are not supported'
      ;;
    --install-root)
      [ "$install_root_argument_seen" = false ] || fail '--install-root may only be specified once'
      install_root_argument_seen=true
      expect_install_root=true
      ;;
    --install-root=*)
      fail 'use --install-root <path>, without an equals sign'
      ;;
  esac
done
[ "$expect_install_root" = false ] || fail '--install-root requires a path'

if [ "$install_root_argument_seen" = false ] && [ "${AGYGRAM_INSTALL_ROOT+x}" = x ] && [ -z "$AGYGRAM_INSTALL_ROOT" ]; then
  fail 'AGYGRAM_INSTALL_ROOT must not be empty'
fi
if [ "$install_root_argument_seen" = false ] && [ "${AGYGRAM_INSTALL_ROOT+x}" = x ]; then
  if printf '%s' "$AGYGRAM_INSTALL_ROOT" | LC_ALL=C grep -q '[[:cntrl:]]'; then
    fail 'AGYGRAM_INSTALL_ROOT contains control characters'
  fi
  case "$AGYGRAM_INSTALL_ROOT" in
    /*) ;;
    *) fail 'AGYGRAM_INSTALL_ROOT must be an absolute path' ;;
  esac
fi

umask 077
temp_base=${TMPDIR:-/tmp}
case "$temp_base" in
  /*) ;;
  *) fail 'TMPDIR must be an absolute path' ;;
esac
[ -d "$temp_base" ] || fail "temporary directory does not exist: $temp_base"
TEMP_DIR=$(mktemp -d "${temp_base%/}/agygram-install.XXXXXXXX") || fail 'could not create a private temporary directory'
chmod 700 "$TEMP_DIR" || fail 'could not protect the temporary directory'

bootstrap_helper=$TEMP_DIR/bootstrap.mjs
cat > "$bootstrap_helper" <<'AGYGRAM_BOOTSTRAP'
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, open, readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';

const OWNER = 'parkjangwon';
const REPOSITORY = 'agygram';
const API_ORIGIN = 'https://api.github.com';
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_INSTALLER_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const SOCKET_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

const [temporaryDirectory, version] = process.argv.slice(2);
if (!temporaryDirectory || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version ?? '')) {
  throw new Error('invalid bootstrap arguments');
}

const tag = `v${version}`;
const installerName = 'install.mjs';
const archiveName = `agygram-${version}.tgz`;
const installerPath = path.join(temporaryDirectory, installerName);
const archivePath = path.join(temporaryDirectory, archiveName);
const metadataPath = path.join(temporaryDirectory, 'bootstrap-meta');

function isAllowedHost(hostname) {
  const host = hostname.toLowerCase();
  return host === 'api.github.com'
    || host === 'github.com'
    || host.endsWith('.githubusercontent.com');
}

function validateUrl(value) {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !isAllowedHost(url.hostname)) {
    throw new Error('GitHub returned an unsafe download URL');
  }
  return url;
}

function request(urlValue, consume, redirectCount = 0, accept = 'application/vnd.github+json') {
  const url = validateUrl(urlValue);
  return new Promise((resolve, reject) => {
    let requestHandle;
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(overallTimer);
      if (error) reject(error);
      else resolve(value);
    };
    const overallTimer = setTimeout(() => {
      requestHandle?.destroy(new Error('GitHub request timed out'));
    }, REQUEST_TIMEOUT_MS);

    requestHandle = https.get(url, {
      headers: {
        Accept: accept,
        'Accept-Encoding': 'identity',
        'User-Agent': `agygram-installer/${version}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.resume();
        clearTimeout(overallTimer);
        if (!location || redirectCount >= MAX_REDIRECTS) {
          finish(new Error('GitHub returned an invalid redirect'));
          return;
        }
        let redirected;
        try {
          redirected = validateUrl(new URL(location, url));
        } catch (error) {
          finish(error);
          return;
        }
        finished = true;
        resolve(request(redirected, consume, redirectCount + 1, accept));
        return;
      }

      if (status !== 200) {
        response.resume();
        finish(new Error(`GitHub request failed with HTTP ${status}`));
        return;
      }

      Promise.resolve()
        .then(() => consume(response))
        .then((value) => finish(null, value), (error) => finish(error));
    });

    requestHandle.setTimeout(SOCKET_TIMEOUT_MS, () => {
      requestHandle.destroy(new Error('GitHub request stalled'));
    });
    requestHandle.once('error', (error) => finish(error));
  });
}

async function getBuffer(url, maximumBytes, accept) {
  return request(url, async (response) => {
    const chunks = [];
    let length = 0;
    for await (const chunk of response) {
      length += chunk.length;
      if (length > maximumBytes) throw new Error('GitHub response exceeded its size limit');
      chunks.push(chunk);
    }
    const declaredLength = response.headers['content-length'];
    if (declaredLength && Number(declaredLength) !== length) {
      throw new Error('GitHub response was truncated');
    }
    return Buffer.concat(chunks, length);
  }, 0, accept);
}

async function getJson(apiPath) {
  const buffer = await getBuffer(`${API_ORIGIN}${apiPath}`, MAX_JSON_BYTES, 'application/vnd.github+json');
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error('GitHub returned invalid JSON');
  }
}

async function downloadFile(url, destination, maximumBytes, expectedSize) {
  await rm(destination, { force: true });
  let file;
  try {
    file = await open(destination, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    const result = await request(url, async (response) => {
      const hash = createHash('sha256');
      let length = 0;
      for await (const chunk of response) {
        length += chunk.length;
        if (length > maximumBytes) throw new Error('release asset exceeded its size limit');
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, null);
          if (bytesWritten <= 0) throw new Error('could not write the release asset');
          offset += bytesWritten;
        }
      }
      const declaredLength = response.headers['content-length'];
      if (declaredLength && Number(declaredLength) !== length) {
        throw new Error('release asset was truncated');
      }
      if (Number.isSafeInteger(expectedSize) && expectedSize >= 0 && length !== expectedSize) {
        throw new Error('release asset size did not match GitHub metadata');
      }
      return { digest: hash.digest('hex'), length };
    }, 0, 'application/octet-stream');
    await file.sync();
    await file.close();
    file = undefined;
    return result;
  } catch (error) {
    await file?.close().catch(() => {});
    await rm(destination, { force: true }).catch(() => {});
    throw error;
  }
}

function selectAsset(release, name, maximumBytes) {
  const matches = Array.isArray(release.assets)
    ? release.assets.filter((asset) => asset?.name === name)
    : [];
  if (matches.length !== 1) throw new Error(`release must contain exactly one ${name} asset`);
  const asset = matches[0];
  if (asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maximumBytes) {
    throw new Error(`release asset metadata is invalid for ${name}`);
  }
  validateUrl(asset.browser_download_url);
  return asset;
}

function digestFromMetadata(asset) {
  if (typeof asset.digest !== 'string') return null;
  const match = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest);
  if (!match) throw new Error(`unsupported digest metadata for ${asset.name}`);
  return match[1].toLowerCase();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function digestFromChecksumFile(contents, filename) {
  const escapedName = escapeRegExp(filename);
  const gnu = new RegExp(`^([0-9a-f]{64})[ \\t]+[* ]?${escapedName}$`, 'i');
  const bsd = new RegExp(`^SHA256 \\(${escapedName}\\) = ([0-9a-f]{64})$`, 'i');
  const values = [];
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const match = gnu.exec(line) ?? bsd.exec(line);
    if (match) values.push(match[1].toLowerCase());
  }
  const unique = [...new Set(values)];
  if (unique.length !== 1) throw new Error(`SHA256SUMS has no unique digest for ${filename}`);
  return unique[0];
}

async function resolveTagCommit() {
  const reference = await getJson(`/repos/${OWNER}/${REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (reference?.ref !== `refs/tags/${tag}` || !reference.object) {
    throw new Error('release tag reference is invalid');
  }

  let object = reference.object;
  for (let depth = 0; depth < 5; depth++) {
    if (!/^[0-9a-f]{40}$/i.test(object?.sha ?? '')) throw new Error('release tag has an invalid object ID');
    if (object.type === 'commit') return object.sha.toLowerCase();
    if (object.type !== 'tag') throw new Error('release tag does not resolve to a commit');
    const annotatedTag = await getJson(`/repos/${OWNER}/${REPOSITORY}/git/tags/${object.sha}`);
    if (depth === 0 && annotatedTag?.tag !== tag) throw new Error('annotated release tag name did not match');
    object = annotatedTag?.object;
  }
  throw new Error('release tag indirection is too deep');
}

async function main() {
  const release = await getJson(`/repos/${OWNER}/${REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`);
  if (release?.tag_name !== tag || release.draft !== false || release.prerelease !== false || release.immutable !== true) {
    throw new Error(`v${version} is not a stable GitHub release`);
  }

  const installerAsset = selectAsset(release, installerName, MAX_INSTALLER_BYTES);
  const archiveAsset = selectAsset(release, archiveName, MAX_ARCHIVE_BYTES);
  let installerDigest = digestFromMetadata(installerAsset);
  let archiveDigest = digestFromMetadata(archiveAsset);

  if (!installerDigest || !archiveDigest) {
    const checksumAsset = selectAsset(release, 'SHA256SUMS', MAX_CHECKSUM_BYTES);
    const checksumPath = path.join(temporaryDirectory, 'SHA256SUMS');
    const downloadedChecksums = await downloadFile(
      checksumAsset.browser_download_url,
      checksumPath,
      MAX_CHECKSUM_BYTES,
      checksumAsset.size,
    );
    const checksumDigest = digestFromMetadata(checksumAsset);
    if (!checksumDigest || downloadedChecksums.digest !== checksumDigest) {
      throw new Error('SHA256SUMS digest verification failed');
    }
    const checksumText = await readFile(checksumPath, 'utf8');
    installerDigest ??= digestFromChecksumFile(checksumText, installerName);
    archiveDigest ??= digestFromChecksumFile(checksumText, archiveName);
  }

  const commit = await resolveTagCommit();
  const downloadedInstaller = await downloadFile(
    installerAsset.browser_download_url,
    installerPath,
    MAX_INSTALLER_BYTES,
    installerAsset.size,
  );
  if (downloadedInstaller.digest !== installerDigest) throw new Error('install.mjs digest verification failed');

  const downloadedArchive = await downloadFile(
    archiveAsset.browser_download_url,
    archivePath,
    MAX_ARCHIVE_BYTES,
    archiveAsset.size,
  );
  if (downloadedArchive.digest !== archiveDigest) throw new Error('release archive digest verification failed');

  await chmod(installerPath, 0o600);
  await chmod(archivePath, 0o600);
  await writeFile(metadataPath, `${commit}\n${archiveDigest}\n`, { mode: 0o600, flag: 'wx' });
}

main().catch((error) => {
  process.stderr.write(`agygram install: ${error?.message || 'bootstrap failed'}\n`);
  process.exitCode = 1;
});
AGYGRAM_BOOTSTRAP
chmod 600 "$bootstrap_helper" || fail 'could not protect the bootstrap helper'

NODE_OPTIONS= NODE_PATH= NODE_TLS_REJECT_UNAUTHORIZED=1 "$node_bin" --check -- "$bootstrap_helper"
NODE_OPTIONS= NODE_PATH= NODE_TLS_REJECT_UNAUTHORIZED=1 "$node_bin" -- "$bootstrap_helper" "$TEMP_DIR" "$BOOTSTRAP_VERSION"

metadata_file=$TEMP_DIR/bootstrap-meta
[ -f "$metadata_file" ] || fail 'bootstrap metadata is missing'
commit=
archive_sha256=
extra_line=
exec 4< "$metadata_file"
IFS= read -r commit <&4 || fail 'bootstrap metadata is incomplete'
IFS= read -r archive_sha256 <&4 || fail 'bootstrap metadata is incomplete'
if IFS= read -r extra_line <&4 || [ -n "$extra_line" ]; then
  exec 4<&-
  fail 'bootstrap metadata has unexpected content'
fi
exec 4<&-
case "$commit" in
  *[!0-9a-f]*|'') fail 'bootstrap returned an invalid commit ID' ;;
esac
[ "${#commit}" -eq 40 ] || fail 'bootstrap returned an invalid commit ID'
case "$archive_sha256" in
  *[!0-9a-f]*|'') fail 'bootstrap returned an invalid archive digest' ;;
esac
[ "${#archive_sha256}" -eq 64 ] || fail 'bootstrap returned an invalid archive digest'

installer=$TEMP_DIR/install.mjs
archive=$TEMP_DIR/agygram-$BOOTSTRAP_VERSION.tgz
[ -f "$installer" ] || fail 'verified installer is missing'
[ -f "$archive" ] || fail 'verified release archive is missing'

invoke_installer() {
  NODE_OPTIONS= NODE_PATH= NODE_TLS_REJECT_UNAUTHORIZED=1 "$node_bin" -- "$installer" \
    --version "$BOOTSTRAP_VERSION" \
    --commit "$commit" \
    --archive "$archive" \
    --archive-sha256 "$archive_sha256" \
    "$@"
}

if [ "$install_root_argument_seen" = true ]; then
  (
    unset AGYGRAM_INSTALL_ROOT
    invoke_installer "$@"
  )
elif [ "${AGYGRAM_INSTALL_ROOT+x}" = x ]; then
  invoke_installer --install-root "$AGYGRAM_INSTALL_ROOT" "$@"
else
  invoke_installer "$@"
fi
