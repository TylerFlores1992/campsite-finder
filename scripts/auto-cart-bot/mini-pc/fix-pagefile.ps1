# Give this box a page file big enough that a burst cannot exhaust COMMIT.
#
# ASCII ONLY. Windows PowerShell 5.1 reads a .ps1 without a BOM as Windows-1252, where a
# curly quote ends a string early - one em dash took all four supervised processes down on
# 2026-08-11. worker/update-guard.test.mts fails on any non-ASCII byte in this directory.
#
# ---------------------------------------------------------------------------------------
# WHY
#
# On 2026-08-11 supervise.ps1 could not start a shell AT ALL:
#
#     Starting the CLR failed with HRESULT 80004005.
#     Could not load file or assembly 'System.Management.Automation' ...
#     The paging file is too small for this operation to complete. (0x800705AF)
#     Exception of type 'System.OutOfMemoryException' was thrown.
#
# A supervisor that cannot launch a shell cannot restart anything. That is the process
# whose entire job is to bring the keep-warm and the hold runner back, so this fails
# exactly when it is needed - and it leaves no mark on any dashboard, because the
# supervisor is the thing that would have reported.
#
# THE NUMBER THAT RAN OUT IS COMMIT, NOT DISK. `disk-free` answered 404 GB free the same
# night, which reads as "not a space problem" and sends the question the wrong way.
# "The paging file is too small" means Windows could not GROW the page file to satisfy a
# commit request. Commit limit = RAM + page file, and a system-managed page file grows
# lazily - so a burst (four Chromium instances waking at once, npm ci, an update) can
# outrun the growth and get an allocation refused while the disk is nearly empty.
#
# WHAT THIS DOES AND DOES NOT FIX. It raises the ceiling. It does not reduce what we put
# under it, and the largest consumers are the Chromium instances the `memory` diagnostic
# was added to make visible. Read that first if you have not: a page file is the cheap
# half of the answer, not the whole of it.
#
# ---------------------------------------------------------------------------------------
# SAFETY
#
# Reports by default and changes NOTHING. Pass -Apply to write the setting. That posture
# is deliberate: this edits system configuration on the machine holding the RC session,
# and it should never happen because somebody double-clicked a file to have a look.
#
# It does not reboot, and it never will. The new size does not fully take effect until a
# restart, and a restart ends the RC session - so time it like an update: not within six
# hours of a release. Check first with `npx tsx scripts/rc-holds-readout.mts` or the admin
# page.

[CmdletBinding()]
param([switch]$Apply)

$ErrorActionPreference = 'Stop'

function Line($s) { Write-Host $s }

$cs  = Get-CimInstance Win32_ComputerSystem
$os  = Get-CimInstance Win32_OperatingSystem
$ramBytes = [double]$cs.TotalPhysicalMemory
$ramGB    = [Math]::Round($ramBytes / 1GB, 1)

$commitLimitGB = [Math]::Round(([double]$os.TotalVirtualMemorySize * 1KB) / 1GB, 1)
$commitFreeGB  = [Math]::Round(([double]$os.FreeVirtualMemory     * 1KB) / 1GB, 1)
$commitUsedGB  = [Math]::Round($commitLimitGB - $commitFreeGB, 1)

$sysDrive = ($env:SystemDrive)
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$sysDrive'"
$freeDiskGB = [Math]::Round([double]$disk.FreeSpace / 1GB, 1)

Line ''
Line "RAM            $ramGB GB"
Line "COMMIT         $commitUsedGB GB used of $commitLimitGB GB limit"
Line "FREE DISK      $freeDiskGB GB on $sysDrive"
Line "AUTO-MANAGED   $($cs.AutomaticManagedPagefile)"

$usage = @(Get-CimInstance Win32_PageFileUsage)
if ($usage.Count -eq 0) {
  Line 'PAGE FILE      none in use'
} else {
  foreach ($u in $usage) {
    $alloc = [Math]::Round($u.AllocatedBaseSize / 1024, 1)
    $peak  = [Math]::Round($u.PeakUsage / 1024, 1)
    Line "PAGE FILE      $($u.Name) - $alloc GB allocated, peak $peak GB"
  }
}

