# Wirescry's Windows test PC: runs before every job the self-hosted runner picks up
# (ACTIONS_RUNNER_HOOK_JOB_STARTED in C:\actions-runner\.env), and fails the job unless it is
# the Docker Desktop workflow, from main or a release tag, started by a push or by hand.
#
# Why: casazium/wirescry is public. A pull request from a fork runs the workflow files from
# the fork, so it could add a job that asks for this runner's labels and run its own code
# here. This check lives on the PC, copied from docs/windows-runner-guard.ps1 at setup, so no
# pull request can change it. GitHub doesn't let a workflow override GITHUB_* variables.
#
# See docs/WINDOWS-TEST-PC.md.

$repository = 'casazium/wirescry'
$workflow = "$repository/.github/workflows/windows-docker-desktop.yml"
$events = @('push', 'workflow_dispatch')

$reasons = @()
if ($env:GITHUB_REPOSITORY -ne $repository) {
  $reasons += "repository '$($env:GITHUB_REPOSITORY)' isn't $repository"
}
if ($events -notcontains $env:GITHUB_EVENT_NAME) {
  $reasons += "event '$($env:GITHUB_EVENT_NAME)' isn't push or workflow_dispatch"
}
$ref = [regex]::Escape($workflow) + '@refs/(heads/main|tags/v[0-9][^/]*)$'
if ($env:GITHUB_WORKFLOW_REF -notmatch "^$ref") {
  $reasons += "workflow '$($env:GITHUB_WORKFLOW_REF)' isn't $workflow on main or a release tag"
}

if ($reasons.Count -gt 0) {
  Write-Output "Refused by the Windows test PC's guard: $($reasons -join '; ')."
  exit 1
}
Write-Output "Windows test PC guard: $($env:GITHUB_WORKFLOW_REF) ($($env:GITHUB_EVENT_NAME)) allowed."
