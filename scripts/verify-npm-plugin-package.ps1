# NOTE: deliberately 'Continue', not 'Stop'. In PowerShell 5.1 any native
# command writing to stderr (npm prints "npm notice" lines there, esbuild
# prints its summary there) surfaces as a NativeCommandError, which under
# 'Stop' would terminate the script. All failures are tracked explicitly via
# $LASTEXITCODE checks and the $failures list below.
$ErrorActionPreference = 'Continue'

$failures = @()

function Report-Pass([string]$msg) {
  Write-Host "PASS: $msg"
}

function Report-Fail([string]$msg) {
  Write-Host "FAIL: $msg"
  $script:failures += $msg
}

# 1. Build both bundles.
npm run build
if ($LASTEXITCODE -ne 0) {
  Report-Fail '"npm run build" exited non-zero.'
} else {
  Report-Pass '"npm run build" succeeded.'
}

npm run build:plugin
if ($LASTEXITCODE -ne 0) {
  Report-Fail '"npm run build:plugin" exited non-zero.'
} else {
  Report-Pass '"npm run build:plugin" succeeded.'
}

# 2. Pack into a temp directory.
$packDir = Join-Path $env:TEMP ('condense-pack-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $packDir | Out-Null
$packLines = @(npm pack --pack-destination $packDir 2>&1)
$packExit = $LASTEXITCODE
if ($packExit -ne 0) {
  Report-Fail ("'npm pack' failed: " + ($packLines -join "`n"))
  $tgz = $null
} else {
  $tgzLine = $packLines | Where-Object { $_ -match '\.tgz\s*$' } | Select-Object -Last 1
  if ($null -eq $tgzLine) {
    $found = Get-ChildItem -Path $packDir -Filter '*.tgz' | Select-Object -First 1
    if ($null -ne $found) {
      $tgz = $found.FullName
    } else {
      $tgz = $null
    }
  } else {
    $tgzName = [System.IO.Path]::GetFileName($tgzLine.ToString().Trim())
    $tgz = Join-Path $packDir $tgzName
  }
  if (($null -eq $tgz) -or (-not (Test-Path -LiteralPath $tgz))) {
    Report-Fail ("'npm pack' produced no .tgz: " + ($packLines -join "`n"))
  } else {
    Report-Pass ("'npm pack' produced $tgz")
  }
}

# 3. Assert the tarball contains package/dist/opencode-plugin.js.
if ($tgz -and (Test-Path -LiteralPath $tgz)) {
  $listing = @(tar -tzf $tgz)
  Write-Host '--- tgz listing (opencode-plugin lines) ---'
  $listing | Where-Object { $_ -match 'opencode-plugin' } | ForEach-Object { Write-Host $_ }
  Write-Host '--- end tgz listing excerpt ---'
  if ($listing -contains 'package/dist/opencode-plugin.js') {
    Report-Pass 'tarball contains package/dist/opencode-plugin.js.'
  } else {
    Report-Fail 'tarball is missing package/dist/opencode-plugin.js.'
  }
}

# 4+5. Extract and verify the bundle + the exports["./server"] contract.
if ($tgz -and (Test-Path -LiteralPath $tgz)) {
  $extractDir = Join-Path $env:TEMP ('condense-extract-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $extractDir | Out-Null
  tar -xzf $tgz -C $extractDir
  if ($LASTEXITCODE -ne 0) {
    Report-Fail 'extracting the tarball failed.'
  } else {
    $pkgRoot = Join-Path $extractDir 'package'
    $checkFile = Join-Path $extractDir 'check-plugin.mjs'
    $checkJs = @'
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pkgRoot = process.argv[2];

function extractExportValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  for (const key of ['import', 'default']) {
    const nested = value[key];
    if (typeof nested === 'string') return nested;
  }
  return undefined;
}

const bundlePath = join(pkgRoot, 'dist', 'opencode-plugin.js');
const mod = await import(pathToFileURL(bundlePath).href);
const fns = Object.values(mod).filter((v) => typeof v === 'function');
if (fns.length !== 1) {
  console.error(`FAIL: expected exactly 1 function export, saw ${fns.length}: ${Object.keys(mod).join(',')}`);
  process.exit(1);
}
console.log('PASS: bundle exports a single function.');

const hooks = await fns[0]({});
if (typeof hooks['experimental.chat.messages.transform'] !== 'function') {
  console.error('FAIL: hooks object is missing experimental.chat.messages.transform function.');
  process.exit(1);
}
console.log('PASS: fake plugin input returns experimental.chat.messages.transform function.');

const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
const resolved = extractExportValue(pkg?.exports?.['./server']);
if (!resolved) {
  console.error('FAIL: exports["./server"] did not resolve to a string.');
  process.exit(1);
}
const target = join(pkgRoot, resolved);
if (!existsSync(target)) {
  console.error(`FAIL: resolved entrypoint ${resolved} does not exist in the package.`);
  process.exit(1);
}
console.log(`PASS: exports["./server"] resolves to ${resolved}, which exists.`);
console.log('ALL_NODE_CHECKS_PASSED');
'@
    Set-Content -LiteralPath $checkFile -Value $checkJs -Encoding utf8
    $nodeOut = @(node $checkFile $pkgRoot 2>&1)
    $nodeExit = $LASTEXITCODE
    $nodeOut | ForEach-Object { Write-Host $_ }
    if ($nodeExit -ne 0 -or -not ($nodeOut -contains 'ALL_NODE_CHECKS_PASSED')) {
      Report-Fail "'node check-plugin.mjs' failed (exit $nodeExit)."
    } else {
      Report-Pass 'bundle import + exports["./server"] resolution contract verified.'
    }
  }
}

# Summary.
if ($failures.Count -gt 0) {
  Write-Host ("RESULT: FAIL (" + $failures.Count + ' check(s) failed)')
  exit 1
} else {
  Write-Host 'RESULT: PASS (all npm plugin package checks passed)'
  exit 0
}
