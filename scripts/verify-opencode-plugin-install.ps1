# Verifies the condense opencode plugin install.
# For EACH target asserts: (a) file exists, (b) self-contained ESM
# bundle (no residual external import/require), (c) Node import exposes
# FastJevCompaction, (d) factory returns the transform hook. Plus (e) the
# user-scope env vars (shapes only, never values). Prints one PASS/FAIL line
# per assertion. Exit 0 iff everything passes, else 1.
# Targets: the resolved default (<$env:XDG_CONFIG_HOME or
# $env:USERPROFILE\.config>\opencode\plugins\condense.js) plus one per
# -ConfigDir root. A target whose config root does not exist prints a [skip]
# notice and its assertions FAIL (exit stays non-zero).
param(
  # Additional CONFIG ROOTS to also verify (each target is
  # <root>\opencode\plugins\condense.js).
  [string[]]$ConfigDir = @()
)
$ErrorActionPreference = 'Continue'
$failCount = 0

function Report($status, $message) {
  if ($status -eq 'PASS') { Write-Output "PASS: $message" }
  else { Write-Output "FAIL: $message"; $script:failCount++ }
}

$defaultConfigRoot = if (-not [string]::IsNullOrWhiteSpace($env:XDG_CONFIG_HOME)) { $env:XDG_CONFIG_HOME.Trim() } else { Join-Path $env:USERPROFILE '.config' }
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
  }
}

$nodeBuiltins = @('fs','path','os','util','events','stream','crypto','buffer','url',
  'querystring','child_process','worker_threads','assert','http','https','net','tls',
  'zlib','readline','perf_hooks','async_hooks','timers','string_decoder','punycode',
  'dgram','dns','cluster','v8','tty','constants','module','vm','process',
  'fs/promises','path/posix','path/win32','os/tmpdir','util/types','stream/promises',
  'stream/consumers','stream/web')

foreach ($entry in $targetEntries) {
  $t = $entry.File
  if (-not (Test-Path -LiteralPath $entry.Root)) {
    Write-Output "[skip] $t (config root does not exist: $($entry.Root))"
  } else {
    Write-Output "[ok] checking: $t"
  }
  # (a) exists
  $exists = Test-Path -LiteralPath $t
  if ($exists) { Report 'PASS' "[$t] (a) file exists" }
  else { Report 'FAIL' "[$t] (a) file exists (missing)" }

  # (b) self-contained bundle: no residual external import/require specifier
  if (-not $exists) {
    Report 'FAIL' "[$t] (b) self-contained bundle (file missing, cannot check)"
  } else {
    $content = Get-Content -LiteralPath $t -Raw -ErrorAction SilentlyContinue
    if ($null -eq $content) {
      Report 'FAIL' "[$t] (b) self-contained bundle (could not read file)"
    } else {
      $pattern = '(?:import\s[^;]*?from\s*|require\s*\(\s*|import\s*\(\s*)["'']([^"'']+)["'']'
      $matches = [regex]::Matches($content, $pattern)
      $external = @()
      foreach ($m in $matches) {
        $spec = $m.Groups[1].Value
        if ($spec.StartsWith('node:') -or $spec.StartsWith('data:')) { continue }
        if ($nodeBuiltins -contains $spec) { continue }
        $external += $spec
      }
      if ($external.Count -eq 0) { Report 'PASS' "[$t] (b) self-contained bundle (no external import/require)"
      } else { Report 'FAIL' "[$t] (b) self-contained bundle (external specifiers: $($external -join ', '))" }
    }
  }

  # (c) Node import exposes FastJevCompaction
  if (-not $exists) {
    Report 'FAIL' "[$t] (c) node import exposes FastJevCompaction (file missing)"
  } else {
    $fileUrl = 'file:///' + (($t -replace '\\','/').TrimStart('/'))
    $exprC = "import('$fileUrl').then(m => { if (typeof m.FastJevCompaction !== 'function') { console.error('missing FastJevCompaction export'); process.exit(1); } }).catch(e => { console.error('IMPORT_ERROR:' + ((e && e.stack) || String(e))); process.exit(2); })"
    $outC = & node --input-type=module -e $exprC 2>&1
    $codeC = $LASTEXITCODE
    if ($codeC -eq 0) { Report 'PASS' "[$t] (c) node import exposes FastJevCompaction"
    } else { Report 'FAIL' "[$t] (c) node import exposes FastJevCompaction (exit=$codeC)" }
  }

  # (d) factory returns the transform hook
  if (-not $exists) {
    Report 'FAIL' "[$t] (d) factory returns experimental.chat.messages.transform hook (file missing)"
  } else {
    $fileUrl = 'file:///' + (($t -replace '\\','/').TrimStart('/'))
    $exprD = "import('$fileUrl').then(async m => { try { const p = await m.FastJevCompaction({}); const f = p['experimental.chat.messages.transform']; if (typeof f !== 'function') { console.error('missing transform hook'); process.exit(1); } } catch (e) { console.error('FACTORY_ERROR:' + ((e && e.stack) || String(e))); process.exit(2); } }).catch(e => { console.error('IMPORT_ERROR:' + ((e && e.stack) || String(e))); process.exit(3); })"
    $outD = & node --input-type=module -e $exprD 2>&1
    $codeD = $LASTEXITCODE
    if ($codeD -eq 0) { Report 'PASS' "[$t] (d) factory returns experimental.chat.messages.transform hook"
    } else {
      Report 'FAIL' "[$t] (d) factory returns experimental.chat.messages.transform hook (exit=$codeD)"
    }
  }
}

