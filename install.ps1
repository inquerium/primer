<#
Install primer on Windows.

  irm https://raw.githubusercontent.com/VedSoni-dev/primer/main/install.ps1 | iex

Puts a single file in %USERPROFILE%\.local\bin — the same directory Claude Code
installs itself into, so if you have Claude Code, this is already on your PATH.
No Node, no npm, no build step, no administrator rights. Removing it is a delete.

Set PRIMER_REPO to install from a fork, PRIMER_VERSION to pin a release.
#>

$ErrorActionPreference = 'Stop'

$repo    = if ($env:PRIMER_REPO)    { $env:PRIMER_REPO }    else { 'VedSoni-dev/primer' }
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
  # 90MB download otherwise surfaces much later as an unreadable crash — and on the
  # official release path, a missing checksum must refuse to install rather than
  # skip the check, or suppressing one request is all it takes to defeat it.
  # PRIMER_URL is the one case allowed to proceed unverified: it is already an
  # explicit, opted-in override of the normal source.
  $sumFile = Join-Path $tmp 'primer.sha256'
  $haveSum = $false
  try {
    Invoke-WebRequest -Uri "$url.sha256" -OutFile $sumFile -UseBasicParsing
    if ((Get-Item $sumFile).Length -gt 0) { $haveSum = $true }
  } catch {
    # handled below
  }
  if ($haveSum) {
    $expected = ((Get-Content $sumFile -Raw).Trim() -split '\s+')[0]
    $actual = (Get-FileHash (Join-Path $tmp 'primer.exe') -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected.ToLower()) {
      throw "Checksum mismatch - refusing to install.`n  expected $expected`n  got      $actual"
    }
    Write-Host "Checksum verified."
  } elseif ($env:PRIMER_URL) {
    Write-Host "Note: no checksum at PRIMER_URL.sha256; skipping verification (explicit override)."
  } else {
    throw "No checksum found at $url.sha256 - refusing to install an unverified binary."
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
  #
  # Two things a naive version of this gets wrong, and both are worse than not
  # touching PATH at all. First: an account with no user-scope Path is $null, and
  # appending to that leaves a leading ";" — an empty PATH entry, which Windows
  # resolves as the current directory, so every command in every new shell would
  # search whatever folder the user happens to be standing in first. Second:
  # GetEnvironmentVariable expands a REG_EXPAND_SZ value (one containing
  # %USERPROFILE% and the like) and writing it back with SetEnvironmentVariable
  # always stores REG_SZ, permanently freezing any such entry to today's expansion
  # — the classic "PowerShell ate my PATH" bug. Reading and writing through the
  # registry directly avoids both.
  $existing = (Get-ItemProperty -Path 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue).Path
  $entries = @()
  if ($existing) { $entries = $existing -split ';' | Where-Object { $_ -ne '' } }
  if ($entries -notcontains $binDir) {
    $newPath = ($entries + $binDir) -join ';'
    Set-ItemProperty -Path 'HKCU:\Environment' -Name Path -Value $newPath -Type ExpandString
    # Tell running processes (Explorer, other shells) that the environment changed,
    # or the new PATH is invisible until next login.
    $signature = '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
      public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam,
        string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
    try {
      $user32 = Add-Type -MemberDefinition $signature -Name NativeMethods -Namespace Primer -PassThru
      $result = [UIntPtr]::Zero
      $user32::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null
    } catch {
      # Broadcasting the change is an optimization, not a requirement.
    }
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
