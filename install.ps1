& {
    param([object[]] $ForwardedArgs)

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    $bootstrapVersion = '3.2.1'
    $programName = 'agygram'
    $temporaryDirectory = $null
    $isWindowsPlatform = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT

    function Fail-Install([string] $Message) {
        throw "$programName install: $Message"
    }

    function Test-StrictAbsolutePath([string] $Value) {
        if ([string]::IsNullOrEmpty($Value)) {
            return $false
        }
        if ($Value -match '[\x00-\x1f\x7f]') {
            return $false
        }
        if ($isWindowsPlatform) {
            return $Value -match '\A(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))'
        }
        return [IO.Path]::IsPathRooted($Value)
    }

    if ($null -eq $ForwardedArgs) {
        $ForwardedArgs = @()
    }

    $installRootArgumentSeen = $false
    $installRootArgumentValue = $null
    for ($index = 0; $index -lt $ForwardedArgs.Count; $index++) {
        $argument = [string] $ForwardedArgs[$index]
        if ($argument -eq '--') {
            Fail-Install '-- option delimiters are not supported'
        } elseif ($argument -eq '--install-root') {
            if ($installRootArgumentSeen) {
                Fail-Install '--install-root may only be specified once'
            }
            if (($index + 1) -ge $ForwardedArgs.Count -or [string]::IsNullOrEmpty([string] $ForwardedArgs[$index + 1])) {
                Fail-Install '--install-root requires a non-empty path'
            }
            $installRootArgumentSeen = $true
            $index++
            $installRootArgumentValue = [string] $ForwardedArgs[$index]
        } elseif ($argument.StartsWith('--install-root=', [StringComparison]::Ordinal)) {
            Fail-Install 'use --install-root <path>, without an equals sign'
        }
    }
    $environmentInstallRoot = [Environment]::GetEnvironmentVariable('AGYGRAM_INSTALL_ROOT')
    if (-not $installRootArgumentSeen -and $null -ne $environmentInstallRoot -and [string]::IsNullOrEmpty($environmentInstallRoot)) {
        Fail-Install 'AGYGRAM_INSTALL_ROOT must not be empty'
    }
    if ($installRootArgumentSeen -and -not (Test-StrictAbsolutePath $installRootArgumentValue)) {
        Fail-Install '--install-root must be an absolute path'
    }
    if (-not $installRootArgumentSeen -and $null -ne $environmentInstallRoot -and -not (Test-StrictAbsolutePath $environmentInstallRoot)) {
        Fail-Install 'AGYGRAM_INSTALL_ROOT must be an absolute path'
    }

    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) {
        $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
    }
    if ($null -eq $nodeCommand) {
        Fail-Install 'Node.js 22 or 24 is required'
    }
    $nodePath = $nodeCommand.Source

    $oldNodeOptions = [Environment]::GetEnvironmentVariable('NODE_OPTIONS')
    $oldNodePath = [Environment]::GetEnvironmentVariable('NODE_PATH')
    $oldTlsSetting = [Environment]::GetEnvironmentVariable('NODE_TLS_REJECT_UNAUTHORIZED')
    $oldInstallRoot = [Environment]::GetEnvironmentVariable('AGYGRAM_INSTALL_ROOT')

    try {
        $env:NODE_OPTIONS = ''
        $env:NODE_PATH = ''
        $env:NODE_TLS_REJECT_UNAUTHORIZED = '1'
        if ($installRootArgumentSeen) {
            [Environment]::SetEnvironmentVariable('AGYGRAM_INSTALL_ROOT', $null)
        }

        $nodeMajor = (& $nodePath -p "process.versions.node.split('.')[0]")
        if ($LASTEXITCODE -ne 0 -or ($nodeMajor -ne '22' -and $nodeMajor -ne '24')) {
            Fail-Install 'Node.js 22 or 24 is required'
        }

        $temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ("agygram-install-" + [Guid]::NewGuid().ToString('N'))
        [void] [IO.Directory]::CreateDirectory($temporaryDirectory)

        if ($isWindowsPlatform) {
            $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
            $directorySecurity = New-Object Security.AccessControl.DirectorySecurity
            $directorySecurity.SetAccessRuleProtection($true, $false)
            $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
            $accessRule = New-Object Security.AccessControl.FileSystemAccessRule(
                $identity.User,
                [Security.AccessControl.FileSystemRights]::FullControl,
                $inheritance,
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow
            )
            [void] $directorySecurity.AddAccessRule($accessRule)
            Set-Acl -LiteralPath $temporaryDirectory -AclObject $directorySecurity
        }

        $bootstrapHelper = Join-Path $temporaryDirectory 'bootstrap.mjs'
        $helperSource = @'
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
'@
        $utf8WithoutBom = New-Object Text.UTF8Encoding($false)
        [IO.File]::WriteAllText($bootstrapHelper, $helperSource, $utf8WithoutBom)

        & $nodePath --check -- $bootstrapHelper
        if ($LASTEXITCODE -ne 0) {
            Fail-Install 'embedded bootstrap helper failed its syntax self-check'
        }
        & $nodePath -- $bootstrapHelper $temporaryDirectory $bootstrapVersion
        if ($LASTEXITCODE -ne 0) {
            Fail-Install 'release bootstrap failed'
        }

        $metadataFile = Join-Path $temporaryDirectory 'bootstrap-meta'
        if (-not (Test-Path -LiteralPath $metadataFile -PathType Leaf)) {
            Fail-Install 'bootstrap metadata is missing'
        }
        $metadata = [IO.File]::ReadAllLines($metadataFile, $utf8WithoutBom)
        if ($metadata.Count -ne 2 -or $metadata[0] -notmatch '\A[0-9a-f]{40}\z' -or $metadata[1] -notmatch '\A[0-9a-f]{64}\z') {
            Fail-Install 'bootstrap metadata is invalid'
        }
        $commit = $metadata[0]
        $archiveSha256 = $metadata[1]
        $installer = Join-Path $temporaryDirectory 'install.mjs'
        $archive = Join-Path $temporaryDirectory "agygram-$bootstrapVersion.tgz"
        if (-not (Test-Path -LiteralPath $installer -PathType Leaf) -or -not (Test-Path -LiteralPath $archive -PathType Leaf)) {
            Fail-Install 'verified release assets are missing'
        }

        $invokeArguments = New-Object 'System.Collections.Generic.List[string]'
        $invokeArguments.Add('--')
        $invokeArguments.Add($installer)
        $invokeArguments.Add('--version')
        $invokeArguments.Add($bootstrapVersion)
        $invokeArguments.Add('--commit')
        $invokeArguments.Add($commit)
        $invokeArguments.Add('--archive')
        $invokeArguments.Add($archive)
        $invokeArguments.Add('--archive-sha256')
        $invokeArguments.Add($archiveSha256)
        if (-not $installRootArgumentSeen -and $null -ne $environmentInstallRoot) {
            $invokeArguments.Add('--install-root')
            $invokeArguments.Add($environmentInstallRoot)
        }
        foreach ($argument in $ForwardedArgs) {
            $invokeArguments.Add([string] $argument)
        }

        $nativeArguments = $invokeArguments.ToArray()
        & $nodePath @nativeArguments
        if ($LASTEXITCODE -ne 0) {
            Fail-Install "verified installer exited with code $LASTEXITCODE"
        }
    } finally {
        [Environment]::SetEnvironmentVariable('NODE_OPTIONS', $oldNodeOptions)
        [Environment]::SetEnvironmentVariable('NODE_PATH', $oldNodePath)
        [Environment]::SetEnvironmentVariable('NODE_TLS_REJECT_UNAUTHORIZED', $oldTlsSetting)
        [Environment]::SetEnvironmentVariable('AGYGRAM_INSTALL_ROOT', $oldInstallRoot)

        if ($null -ne $temporaryDirectory -and (Test-Path -LiteralPath $temporaryDirectory)) {
            $removed = $false
            for ($attempt = 0; $attempt -lt 3 -and -not $removed; $attempt++) {
                try {
                    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
                    $removed = $true
                } catch {
                    if ($attempt -lt 2) {
                        Start-Sleep -Milliseconds 100
                    }
                }
            }
            if (-not $removed) {
                Write-Warning "$programName install: could not remove temporary directory"
            }
        }
    }
} -ForwardedArgs $args
