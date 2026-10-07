Crossban Review v0.1.1 fixes Windows startup and makes Twitch login easier.

- The Windows launcher uses the registered default browser handler to open the app.
- Manually opening localhost also applies the launcher's selected language. Changing the language in the app now survives refreshing.
- Twitch login opens a popup that closes after authorization and attempts to bring the review screen back into focus. Blocked popups retain the ordinary tab link, with clearer return instructions in English and Dutch.

To update a Windows copy, stop it with Ctrl+C, extract the new ZIP over the existing app files and run Start.cmd again. Keep your existing `data/` folder and `.env` file.

Crossban Review is available in your browser and as a local Windows download, in English and Dutch.

- [Choose browser or Windows](https://zeffuro.github.io/crossban-review/).
- For Windows, download **crossban-review-windows.zip**, extract it and double-click **Start.cmd**. The launcher helps set up Node.js and pnpm.
- Connect your own Twitch account; no application registration or manual token is needed.
- Paste reports or usernames, attach screenshots and review exact Twitch accounts before selecting any bans.
- DiscordChatExporter JSON with downloaded assets is an optional advanced import.

The browser app keeps reports and screenshots in your browser and asks for a fresh Twitch login when you open it. Download workspace backups before clearing browser data. The Windows app saves its workspace in the local `data/` folder. Neither version uploads report evidence to a shared server.

Uncertain or interrupted moderation actions stop the batch and require checking Twitch before continuing. No real bans were sent during release validation.
