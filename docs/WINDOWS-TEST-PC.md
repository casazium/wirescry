# The Windows test PC

A small x64 Windows PC (an HP EliteDesk 800 G6 Mini: Intel Core i5-10500, 32 GB, Windows 11 Pro)
that tests Wirescry the way Windows users run it, with Docker Desktop and Linux containers.
GitHub's own Windows runners can't: they have Docker Engine with Windows containers only.

It does two jobs:

- **Hands-on checks** before a release, over Remote Desktop from the Mac.
- **A GitHub Actions runner** for
  [`.github/workflows/windows-docker-desktop.yml`](../.github/workflows/windows-docker-desktop.yml),
  which runs `test/docker-e2e.test.ts` against Docker Desktop on pushes to `main`, release tags
  and manual runs.

## Read this first: safety

casazium/wirescry is public, and a self-hosted runner runs whatever code a job gives it. A
pull request from a fork runs the **fork's** workflow files, so a stranger could add a job that
asks for this PC by its labels. Three things keep that out, and all three are part of the setup:

1. **Approval for every outside contributor** (step 1), set before the runner exists. When you
   approve a fork's workflow run, read its changes to `.github/` first: approving runs its code.
2. **A guard on the PC** (step 7) that the runner calls before every job. It refuses anything
   that isn't the Docker Desktop workflow, from `main` or a release tag, started by a push or by
   hand. It lives only on the PC, so no pull request can change it.
3. **A test machine only:** a standard Windows account, no personal accounts, email, password
   managers or saved sign-ins, and if you can, a guest network or VLAN apart from your other
   computers.

## 1. On GitHub, before anything else

**casazium/wirescry → Settings → Actions → General → Approval for running fork pull request
workflows from contributors:** choose **Require approval for all external contributors**, and
save.

## 2. Unpack and check

- [ ] The power adapter says **90 W** (HP pairs this 65 W processor with its 90 W adapter).
- [ ] Plug in **Ethernet**. Video is **DisplayPort** (two ports); an HDMI-only screen needs a
      DisplayPort-to-HDMI cable. Any USB keyboard and mouse will do for setup.
- [ ] Don't stand anything on the mesh top, and keep it off the floor (dust).

## 3. Windows

1. Go through setup with a **local account** for yourself as administrator (for example
   `admin`), with a password.
2. **Settings → System → About:** Intel Core i5-10500, 32 GB.
3. **Settings → System → Activation:** "Windows is activated". Save the firmware key, if there
   is one, in your password manager (PowerShell):

   ```powershell
   (Get-CimInstance SoftwareLicensingService).OA3xOriginalProductKey
   ```

   Photograph any Windows label on the case. Returns are possible for 90 days if anything here
   is wrong.

4. **Windows Update** until nothing is left, restarting as asked. Then set **Active hours** to
   cover when you test, so updates restart it outside them.
5. **Power:** **Settings → System → Power** (or **Power & battery**): sleep **Never** (the
   screen may turn off).
6. **Remote Desktop:** **Settings → System → Remote Desktop:** On. From the Mac, connect with
   Microsoft's free **Windows App**.
7. **Long paths**, in **Terminal (Admin)**:

   ```powershell
   New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
   ```

8. Create a second, **standard** (not administrator) local account for the runner, for example
   `runner`, with a password: **Settings → Accounts → Other users → Add account**. Steps 6 and 7
   happen in that account.

## 4. BIOS

Restart and press **F10** for HP Computer Setup. Menu names can differ slightly between BIOS
versions.

- [ ] **Advanced → System Options:** **Virtualization Technology (VTx)** on (and **VTd** if
      shown). Check it: HP often ships it off.
- [ ] **Advanced → Power-On Options → After Power Loss:** **Power On**, so it comes back after an
      outage.
- [ ] Save and exit (F10). Then **Task Manager → Performance → CPU** should say
      **Virtualization: Enabled**.

## 5. Tools: WSL, Docker Desktop, Git, PowerShell 7

Install everything here **before** the runner (step 7): the runner saves the PATH when it's
set up, and doesn't see tools installed later.

As the administrator, in **Terminal (Admin)**:

```powershell
wsl --install --no-distribution
winget install --id Git.Git -e
winget install --id Microsoft.PowerShell -e
git config --system core.longpaths true
```

