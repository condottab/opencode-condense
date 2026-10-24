# Installs the opencode-condense opencode 2.x plugin into a local plugin
# directory and sets the user-scope env vars it reads.
#
# Why this replaces scripts\install-opencode-plugin.ps1: that script installs
# the V1 hook bundle (dist\opencode-plugin.js) as a single file, and its V1 hook
# (`experimental.chat.messages.transform`) no longer exists in 2.x. 2.x
# discovers local plugins as .ts/.js files or immediate package directories
# under `<configRoot>\plugins\` (verified against 2.0.8), and calls the
# `id`/`setup` contract exported by the entry.
#
# Usage (from the repo root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-opencode-plugin-v2.ps1
# With a key for automation:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-opencode-plugin-v2.ps1 -ApiKey sk-...
param(
  # Prefer TYPESAFE_API_KEY in the environment or the repo-root .env; a command
  # line can retain the key in PowerShell history.
  [string]$ApiKey = '',
  [string]$BaseUrl = '',
  [string]$Model = '',
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  # Plugin name (the directory under <configRoot>\plugins\).
  [string]$Name = 'condense',
  # Extra CONFIG ROOTS to also install into (each target is
  # <root>\opencode\plugins\<name>\index.ts).
  [string[]]$ConfigDir = @()
)
$ErrorActionPreference = 'Stop'

function Read-DotEnvKeys($envPath) {
  # Parse a .env file strictly as DATA: one KEY=VALUE per line, skip blanks and
  # '#' comments, split on the FIRST '='. Never evaluates file content.
  $found = @{}
  if (-not (Test-Path -LiteralPath $envPath)) { return $found }
  foreach ($line in (Get-Content -LiteralPath $envPath)) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $idx = $t.IndexOf('=')
    if ($idx -lt 0) { continue }
    $k = $t.Substring(0, $idx).Trim()
    $v = $t.Substring($idx + 1).Trim()
    if ($v.Length -ge 2) {
      $first = $v.Substring(0, 1); $last = $v.Substring($v.Length - 1, 1)
      if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
        $v = $v.Substring(1, $v.Length - 2)
      }
    }
    if ($k -eq 'TYPESAFE_API_KEY' -or $k -eq 'OPENROUTER_API_KEY') { $found[$k] = $v }
  }
  return $found
}

$resolvedKey = ''
if (-not [string]::IsNullOrWhiteSpace($ApiKey)) {
  $resolvedKey = $ApiKey.Trim()
} elseif (-not [string]::IsNullOrWhiteSpace($env:TYPESAFE_API_KEY)) {
  $resolvedKey = $env:TYPESAFE_API_KEY.Trim()
} else {
  # A key set with `setx` / System Properties lives in the User scope, which a
  # freshly spawned process does not inherit. Read it explicitly so "I set it in
  # my environment" works without restarting the shell.
  $userScoped = [Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', 'User')
  if (-not [string]::IsNullOrWhiteSpace($userScoped)) {
    $resolvedKey = $userScoped.Trim()
  }
}
if ([string]::IsNullOrWhiteSpace($resolvedKey)) {
  $dotenv = Read-DotEnvKeys (Join-Path $RepoRoot '.env')
  $ts = if ($dotenv.ContainsKey('TYPESAFE_API_KEY')) { $dotenv['TYPESAFE_API_KEY'] } else { '' }
  $or = if ($dotenv.ContainsKey('OPENROUTER_API_KEY')) { $dotenv['OPENROUTER_API_KEY'] } else { '' }
  if (-not [string]::IsNullOrWhiteSpace($ts)) { $resolvedKey = $ts.Trim() }
  elseif (-not [string]::IsNullOrWhiteSpace($or)) { $resolvedKey = $or.Trim() }
  elseif (-not [string]::IsNullOrWhiteSpace($env:OPENROUTER_API_KEY)) {
    $resolvedKey = $env:OPENROUTER_API_KEY.Trim()
  } else {
    $userOpenRouter = [Environment]::GetEnvironmentVariable('OPENROUTER_API_KEY', 'User')
    if (-not [string]::IsNullOrWhiteSpace($userOpenRouter)) {
      $resolvedKey = $userOpenRouter.Trim()
    }
  }
}

# The plugin entry, which imports the fork's TypeScript source directly:
# opencode 2.x loads local plugins as TypeScript and the core/library files are
# plain .ts, so there is no build step and no bundle to copy.
$entry = @"
// Local plugin entry for opencode-condense (opencode 2.x).
// Installed by scripts\install-opencode-plugin-v2.ps1; it imports the plugin
// from the checkout so edits take effect on reload without re-installing.
import { createCondenseV2Plugin } from "$($RepoRoot -replace '\\','/')/opencode/v2-plugin.ts";

export default createCondenseV2Plugin();
"@

$defaultConfigRoot = if (-not [string]::IsNullOrWhiteSpace($env:XDG_CONFIG_HOME)) {
  $env:XDG_CONFIG_HOME.Trim()
} else {
  Join-Path $env:USERPROFILE '.config'
}
$defaultKey = $defaultConfigRoot.Trim().ToLowerInvariant()
$seenRoots = @{}
$targets = @()
foreach ($root in (@($defaultConfigRoot) + @($ConfigDir))) {
  if ([string]::IsNullOrWhiteSpace($root)) { continue }
  $r = $root.Trim()
  $key = $r.ToLowerInvariant()
  if ($seenRoots.ContainsKey($key)) { continue }
  $seenRoots[$key] = $true
  $targets += [pscustomobject]@{
    Root      = $r
    File      = (Join-Path $r "opencode\plugins\$Name\index.ts")
    IsDefault = ($key -eq $defaultKey)
  }
}

foreach ($entryTarget in $targets) {
  $file = $entryTarget.File
  if (-not $entryTarget.IsDefault -and -not (Test-Path -LiteralPath $entryTarget.Root)) {
    Write-Output "[skip] $file (config root does not exist: $($entryTarget.Root))"
    continue
  }
  $dir = Split-Path -Parent $file
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  # Write UTF-8 WITHOUT a BOM: Windows PowerShell 5.1's `-Encoding UTF8` emits a
  # BOM (`EF BB BF`) that some tooling chokes on. The .NET API writes cleanly on
  # both 5.1 and 7.
  [System.IO.File]::WriteAllText($file, $entry, [System.Text.UTF8Encoding]::new($false))
  Write-Output "[ok] installed: $file"
}

if (-not [string]::IsNullOrWhiteSpace($resolvedKey)) {
  $vars = @{ 'TYPESAFE_API_KEY' = $resolvedKey }
  if (-not [string]::IsNullOrWhiteSpace($BaseUrl)) { $vars['CONDENSE_BASE_URL'] = $BaseUrl }
  if (-not [string]::IsNullOrWhiteSpace($Model)) { $vars['CONDENSE_MODEL'] = $Model }
  foreach ($name in $vars.Keys) {
    [Environment]::SetEnvironmentVariable($name, $vars[$name], 'User')
    [Environment]::SetEnvironmentVariable($name, $vars[$name], 'Process')
    # Never print the key value, not even truncated.
    if ($name -eq 'TYPESAFE_API_KEY') { Write-Output "env set: $name (value hidden)" }
    else { Write-Output "env set: $name=$($vars[$name])" }
  }
} else {
  Write-Warning 'No API key resolved. The plugin installs but will fail-open (log an error, leave history untouched) until TYPESAFE_API_KEY is set.'
}

Write-Output 'Restart the opencode service so the plugin is discovered: opencode service restart'
