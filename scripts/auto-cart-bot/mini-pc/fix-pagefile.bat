@echo off
REM Give the box a page file big enough that a burst cannot exhaust COMMIT. Run as admin.
REM
REM WHY: on 2026-08-11 supervise.ps1 could not start a shell at all — "the paging file is
REM too small for this operation to complete", then an OutOfMemoryException. A supervisor
REM that cannot launch a shell cannot restart anything, so the one process whose job is to
REM bring the keep-warm and hold runner back was the process that failed, silently.
REM
REM It was NOT a disk problem — 404 GB free the same night. The limit that ran out is
REM COMMIT (RAM + page file), and a system-managed page file grows lazily, so a burst can
REM outrun the growth and get refused with the disk nearly empty.
REM
REM This raises the ceiling. It does not reduce what we put under it — for that, ask the
REM admin page for "Memory, commit and the browsers we are running" and read the Chromium
REM numbers, which are the large ones.
REM
REM IT DOES NOT REBOOT, and the change is not live until you do. A restart ends the RC
REM session exactly like update.bat, so time it the same way: not within six hours of a
REM release, and run start-all.bat then rc-login.bat afterwards.
setlocal
set SCRIPT=%~dp0fix-pagefile.ps1

net session >nul 2>&1
if errorlevel 1 (
  echo(
  echo *** Run this as Administrator — right-click, "Run as administrator". ***
  echo     Changing the page file needs it.
  echo(
  echo     To just LOOK without changing anything, no admin needed:
  echo       powershell -ExecutionPolicy Bypass -File "%SCRIPT%"
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Apply
echo(
pause