Restart. Install **Docker Desktop** (the **AMD64** download from docker.com), keeping **Use WSL 2
instead of Hyper-V**. Then add the runner account to Docker's group (Terminal (Admin)), so it
can use Docker without being an administrator:

```powershell
Add-LocalGroupMember -Group docker-users -Member runner
```

**Windows Security → Virus & threat protection → Manage settings → Exclusions:** add the folders
`C:\actions-runner` and `C:\Users\runner\go` (antivirus scanning slows `npm ci` and the Go build
a lot). This turns off scanning there; that's acceptable on a test machine.

## 6. The runner account

Sign in as **runner** once, then:

1. Start **Docker Desktop**, accept its **Subscription Service Agreement** (you can skip signing
   in to Docker), and in **Settings → General**:
   - turn on **Start Docker Desktop when you sign in to your computer**,
   - turn off **Open Docker Dashboard when Docker Desktop starts**.

   Stay in **Linux containers** mode (the default). Check: `docker run --rm hello-world`.
   Docker Desktop is free for businesses with fewer than 250 employees and under $10 million in
   revenue.

2. Allow local scripts (in **Terminal**, as runner): `Set-ExecutionPolicy -Scope CurrentUser
RemoteSigned`.
3. **Sign in automatically as runner** after restarts and updates: run Microsoft's
   **Autologon** (Sysinternals, from learn.microsoft.com) as the administrator, for the runner
   account. Docker Desktop runs only inside a signed-in session, so the runner does too. Lock
   the screen (**Win+L**) whenever you leave it signed in.

## 7. The GitHub runner and its guard

As **runner**:

1. On GitHub: **casazium/wirescry → Settings → Actions → Runners → New self-hosted runner →
   Windows, x64**. Run the commands it shows in PowerShell, in `C:\actions-runner` (a short path
   avoids Windows path-length problems).
2. When `config.cmd` asks:
   - **Labels:** add `docker-desktop`.
   - **Run as a service?** **No.** A service runs outside the signed-in session, where Docker
     Desktop isn't.
3. **The guard:** copy [`docs/windows-runner-guard.ps1`](windows-runner-guard.ps1) from this
   repository to `C:\actions-runner\guard.ps1`, and add this line to `C:\actions-runner\.env`:

   ```
   ACTIONS_RUNNER_HOOK_JOB_STARTED=C:\actions-runner\guard.ps1
   ```

   Compare the copy with the repository's only when you update it on purpose: the point is that
   pull requests can't change it.

4. Start it at sign-in: press **Win+R**, open `shell:startup`, and put a shortcut to
   `C:\actions-runner\run.cmd` there. Restart once to check it all comes back by itself
   (Autologon signs in, Docker Desktop starts, the runner shows **Idle** on GitHub).

## 8. Turn the workflow on

Only once Docker setup works on Windows again (casazium/wirescry#90): the tests expect Wirescry
to set Docker up.

1. **Settings → Secrets and variables → Actions → Variables:** add `WINDOWS_TEST_PC` = `true`.
2. **Actions → Windows Docker Desktop → Run workflow** on `main`. The job log's "Set up runner"
   part should say **Windows test PC guard: … allowed.**, and the job should pass. The first run
   may show a Windows Firewall prompt for Node; **Cancel** is fine (tests use only this computer).
3. Check the guard refuses too: **Actions → CI → Run workflow** won't reach the PC (it doesn't
   ask for it), so instead, temporarily run the Docker Desktop workflow from a branch other
   than `main`: it should fail at once with **Refused by the Windows test PC's guard**.

To pause it, set the variable to `false` or stop the runner; jobs then wait or are skipped.

## Upkeep

- **Windows and Docker Desktop updates:** let them install; Autologon and the startup shortcut
  bring the runner back. If a job waits for a runner, check the PC is signed in and Docker
  Desktop is running. An update prompt in Docker Desktop can stop its engine mid-job; install
  Docker updates when no job is running.
- **Disk:** the workflow prunes after each run. Once in a while, `docker system prune -a` clears
  old images.
- **Noise:** the fan is quiet at idle and audible during long full-load runs. That's normal for
  this model.
