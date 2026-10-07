# Crossban Review

A Twitch moderation workspace for your browser or computer: import reports, inspect screenshots, verify
exact accounts, and explicitly choose which users to ban in a channel you moderate.
English and Dutch interface. Reports are information for human review, not an
automatic ban list.

[Nederlandse handleiding](README.nl.md)

## Choose your version

Open [Crossban Review](https://zeffuro.github.io/crossban-review/) to choose the
**browser app** or **Windows ZIP**. Both use the same account lookup, human review,
explicit batch confirmation and interrupted-action safeguards.

### Browser app

1. Open the browser app in a current desktop browser, choose English or Dutch
   and click **Connect Twitch**. No installation or application registration.
2. Paste reports or exact usernames, then attach screenshots to each report.
3. Look up the accounts, review each report and **Approve & select** only the
   intended accounts. Choose a channel you moderate and review the prepared bans.
4. Use **Download backup** to keep a private copy of reports, screenshots and
   history. **Restore backup** replaces reports and screenshots, preserves existing
   action history and requires a new lookup and review. Restored actions require
   checking Twitch before they can be treated as completed.

Reports and screenshots are stored in IndexedDB in this browser profile. Clearing
site data, using private browsing or switching profiles can remove them. Nothing
is uploaded to a shared report server. Twitch login tokens remain in page memory;
closing or refreshing the page requires signing in again. Only one tab can edit
this workspace at a time. A current browser with Web Locks and IndexedDB is required.

Optional advanced import: export DiscordChatExporter **JSON** with **Download
assets** enabled, then choose the entire export folder in the app. Expired URLs
or browser download restrictions appear in the coverage summary; downloaded
assets avoid that dependency. The app does not access your Discord account.

## Quick start


Browser workspaces accept up to 10,000 reports, 100,000 actions, 32 MB of report data
and 128 MB of screenshots. Oversized imports are rolled back without sending bans.

### Windows download

1. Download the release ZIP and choose **Extract all**. Run it from the extracted
   folder, not from inside the ZIP.
2. Double-click **Start.cmd** and select **English** or **Nederlands**. The browser
   opens in that language; the choice is remembered for the next launch.
3. If necessary, accept the offer to install **Node.js LTS** using Windows
   Package Manager (WinGet). Its installer may ask for administrator permission.
   If WinGet is unavailable, install Node.js from <https://nodejs.org/en/download>
   and run Start.cmd again.
4. The launcher can install **pnpm 11** in this app's private data folder and then
   installs the locked app dependencies. Internet access is needed for setup.
5. Click **Connect Twitch** in the browser and sign in with your personal account.
   Crossban Review includes its own public application ID; no app registration
   or credential copying is needed for normal use.
6. Keep the launcher window open while using the app. **Ctrl+C** stops it.

Existing `.env` settings are preserved. The launcher never asks for a user token
or client secret. You can change the display language in the browser at any time.
The PowerShell execution-policy option applies only to this launcher process;
it does not change the computer's stored execution policy.

### Manual installation (Windows, macOS or Linux)

Requires **Node.js 22.16+** and **pnpm 11**. Download or clone this repository.

```sh
pnpm install --frozen-lockfile
```

The bundled public application works without an `.env` file. Optionally copy
`.env.example` to `.env` to configure your own Twitch application as described
below. Leave `TWITCH_CLIENT_SECRET` empty for public device login.

```sh
pnpm start
```

Open <http://localhost:4387>. On Windows, `Start.cmd` provides the guided setup
above and opens the review screen. Keep its terminal running; Ctrl+C stops it.
You can import reports and screenshots before configuring or connecting Twitch.

## Do moderators need a token?

**No manual token generation or pasting.** Select **Connect Twitch**, open the
Twitch activation link, sign in with your **personal Twitch account**, and approve
the requested permissions. Keep this app open while authorizing in the other tab.
The login link opens a popup which closes when Twitch confirms authorization,
then attempts to focus this app. If popups are blocked or you open a regular tab,
Twitch may finish on its Connections page: return to the review tab without
refreshing it. It detects authorization automatically; no callback is needed for
this public device flow. Browser policies may prevent automatic focus.
The app obtains tokens automatically. The local version encrypts them on disk;
the browser version keeps them only until the page closes or reloads. You can only act in your own
channel or channels where that Twitch account is a moderator.

The **client ID identifies the application**; the **user token identifies the
moderator and their permissions**. No bot account or Discord token is needed.
Do not use another bot's application credentials or distribute its secret.

The included ID belongs to this app's dedicated Public registration. It does not
give other users access to the maintainer's account, tokens or channel permissions.
Each moderator signs in separately; credentials and reports stay on their machine.

Client IDs are public identifiers. Someone can reuse one to initiate a login flow
under the registered app's name; this is a potential impersonation/phishing risk.
Only approve codes generated by your own trusted copy of the app, and inspect the
permissions on Twitch. Client secrets and user tokens must remain private.

### Advanced: your own Twitch application

For an independent registration or a fork published as a different app:

1. Open the [Twitch developer console](https://dev.twitch.tv/console/apps).
2. Register a new application with a unique name and client type **Public**.
   Twitch application registration requires two-factor authentication.
3. If the registration form requires a redirect URL, use
   `http://localhost:4387/auth/twitch/callback`. Public device login itself does
   not use that callback.
4. Copy the **client ID** into `.env` and restart. Public applications require
   **no client secret**. Then connect your personal Twitch account in the app.

Use your own registration for a different application; Twitch warns against
sharing a client ID between separate applications. Users running this same app
can use its bundled ID.

Existing installations with their own **Confidential** app may keep both the ID
and secret in `.env`; the app then uses the browser callback login. Keep that
secret private and never bundle it with a download. Do not regenerate a secret
used by other software.

Requested permissions:

- `moderator:manage:banned_users`: explicitly confirmed bans and unbans.
- `user:read:moderated_channels`: list channels the signed-in account moderates.

A Discord moderator role does not grant Twitch permissions. Channel access and
account identity are checked again before sending a batch. Public refresh tokens
are single-use; after an uncertain refresh or failed validation the app requires
reconnection instead of replaying a potentially consumed token.

## Review workflow

1. Paste copied report text or open a `.txt` file. A list with one exact username
   per line also works. [Synthetic examples](examples/reports.txt) are included.
2. Use **Look up Twitch users** once to check the queue, or look up an individual
   account in its details. Check the exact username, especially underscores.
3. Open each report and inspect its reason, original text and screenshot evidence.
   Attach PNG/JPEG/WebP screenshots or paste an image while that report is open.
   Optionally save the original Discord message link.
4. Choose **Approve & select** for accounts you have reviewed, or skip the report.
   Space toggles a focused, enabled selection checkbox. Lookup alone does not
   approve or select anyone.
5. Choose the target channel and **Review selected bans**. Review the final list,
   confirm that you checked the evidence, and type the exact target channel and
   requested count. Every submitted ban is **permanent**, up to 100 per batch.
6. Read the recorded results. Unbanning is a separate confirmed action and is
   offered only for successful bans recorded by this tool.

Report fields work in English and Dutch, including mixed-language reports:

```text
Channel: example_channel
Username: exact_username
Reason: The reported reason to review
```

`Streamer`, `Name`, `Gebruikersnaam`, `Naam` and `Reden` are also supported.
Formatting is heuristic: compare the parsed values to the source. Your selected
interface language does not translate report text, usernames or screenshots.

**Unavailable on Twitch** means the exact lookup returned no account. It cannot
distinguish suspension, deletion, a rename or a typo. A suspension banner can
identify suspension at the time you check the page, but the supported user lookup
provides no fallback ID for an omitted account. Skip it or look it up again later.

## Advanced: DiscordChatExporter

Manual copying is the default workflow. For larger histories, an existing
[DiscordChatExporter](https://github.com/Tyrrrz/DiscordChatExporter) **JSON** export
can be imported through the advanced section. This app does not authenticate to
Discord or collect channel history. Review the exporter's own account-token and
Discord policy guidance before choosing how to create an export.

Put JSON files in `export/` beside `Start.cmd`. Keep downloaded asset folders in
their original relative locations. Prefer the exporter's **Download assets**
option because signed screenshot links can expire. The importer can also download
still-valid exported Discord CDN attachment links without credentials.

The coverage summary accounts for every attachment as loaded, failed or unassigned.
Replies retain their source association; adjacent messages are marked as
unverified context. Screenshots shared by a message naming several accounts need
human association. Reimporting unchanged records retains review decisions.
Changed text or new proof requires review again. Accounts removed from an
explicitly exported message are blocked; absent messages in a partial export are
not treated as deleted. Overlapping files use the newest `exportedAt` revision.

## Local data and deployment

This is a **single-account local app**, not a shared website. It binds to loopback
and checks hosts, origins and CSRF tokens. Do not expose this version through a
public proxy. A hosted version would need separate user sessions, credentials,
workspace access controls and deployment security before multiple moderators
could use it independently.

- `data/reviews.json`: reports, decisions, import coverage and action history.
- `data/evidence/`: screenshot evidence.
- `data/tokens.enc` and `data/token.key`: encrypted Twitch credentials and the
  local encryption key. Encryption does not protect against access to both files.
- `export/`: private source exports. `.env`: local application configuration.

Back up `data/` while stopped. Keep these private folders out of Git and shared
downloads; `.gitignore` excludes them. Report text and screenshots are not sent to
an AI service. Twitch receives lookups and the selected moderation requests.
Disconnect removes local credentials. Revoke the application's grant in Twitch
Connections to revoke access at Twitch too.

## Failed or interrupted actions

Actions are durably recorded before their request, paced and stopped on the first
failure or uncertain result. Uncertain moderation requests are never replayed
automatically. Check the actual Twitch state before recording the outcome in
history. Unattempted accounts need a fresh preview.

When signed in as the broadcaster, existing permanent bans are checked before
preview. When moderating another channel, existing bans are identified by Twitch's
response during execution. Those bans are recorded separately and cannot be
undone through this tool. Local history does not discover another moderator's
later unbans; review current Twitch state before undoing an old action.

## Development and sharing

```sh
pnpm typecheck
pnpm test
node --check public/app.js
node --check public/i18n.js
node --check public/device-login.js
```

Tests use synthetic reports, temporary data and mocked providers. They do not send
live moderation requests. GitHub Actions runs checks on Linux and Windows.

Share the source repository or a clean source package, not your working folder.
On Windows, run `powershell -NoProfile -File scripts/Package-Source.ps1` after
staging the public source files in Git. It creates a new ZIP under `release/`
from the Git source manifest, including dotfiles and the Windows launcher.
It rejects private `.env`, data and export paths. Extract the ZIP and follow
Quick start. No repository is published automatically.

MIT licensed; see [LICENSE](LICENSE).

References: [Twitch public/device login](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow),
[Register a Twitch app](https://dev.twitch.tv/docs/authentication/register-app/),
[Ban User](https://dev.twitch.tv/docs/api/reference/#ban-user),
[Discord self-bot guidance](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots).
