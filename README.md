# DEX POC — Distributed Execution

Proves: a command dispatched centrally (shell + Supabase) executes on a specific
**device's own browser session** on an API-less site (Dotgolf) and returns live —
**with no server-side browser**. Read-only. See `../poc-distributed-execution.md`.

Two files:
- **`index.html`** — the shell (control surface): sign in, see devices, dispatch commands, watch results live.
- **`de-runner.user.js`** — the thin runner (the "hands"): installed via Tampermonkey on each device.

Supabase: project `Photo-capture` (Sydney), tables `de_devices` + `de_commands`. Details in `../supabase-setup.md`.

---

## One-time setup

**1. Turn off email confirmation (POC only).**
Supabase dashboard → Authentication → Sign In / Providers → Email → disable **Confirm email**.
This lets "Sign in / up" create your account instantly on first use. (Otherwise sign-up waits on a confirmation email.)

**2. Deploy the shell + runner to Netlify (via GitHub).**
Push the `dex-poc/` folder to a repo and connect it to a new Netlify site (publish directory = `dex-poc`). You get:
- Shell at `https://<your-site>.netlify.app/`
- Runner at `https://<your-site>.netlify.app/de-runner.user.js`

**3. Point the runner's auto-update at your site.**
In `de-runner.user.js`, set `@updateURL` and `@downloadURL` to your real Netlify URL (currently the placeholder `https://dex-poc.netlify.app/...`).

**4. Install the runner on each device.**
- iPhone: Safari + Tampermonkey → open `…/de-runner.user.js` → Install.
- Android: Firefox + Tampermonkey → open `…/de-runner.user.js` → Install.

---

## Test run

1. Open the **shell** on your laptop/phone, sign in (same email+password you'll use on the runner).
2. On **device A**, open the Dotgolf tee-booking page (logged in). The blue **DEX Runner** panel appears — sign in with the same account. It registers and shows "Listening for commands…".
3. Back in the shell, device A shows **online**. Dispatch `ping` to it → result returns live. ✅ **Test 1 (single-device loop).**
4. Repeat on **device B**; dispatch to **All devices** → two independent results. ✅ **Test 2 (sharding).**
5. Open a day's tee sheet on a device, dispatch `readAvailability` → parsed slots return. (Optional `from`/`to` filter.)
6. Close the page on a device, dispatch a command to it (stays **queued**), reopen → it runs on reconnect. ✅ **Test 3 (offline queue).**

---

## Notes / known edges

- Runner runs supabase-js in page context (`@grant none`). If a global ever clashes on the Dotgolf page, switch to a grant + `unsafeWindow`.
- `readAvailability` reads the **currently open** tee sheet (no navigation yet). Date-driven navigation needs cross-reload command state (like the grabber's sessionStorage) — a later enhancement.
- Presence: a device shows "online" if it heartbeated within ~60s.
- This is read-only by design. No writes/bookings. The time-critical grab stays local (the grabber's job), not a dispatched command.