$setting = @(Get-CimInstance Win32_PageFileSetting)
if ($setting.Count -eq 0) {
  Line 'SETTING        system managed (Windows grows it lazily - this is the failure mode)'
} else {
  foreach ($s in $setting) {
    Line "SETTING        $($s.Name) - initial $($s.InitialSize) MB, max $($s.MaximumSize) MB"
  }
}

# SIZED FROM THIS BOX'S RAM, not from a number somebody remembered. An explicit INITIAL
# size is the whole point: Windows reserves it up front instead of growing under pressure,
# which is the growth that loses a burst. The floors matter more than the multipliers on a
# small-RAM machine, where 1.5x is not enough headroom for four browsers.
$initMB = [int][Math]::Max([Math]::Ceiling(1.5 * $ramGB) * 1024, 16 * 1024)
$maxMB  = [int][Math]::Max(4 * $ramGB * 1024, 32 * 1024)

Line ''
Line "PROPOSED       initial $([Math]::Round($initMB/1024,1)) GB, max $([Math]::Round($maxMB/1024,1)) GB on $sysDrive"
Line "               (commit limit would become about $([Math]::Round($ramGB + $maxMB/1024, 1)) GB at full stretch)"

# Refuse rather than fill the disk. The margin is generous on purpose: this drive also
# holds the Chromium profiles, the logs and an npm checkout that an update doubles.
$needGB = [Math]::Round($maxMB / 1024, 1) + 20
if ($freeDiskGB -lt $needGB) {
  Line ''
  Line "*** REFUSING: wants $needGB GB of headroom and $sysDrive has $freeDiskGB GB. ***"
  Line '    Nothing was changed.'
  exit 1
}

if (-not $Apply) {
  Line ''
  Line 'Report only. Nothing was changed.'
  Line 'Run fix-pagefile.bat as Administrator to apply it.'
  exit 0
}

# Written out rather than as one backtick-continued expression on purpose. A backtick with
# a single trailing space after it stops being a line continuation and the parse fails
# several lines later, which is the same class of injury as the em dash.
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$admin     = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Line ''
  Line '*** Needs Administrator. Nothing was changed. ***'
  exit 1
}

# Automatic management OVERRIDES an explicit setting, so it has to go first or the write
# below is accepted and then quietly ignored - a change that reports success and does
# nothing, which is the failure this project keeps meeting.
if ($cs.AutomaticManagedPagefile) {
  Line ''
  Line 'Turning off automatic page file management...'
  Set-CimInstance -InputObject $cs -Property @{ AutomaticManagedPagefile = $false } | Out-Null
}

$target = "$sysDrive\pagefile.sys"
$existing = @(Get-CimInstance Win32_PageFileSetting | Where-Object { $_.Name -eq $target })
if ($existing.Count -gt 0) {
  Line "Updating $target ..."
  Set-CimInstance -InputObject $existing[0] -Property @{ InitialSize = $initMB; MaximumSize = $maxMB } | Out-Null
} else {
  Line "Creating $target ..."
  $props = @{ Name = $target; InitialSize = $initMB; MaximumSize = $maxMB }
  New-CimInstance -ClassName Win32_PageFileSetting -Property $props | Out-Null
}

# READ IT BACK. A setting that did not take is the same silence as one that did, and this
# class is exactly the kind that accepts a write and ignores it when something upstream
# (automatic management, policy) still owns the value.
$after = @(Get-CimInstance Win32_PageFileSetting | Where-Object { $_.Name -eq $target })
Line ''
if ($after.Count -eq 0) {
  Line '*** The setting is not there after writing it. Nothing took effect. ***'
  exit 1
}
Line "NOW            $($after[0].Name) - initial $($after[0].InitialSize) MB, max $($after[0].MaximumSize) MB"
if ($after[0].InitialSize -ne $initMB -or $after[0].MaximumSize -ne $maxMB) {
  Line '*** That is not what was asked for - something else owns this value. ***'
  exit 1
}

Line ''
Line 'Applied. IT IS NOT LIVE UNTIL A RESTART.'
Line ''
Line 'Reboot like an update, not right now:'
Line '  * a restart ends the RC session, same as update.bat,'
Line '  * so not within six hours of a release - check the admin page or'
Line '    NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-holds-readout.mts,'
Line '  * after the reboot, run start-all.bat and then rc-login.bat.'
Line ''
