# Builds the condense opencode plugin bundle and installs it into the
# resolved default plugins dir (plus any extra config roots passed via
# -ConfigDir), then sets the user-scope env vars.
# Usage (from the repo root): powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-opencode-plugin.ps1 [-ConfigDir <root> ...]
# Optional automation params: -ApiKey -BaseUrl -Model -RepoRoot -ConfigDir (see param block).
param(
  # NOTE: -ApiKey is accepted for automation but NOT recommended: command
  # lines and PowerShell history can retain it. Prefer TYPESAFE_API_KEY in
  # the environment or the repo-root .env file, or the interactive prompt.
  [string]$ApiKey = '',
  [string]$BaseUrl = 'https://openrouter.ai/api/alpha/decisions',
  [string]$Model = '~typesafe/jev-latest',
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  # Additional CONFIG ROOTS to also install into (each target is
  # <root>\opencode\plugins\condense.js). The default root needs no flag:
  # $env:XDG_CONFIG_HOME when set and non-empty, else $env:USERPROFILE\.config.
  [string[]]$ConfigDir = @()
)
# NOTE: deliberately 'Continue', not 'Stop'. In PowerShell 5.1 any native
# command writing to stderr (npm prints "npm notice" lines there, esbuild
# prints its build summary there) surfaces as a NativeCommandError, which
# under 'Stop' would terminate the script at the build step before the copy
# step. All failures are tracked explicitly via $LASTEXITCODE checks and
# -ErrorAction Stop on the critical file cmdlets below.
$ErrorActionPreference = 'Continue'

function Read-DotEnvKeys($envPath) {
  # Parse a .env file strictly as DATA: one KEY=VALUE per line, skip blanks
  # and '#' comments, split on the FIRST '=', trim whitespace and surrounding
  # single/double quotes. NEVER evaluates file content (no Invoke-Expression,
  # no dot-sourcing).
  $found = @{}
  if (-not (Test-Path -LiteralPath $envPath)) { return $found }
  foreach ($line in (Get-Content -LiteralPath $envPath)) {
    $t = $line.Trim()
    if ($t -eq '') { continue }
    if ($t.StartsWith('#')) { continue }
    $idx = $t.IndexOf('=')
    if ($idx -lt 0) { continue }
    $k = $t.Substring(0, $idx).Trim()
    $v = $t.Substring($idx + 1).Trim()
    if ($v.Length -ge 2) {
      $first = $v.Substring(0, 1)
      $last = $v.Substring($v.Length - 1, 1)
      if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
        $v = $v.Substring(1, $v.Length - 2)
      }
    }
    if ($k -eq 'TYPESAFE_API_KEY' -or $k -eq 'OPENROUTER_API_KEY') {
      $found[$k] = $v
    }
  }
  return $found
}

function Resolve-ApiKey($explicitKey, $repoRootPath) {
  if (-not [string]::IsNullOrWhiteSpace($explicitKey)) { return $explicitKey.Trim() }
  # (1) TYPESAFE_API_KEY from the current process environment.
  if (-not [string]::IsNullOrWhiteSpace($env:TYPESAFE_API_KEY)) { return $env:TYPESAFE_API_KEY.Trim() }
  # (2) repo-root .env file (strict DATA parsing; both aliases honored).
  $dotenv = Read-DotEnvKeys (Join-Path $repoRootPath '.env')
  $fromTypesafe = ''
  $fromOpenRouter = ''
  if ($dotenv.ContainsKey('TYPESAFE_API_KEY')) { $fromTypesafe = $dotenv['TYPESAFE_API_KEY'] }
  if ($dotenv.ContainsKey('OPENROUTER_API_KEY')) { $fromOpenRouter = $dotenv['OPENROUTER_API_KEY'] }
  $hasTypesafe = -not [string]::IsNullOrWhiteSpace($fromTypesafe)
  $hasOpenRouter = -not [string]::IsNullOrWhiteSpace($fromOpenRouter)
  if ($hasTypesafe -and $hasOpenRouter) {
    if ($fromTypesafe.Trim() -cne $fromOpenRouter.Trim()) {
      throw 'Refusing to choose: .env contains BOTH TYPESAFE_API_KEY and OPENROUTER_API_KEY with DIFFERENT non-empty values. Set exactly one (or make them equal).'
    }
    return $fromTypesafe.Trim()
  }
  if ($hasTypesafe) { return $fromTypesafe.Trim() }
  if ($hasOpenRouter) { return $fromOpenRouter.Trim() }
  # (3) OPENROUTER_API_KEY from the current process environment.
  if (-not [string]::IsNullOrWhiteSpace($env:OPENROUTER_API_KEY)) { return $env:OPENROUTER_API_KEY.Trim() }
  # (4) interactive prompt (secure; never echoed).
  try {
    $secure = Read-Host -AsSecureString -Prompt 'Enter API key (TYPESAFE_API_KEY)'
  } catch {
    return ''
  }
  if ($null -eq $secure) { return '' }
  $ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
  if ([string]::IsNullOrWhiteSpace($plain)) { return '' }
  return $plain.Trim()
}

