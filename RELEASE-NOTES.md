Crossban Review v0.2.0 improves screenshot review and daily imports.

- Reimporting an unchanged Discord channel preserves manually corrected usernames and skipped/approved decisions, including screenshot-only reports. Existing ban history stays intact.
- Select screenshots and move them into a separate report with its own exact account and reason. Later imports remember the split. Source changes require review again.
- Click images to zoom, pan and compare them inside the app.
- Optional free OCR runs in your browser, with sender/mention hints, copying and draft usernames. The engine downloads only when used; no heavy OCR binaries are bundled. Suggestions require manual verification and never trigger moderation actions.
- English and Dutch controls and instructions.

To update a Windows copy, stop it with Ctrl+C, extract the new ZIP over the existing app files and run Start.cmd again. Keep your existing `data/` folder and `.env` file.

Crossban Review is available in your browser and as a local Windows download, in English and Dutch.

- [Choose browser or Windows](https://zeffuro.github.io/crossban-review/).
- For Windows, download **crossban-review-windows.zip**, extract it and double-click **Start.cmd**. The launcher helps set up Node.js and pnpm.
- Connect your own Twitch account; no application registration or manual token is needed.
- Paste reports or usernames, attach screenshots and review exact Twitch accounts before selecting any bans.
- DiscordChatExporter JSON with downloaded assets is an optional advanced import.

The browser app keeps reports and screenshots in your browser and asks for a fresh Twitch login when you open it. Download workspace backups before clearing browser data. The Windows app saves its workspace in the local `data/` folder. Neither version uploads report evidence to a shared server.

Uncertain or interrupted moderation actions stop the batch and require checking Twitch before continuing. No real bans were sent during release validation.
