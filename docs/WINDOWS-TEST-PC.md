# The Windows test PC

A small x64 Windows PC (an HP EliteDesk 800 G6 Mini: Intel Core i5-10500, 32 GB, Windows 11 Pro)
that tests Wirescry the way Windows users run it, with Docker Desktop and Linux containers.
GitHub's own Windows runners can't: they have Docker Engine with Windows containers only.

It does two jobs:

- **Hands-on checks** before a release, over Remote Desktop from the Mac.
- **A GitHub Actions runner** for [`.github/workflows/windows-docker-desktop.yml`](../.github/workflows/windows-docker-desktop.yml),
  which runs `test/docker-e2e.test.ts` against Docker Desktop on pushes to `main`, release tags
  and manual runs.

Keep it a test machine: no personal accounts, email, password managers or saved sign-ins.
Code from this repository runs on it.

## 1. Unpack and check

- [ ] The power adapter says **90 W**. The i5-10500 draws up to about 90 W; a 65 W adapter
      would hold it back or let it shut down under load.
- [ ] Plug in **Ethernet**. Video is **DisplayPort** (two ports); an HDMI-only screen needs a
      DisplayPort-to-HDMI cable. Any USB keyboard and mouse will do for setup.
- [ ] Don't stand anything on the mesh top, and keep it off the floor (dust).

## 2. Windows

1. Go through setup with a **local account** used only for this PC (for example `wirescry`),
   with a password.
2. **Settings → System → About:** Intel Core i5-10500, 32 GB.
3. **Settings → System → Activation:** "Windows is activated". Save the firmware key, if there
   is one, in your password manager (PowerShell):

   ```powershell
   (Get-CimInstance SoftwareLicensingService).OA3xOriginalProductKey
   ```

   Photograph any Windows label on the case. Returns are possible for 90 days if anything here
   is wrong.

4. **Windows Update** until nothing is left, restarting as asked.
5. **Settings → System → Power:** Sleep **Never** (the screen may turn off).
6. **Settings → System → Remote Desktop:** On. From the Mac, connect with Microsoft's free
   **Windows App** using the PC's name or address and the local account.

## 3. BIOS

Restart and press **F10** for HP Computer Setup. Menu names can differ slightly between BIOS
versions.

- [ ] **Advanced → System Options:** turn on **Virtualization Technology (VTx)** (and VT-d if
      shown). It is off by default on this model.
- [ ] **Advanced → Power-On Options → After Power Loss:** **Power On**, so it comes back after an
      outage.
- [ ] Save and exit (F10). Then **Task Manager → Performance → CPU** should say
      **Virtualization: Enabled**.

## 4. WSL, Docker Desktop and Git

In **Terminal (Admin)**:

```powershell
wsl --install --no-distribution
```

Restart, then install **Docker Desktop** (the **AMD64** download from docker.com):

- Keep **Use WSL 2 instead of Hyper-V**.
- **Settings → General:** turn on **Start Docker Desktop when you sign in to your computer**.
- Stay in **Linux containers** mode (the default).
- Check: `docker run --rm hello-world`.

Docker Desktop is free for businesses with fewer than 250 employees and under $10 million in
revenue.

Install Git and allow long paths (Terminal (Admin)):

```powershell
winget install --id Git.Git -e
git config --system core.longpaths true
```

## 5. Sign in automatically

Docker Desktop runs only inside a signed-in session, so the runner does too. To have the PC sign
in by itself after restarts and Windows updates, use Microsoft's **Autologon** (Sysinternals,
from learn.microsoft.com): enter the local account's password once; it is stored encrypted.

## 6. The GitHub runner

1. On GitHub: **casazium/wirescry → Settings → Actions → Runners → New self-hosted runner →
   Windows, x64**. Run the commands it shows in PowerShell, in `C:\actions-runner` (a short path
   avoids Windows path-length problems).
2. When `config.cmd` asks:
   - **Labels:** add `docker-desktop`.
   - **Run as a service?** **No.** A service runs outside the signed-in session, where Docker
     Desktop isn't.
3. Start it at sign-in: press **Win+R**, open `shell:startup`, and put a shortcut to
   `C:\actions-runner\run.cmd` there. Restart once to check it comes back by itself
   (Autologon signs in, Docker Desktop starts, the runner shows **Idle** on GitHub).

## 7. Turn the workflow on

Only once Docker setup works on Windows again (casazium/wirescry#90): the tests expect Wirescry
to set Docker up.

1. **Settings → Actions → General → Approval for running fork pull request workflows from
   contributors:** **Require approval for all external contributors**. This workflow never runs
   for pull requests, but the setting keeps any future change to that from running a stranger's
   code here.
2. **Settings → Secrets and variables → Actions → Variables:** add `WINDOWS_TEST_PC` = `true`.
3. **Actions → Windows Docker Desktop → Run workflow** on `main`, and check it passes.

To pause it, set the variable to `false` or stop the runner; jobs then wait or are skipped.

## Upkeep

- **Windows and Docker Desktop updates:** let them install; Autologon and the startup shortcut
  bring the runner back. If a job waits for a runner, check the PC is signed in and Docker
  Desktop is running.
- **Disk:** the workflow prunes after each run. Once in a while, `docker system prune -a` clears
  old images.
- **Noise:** the fan is quiet at idle and audible during long full-load runs. That's normal for
  this model.