# (e) user-scope env vars, read from the User scope (NOT the current
# process). Report only booleans/lengths — never the values.
$typesafeKey = [Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', 'User')
$openrouterKey = [Environment]::GetEnvironmentVariable('OPENROUTER_API_KEY', 'User')
$baseUrl = [Environment]::GetEnvironmentVariable('CONDENSE_BASE_URL', 'User')
$model = [Environment]::GetEnvironmentVariable('CONDENSE_MODEL', 'User')

$typesafePresent = (-not [string]::IsNullOrEmpty($typesafeKey))
$openrouterPresent = (-not [string]::IsNullOrEmpty($openrouterKey))
$typesafeLen = 0
$openrouterLen = 0
if ($null -ne $typesafeKey) { $typesafeLen = $typesafeKey.Length }
if ($null -ne $openrouterKey) { $openrouterLen = $openrouterKey.Length }
$keysEqual = ($null -ne $typesafeKey -and $null -ne $openrouterKey -and ($typesafeKey -ceq $openrouterKey))
$typesafeShape = ($typesafePresent -and $typesafeLen -ge 20 -and $typesafeKey.StartsWith('sk-'))
$openrouterShape = ($openrouterPresent -and $openrouterLen -ge 20 -and $openrouterKey.StartsWith('sk-'))
$baseUrlOk = (-not [string]::IsNullOrEmpty($baseUrl) -and $baseUrl.StartsWith('https://'))
$modelOk = (-not [string]::IsNullOrEmpty($model))

if ($typesafePresent) { Report 'PASS' '(e) user-scope env TYPESAFE_API_KEY is non-empty (present=True)' }
else { Report 'FAIL' '(e) user-scope env TYPESAFE_API_KEY is non-empty (present=False)' }
if ($openrouterPresent) { Report 'PASS' '(e) user-scope env OPENROUTER_API_KEY is non-empty (present=True)' }
else { Report 'FAIL' '(e) user-scope env OPENROUTER_API_KEY is non-empty (present=False)' }
if ($keysEqual) { Report 'PASS' '(e) user-scope env TYPESAFE_API_KEY equals OPENROUTER_API_KEY (equal=True)' }
else { Report 'FAIL' '(e) user-scope env TYPESAFE_API_KEY equals OPENROUTER_API_KEY (equal=False)' }
if ($typesafeShape) { Report 'PASS' "(e) user-scope env TYPESAFE_API_KEY has length >= 20 and starts with sk- (length=$typesafeLen)" }
else { Report 'FAIL' "(e) user-scope env TYPESAFE_API_KEY has length >= 20 and starts with sk- (length=$typesafeLen)" }
if ($openrouterShape) { Report 'PASS' "(e) user-scope env OPENROUTER_API_KEY has length >= 20 and starts with sk- (length=$openrouterLen)" }
else { Report 'FAIL' "(e) user-scope env OPENROUTER_API_KEY has length >= 20 and starts with sk- (length=$openrouterLen)" }
if ($baseUrlOk) { Report 'PASS' '(e) user-scope env CONDENSE_BASE_URL starts with https:// (valid=True)' }
else { Report 'FAIL' '(e) user-scope env CONDENSE_BASE_URL starts with https:// (valid=False)' }
if ($modelOk) { Report 'PASS' '(e) user-scope env CONDENSE_MODEL is non-empty (present=True)' }
else { Report 'FAIL' '(e) user-scope env CONDENSE_MODEL is non-empty (present=False)' }

if ($failCount -gt 0) { Write-Output "RESULT: $failCount assertion(s) FAILED"; exit 1 }
else { Write-Output 'RESULT: all assertions PASSED'; exit 0 }
