<#
Install primer on Windows.

  irm https://raw.githubusercontent.com/vedan/primer/main/install.ps1 | iex

Puts a single file in %USERPROFILE%\.local\bin — the same directory Claude Code
installs itself into, so if you have Claude Code, this is already on your PATH.
No Node, no npm, no build step, no administrator rights. Removing it is a delete.

Set PRIMER_REPO to install from a fork, PRIMER_VERSION to pin a release.
#>

$ErrorActionPreference = 'Stop'

$repo    = if ($env:PRIMER_REPO)    { $env:PRIMER_REPO }    else { 'vedan/primer' }
$version = if ($env:PRIMER_VERSION) { $env:PRIMER_VERSION } else { 'latest' }
$binDir  = if ($env:PRIMER_BIN_DIR) { $env:PRIMER_BIN_DIR } else { Join-Path $HOME '.local\bin' }

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'x64' }
  'ARM64' { 'arm64' }
  default { throw "Unsupported processor: $($env:PROCESSOR_ARCHITECTURE)" }
}
$asset = "primer-windows-$arch.exe"

# PRIMER_URL points the installer at a mirror, an internal file server, or a
# locally built binary. It is also how the success path gets tested without
# publishing a release.
$url = if ($env:PRIMER_URL) {
  $env:PRIMER_URL
} elseif ($version -eq 'latest') {
  "https://github.com/$repo/releases/latest/download/$asset"
} else {
  "https://github.com/$repo/releases/download/$version/$asset"
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("primer-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  Write-Host "Downloading primer (windows/$arch)..."
  try {
    Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmp 'primer.exe') -UseBasicParsing
  } catch {
    throw "Could not download $url`nIf this checkout has no releases yet, build from source instead:`n  npm install; npm run build; npm link"
  }

  # Verify against the checksum published beside the binary. A silently corrupted
  # 90MB download otherwise surfaces much later as an unreadable crash.
  $sumFile = Join-Path $tmp 'primer.sha256'
  $haveSum = $false
  try {
    Invoke-WebRequest -Uri "$url.sha256" -OutFile $sumFile -UseBasicParsing
    $haveSum = $true
  } catch {
    Write-Host "Note: no published checksum for this release; skipping verification."
  }
  if ($haveSum) {
    $expected = ((Get-Content $sumFile -Raw).Trim() -split '\s+')[0]
    $actual = (Get-FileHash (Join-Path $tmp 'primer.exe') -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected.ToLower()) {
      throw "Checksum mismatch - refusing to install.`n  expected $expected`n  got      $actual"
    }
    Write-Host "Checksum verified."
  }

  $target = Join-Path $binDir 'primer.exe'
  # A running copy cannot be overwritten on Windows; say so plainly rather than
  # failing with "the process cannot access the file".
  if (Test-Path $target) {
    try {
      Move-Item -Force (Join-Path $tmp 'primer.exe') $target
    } catch {
      throw "Could not replace $target - primer may be running. Stop it (primer autostart off) and re-run."
    }
  } else {
    Move-Item (Join-Path $tmp 'primer.exe') $target
  }

  Write-Host ""
  Write-Host "primer installed to $target"

  # Put it on PATH for future shells. The user-level variable needs no admin rights.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not ($userPath -split ';' | Where-Object { $_ -eq $binDir })) {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$binDir", 'User')
    Write-Host "Added $binDir to your PATH. Open a new terminal for it to take effect."
  }
  # And for this shell, so the next line actually runs.
  if (-not ($env:Path -split ';' | Where-Object { $_ -eq $binDir })) {
    $env:Path = "$env:Path;$binDir"
  }

  Write-Host ""
  Write-Host "Next:"
  Write-Host "  primer start        set up your first child, and open the parent page"
  Write-Host ""
  Write-Host "Primer drives the tutor through Claude Code, so install that too if you"
  Write-Host "have not: https://claude.com/claude-code"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