$usage = @'
Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-opencode-plugin.ps1 [-ApiKey <key>] [-BaseUrl <url>] [-Model <name>] [-RepoRoot <dir>] [-ConfigDir <root> ...]
Resolves the API key WITHOUT ever embedding it in the script, first non-empty wins:
  1. $env:TYPESAFE_API_KEY
  2. repo-root .env file (TYPESAFE_API_KEY / OPENROUTER_API_KEY; both present with different values = fatal)
  3. $env:OPENROUTER_API_KEY
  4. interactive prompt (Read-Host -AsSecureString)
Sets User-scope + current-process: TYPESAFE_API_KEY, OPENROUTER_API_KEY (= the key), CONDENSE_BASE_URL, CONDENSE_MODEL.
'@

$resolvedKey = ''
try {
  $resolvedKey = Resolve-ApiKey $ApiKey $RepoRoot
} catch {
  Write-Error "$($_.Exception.Message)`n$usage"
  exit 1
}
if ([string]::IsNullOrWhiteSpace($resolvedKey)) {
  Write-Error "No API key resolved. Provide `$env:TYPESAFE_API_KEY, a repo-root .env entry, `$env:OPENROUTER_API_KEY, or the interactive prompt.`n$usage"
  exit 1
}

Push-Location $RepoRoot
try {
  & npm run build:plugin
  if ($LASTEXITCODE -ne 0) { Write-Error "build:plugin failed with exit $LASTEXITCODE"; exit 1 }
} finally {
  Pop-Location
}

$artifact = Join-Path $RepoRoot 'dist\opencode-plugin.js'
if (-not (Test-Path -LiteralPath $artifact)) { Write-Error "build artifact missing: $artifact"; exit 1 }

$artifactHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact -ErrorAction Stop).Hash
Write-Output "artifact sha256: $artifactHash  ($artifact)"

# Portable target resolution: the default config root is $env:XDG_CONFIG_HOME
# when set and non-empty, else $env:USERPROFILE\.config. The plugins dir is
# <configRoot>\opencode\plugins (the config root is the dir that CONTAINS
# opencode\). Extra config roots come from -ConfigDir; each yields one more
# <root>\opencode\plugins\condense.js target. A non-default root that does
# not exist is SKIPPED (never created silently); only the default tree may
# be created.
$defaultConfigRoot = if (-not [string]::IsNullOrWhiteSpace($env:XDG_CONFIG_HOME)) { $env:XDG_CONFIG_HOME.Trim() } else { Join-Path $env:USERPROFILE '.config' }
$defaultKey = $defaultConfigRoot.Trim().ToLowerInvariant()
$seenRoots = @{}
$targetEntries = @()
foreach ($root in (@($defaultConfigRoot) + @($ConfigDir))) {
  if ([string]::IsNullOrWhiteSpace($root)) { continue }
  $r = $root.Trim()
  $key = $r.ToLowerInvariant()
  if ($seenRoots.ContainsKey($key)) { continue }
  $seenRoots[$key] = $true
  $targetEntries += [pscustomobject]@{
    Root = $r
    File = (Join-Path $r 'opencode\plugins\condense.js')
    IsDefault = ($key -eq $defaultKey)
  }
}

foreach ($entry in $targetEntries) {
  $t = $entry.File
  if (-not $entry.IsDefault -and -not (Test-Path -LiteralPath $entry.Root)) {
    Write-Output "[skip] $t (config root does not exist: $($entry.Root))"
    continue
  }
  $dir = Split-Path -Parent $t
  New-Item -ItemType Directory -Path $dir -Force -ErrorAction Stop | Out-Null
  Copy-Item -LiteralPath $artifact -Destination $t -Force -ErrorAction Stop
  $h = (Get-FileHash -Algorithm SHA256 -LiteralPath $t -ErrorAction Stop).Hash
  Write-Output "[ok] installed: $t"
  Write-Output "sha256: $h  ($t)"
}

$vars = @{
  'TYPESAFE_API_KEY'  = $resolvedKey
  'OPENROUTER_API_KEY' = $resolvedKey
  'CONDENSE_BASE_URL' = $BaseUrl
  'CONDENSE_MODEL'    = $Model
}
foreach ($name in $vars.Keys) {
  [Environment]::SetEnvironmentVariable($name, $vars[$name], 'User')
  [Environment]::SetEnvironmentVariable($name, $vars[$name], 'Process')
  # NEVER print the key value (not even truncated, verbose, or in errors).
  if ($name -eq 'TYPESAFE_API_KEY' -or $name -eq 'OPENROUTER_API_KEY') { Write-Output "env set: $name (value hidden)" }
  else { Write-Output "env set: $name=$($vars[$name])" }
}

Write-Output 'done.'
