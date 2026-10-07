# Crossban Review

Een werkplek voor Twitch-moderatie in je browser of op je computer: importeer meldingen, bekijk screenshots,
controleer de exacte accounts en selecteer zelf wie je wilt bannen in een kanaal
waar je moderator bent. De interface is beschikbaar in het Nederlands en Engels.
Een melding is informatie om te beoordelen, geen automatische banopdracht.

[English guide](README.md)

## Kies je versie

Open [Crossban Review](https://zeffuro.github.io/crossban-review/) en kies de
**browserapp** of **Windows-ZIP**. Beide gebruiken dezelfde accountcontrole,
menselijke beoordeling, expliciete batchbevestiging en beveiliging bij onderbroken acties.

### Browserapp

1. Open de browserapp in een recente desktopbrowser, kies Nederlands of Engels
   en klik **Twitch verbinden**. Je hoeft niets te installeren of registreren.
2. Plak meldingen of exacte gebruikersnamen en voeg screenshots per melding toe.
3. Zoek de accounts op, beoordeel elke melding en kies **Goedkeuren en selecteren**
   voor de bedoelde accounts. Kies een kanaal waar je moderator bent en controleer de bans.
4. Kies **Back-up downloaden** voor een privékopie van meldingen, screenshots en
   geschiedenis. **Back-up herstellen** vervangt meldingen en screenshots, behoudt
   bestaande actiegeschiedenis en vereist opnieuw opzoeken en beoordelen. Controleer
   herstelde acties op Twitch voordat je ze als voltooid registreert.

Meldingen en screenshots worden met IndexedDB in dit browserprofiel opgeslagen.
Sitegegevens wissen, privémodus of een ander profiel kan ze verwijderen. Ze worden
niet naar een gedeelde server geüpload. Twitch-tokens blijven alleen in het geheugen
van de pagina; na sluiten of vernieuwen log je opnieuw in. Eén tabblad tegelijk kan
wijzigingen maken. Gebruik een recente browser met Web Locks en IndexedDB.

Optioneel geavanceerd importeren: exporteer DiscordChatExporter **JSON** met
**Download assets** ingeschakeld en kies in de app de volledige exportmap.
Verlopen links of browserbeperkingen verschijnen in het importoverzicht;
gedownloade bijlagen voorkomen deze afhankelijkheid. De app benadert je Discord-account niet.

## Installeren


Browserwerkplekken ondersteunen maximaal 10.000 meldingen, 100.000 acties, 32 MB
aan meldingsgegevens en 128 MB aan screenshots. Te grote imports worden teruggedraaid
zonder bans te versturen.

### Windows-download

1. Download het ZIP-bestand van de release en kies **Alles uitpakken**. Start de
   app vanuit de uitgepakte map, niet vanuit het ZIP-bestand.
2. Dubbelklik op **Start.cmd** en kies **English** of **Nederlands**. De browser
   opent in die taal; de launcher onthoudt je keuze voor de volgende keer.
3. Accepteer zo nodig de installatie van **Node.js LTS** via Windows Package
   Manager (WinGet). Het installatieprogramma kan beheerdersrechten vragen.
   Ontbreekt WinGet, installeer Node.js via <https://nodejs.org/en/download>
   en start Start.cmd opnieuw.
4. De launcher kan **pnpm 11** in de privégegevensmap van deze app installeren
   en installeert daarna de vastgelegde afhankelijkheden. Hiervoor is internet nodig.
5. Klik in de browser op **Twitch verbinden** en log in met je persoonlijke account.
   Crossban Review bevat zijn eigen openbare applicatie-ID; voor normaal gebruik
   hoef je geen applicatie te registreren of inloggegevens te kopiëren.
6. Houd het launchervenster open tijdens het gebruik. **Ctrl+C** stopt de app.

Bestaande `.env`-instellingen blijven behouden. De launcher vraagt niet om een
gebruikerstoken of clientgeheim. Je kunt de taal later bovenaan in de browser wijzigen.
De PowerShell-optie voor het uitvoeringsbeleid geldt alleen voor dit launcherproces;
het opgeslagen uitvoeringsbeleid van Windows wordt niet gewijzigd.

### Handmatig installeren (Windows, macOS of Linux)

Je hebt **Node.js 22.16+** en **pnpm 11** nodig. Download of clone deze repository.

```sh
pnpm install --frozen-lockfile
```

De meegeleverde openbare applicatie werkt zonder `.env`-bestand. Kopieer eventueel
`.env.example` naar `.env` om een eigen Twitch-applicatie te configureren (zie hieronder).
Laat `TWITCH_CLIENT_SECRET` leeg voor de aanbevolen inlogmethode.

```sh
pnpm start
```

Open <http://localhost:4387>. Op Windows kun je `Start.cmd` starten; die installeert
zo nodig afhankelijkheden en opent het scherm. Houd het terminalvenster open.
Ctrl+C stopt de app. Meldingen en screenshots importeren kan ook zonder Twitch.
Kies **Nederlands** bovenaan; de app onthoudt je taalkeuze op deze computer.

## Hebben moderators een token nodig?

**Je hoeft geen token aan te maken of te plakken.** Klik op **Twitch verbinden**,
open de inloglink, log in met je **persoonlijke Twitch-account** en geef de app
toestemming. Houd het beoordelingsscherm open terwijl je in het andere tabblad
inlogt. De app ontvangt de tokens zelf. De lokale versie bewaart ze versleuteld; de
browserapp houdt ze alleen in het geheugen tot je de pagina sluit of vernieuwt.
Je kunt alleen handelen in je eigen kanaal of waar jouw Twitch-account moderator is.

De **client-ID hoort bij de software**, het **gebruikerstoken bij de moderator en
diens rechten**. Je hebt geen botaccount of Discord-token nodig. Gebruik niet de
applicatiegegevens van een andere bot en deel nooit een clientgeheim.

De meegeleverde ID hoort bij de aparte Public-registratie van deze app. Hiermee
krijgen andere gebruikers geen toegang tot het account, de tokens of de
kanaalrechten van de beheerder. Iedereen logt zelf in; tokens en meldingen blijven
op de eigen computer.

Client-ID's zijn openbare identificatoren. Iemand kan dezelfde ID gebruiken om
een inlogproces onder de geregistreerde appnaam te starten; dat kan worden misbruikt
voor phishing. Keur alleen codes goed die je eigen vertrouwde versie van de app
genereert en controleer de gevraagde rechten op Twitch. Houd clientgeheimen en
gebruikerstokens privé.

### Geavanceerd: een eigen Twitch-applicatie

Voor een eigen registratie of een fork die je als een andere app publiceert:

1. Open de [Twitch-ontwikkelaarsconsole](https://dev.twitch.tv/console/apps).
2. Registreer een aparte applicatie met een unieke naam en clienttype **Public**.
   Twitch vereist tweestapsverificatie voor applicatieregistratie.
3. Als het formulier een redirect-URL vereist, vul dan
   `http://localhost:4387/auth/twitch/callback` in. De openbare inlogmethode
   gebruikt deze callback niet.
4. Kopieer de client-ID naar `.env` en start opnieuw. Een openbare applicatie
   heeft **geen clientgeheim** nodig. Verbind daarna je persoonlijke Twitch-account.

Gebruik voor een andere applicatie een eigen registratie; Twitch waarschuwt tegen
het delen van één client-ID tussen verschillende applicaties. Gebruikers van deze
app kunnen de meegeleverde ID gebruiken.

Een bestaande installatie met een eigen **Confidential**-applicatie mag client-ID
en clientgeheim behouden; de app gebruikt dan de browsercallback. Neem het geheim
nooit op in een gedeelde download en wijzig geen geheim dat andere software gebruikt.

De app vraagt om `moderator:manage:banned_users` voor expliciet bevestigde bans en
unbans, en `user:read:moderated_channels` om je gemodereerde kanalen te tonen.
Een Discord-moderatorrol geeft geen Twitch-rechten. Identiteit en kanaaltoegang
worden vlak voor uitvoering opnieuw gecontroleerd. Openbare refresh-tokens zijn
maar eenmaal bruikbaar. Bij een onzekere vernieuwing moet je opnieuw verbinden;
de app herhaalt geen mogelijk verbruikt token.

## Meldingen beoordelen

1. Plak gekopieerde meldingen, open een `.txt`-bestand of gebruik één exacte
   gebruikersnaam per regel. `examples/reports.txt` bevat uitsluitend fictieve voorbeelden.
2. Gebruik **Twitch-gebruikers opzoeken** voor de hele wachtrij, of zoek een account
   op vanuit de details. Controleer de exacte naam, vooral het aantal underscores.
3. Open elke melding en bekijk de reden, oorspronkelijke tekst en bewijsstukken.
   Voeg PNG/JPEG/WebP-screenshots toe of plak een afbeelding terwijl de melding
   openstaat. Je kunt ook de oorspronkelijke Discord-berichtlink opslaan.
4. Kies **Goedkeuren en selecteren** als je de melding hebt beoordeeld, of sla
   haar over. Spatie schakelt een ingeschakeld selectievakje met focus om.
   Alleen een account opzoeken keurt niets goed en selecteert niemand.
5. Kies het doelkanaal en controleer de geselecteerde bans. Bevestig dat je het
   bewijs hebt bekeken en typ de exacte kanaalnaam en het gevraagde aantal.
   Bans zijn **permanent**, maximaal 100 accounts per batch.
6. Bekijk de geregistreerde resultaten. Een unban is een afzonderlijke bevestigde
   handeling, alleen voor geslaagde bans die deze app heeft vastgelegd.

Engelse en Nederlandse velden werken ook door elkaar:

```text
Streamer: example_channel
Gebruikersnaam: exact_username
Reden: De gemelde reden die je wilt beoordelen
```

Ook `Channel`, `Username`, `Name` en `Naam` worden herkend. Controleer altijd de
geparseerde waarden. De interfacetaal verandert meldingen, namen of screenshots niet.
**Niet beschikbaar op Twitch** betekent dat de exacte zoekopdracht geen account
opleverde. Dat kan geen schorsing, verwijdering, naamswijziging of typefout van
elkaar onderscheiden. Een schorsingsmelding op de kanaalpagina kan de schorsing
op dat moment aangeven. Een ontbrekend account blijft geblokkeerd voor selectie.

## Geavanceerd: DiscordChatExporter

Handmatig kopiëren is de standaard. Voor grotere hoeveelheden kun je een bestaand
[DiscordChatExporter](https://github.com/Tyrrrz/DiscordChatExporter)-exportbestand
in **JSON** gebruiken via de geavanceerde sectie. Deze app logt niet in op Discord
en haalt geen kanaalgeschiedenis op. Lees de eigen waarschuwingen van de exporter
over accounttokens en Discord-beleid voordat je kiest hoe je een export maakt.

Zet de JSON-bestanden in `export/` naast `Start.cmd`. Laat gedownloade bijlagen op
hun oorspronkelijke relatieve locatie staan. Kies bij voorkeur **Download assets**
in de exporter: ondertekende afbeeldingslinks kunnen verlopen. Nog geldige
Discord-CDN-links uit een export kunnen zonder inloggegevens worden gedownload.

De importresultaten tonen elke bijlage als geladen, mislukt of niet gekoppeld.
Reacties blijven bij hun bron; aangrenzende berichten zijn onbevestigde context.
Bij gedeelde screenshots moet je zelf beoordelen welk account door welk bewijs
wordt ondersteund. Identieke imports behouden besluiten. Nieuwe tekst of bewijs
vraagt om herbeoordeling. Accounts die uit een expliciet geëxporteerd bericht
verdwijnen worden geblokkeerd. Ontbrekende berichten in een gedeeltelijke export
worden niet als verwijderd behandeld. Bij overlap geldt de nieuwste `exportedAt`.

## Gegevens en hosting

Deze versie is een **lokale app voor één account**, geen gedeelde website.
De server luistert alleen lokaal en controleert host, oorsprong en CSRF-token.
Maak haar niet openbaar via een proxy. Een gedeelde website vereist afzonderlijke
sessies, tokens, toegang tot werkplekken en beveiliging voor meerdere gebruikers.

`data/reviews.json` bevat meldingen, besluiten, importresultaten en geschiedenis;
`data/evidence/` bevat screenshots. Tokens staan versleuteld in `data/tokens.enc`,
met de sleutel in `data/token.key`. Wie beide kan lezen, kan de versleuteling
opheffen. Houd `data/`, `export/` en `.env` privé en buiten Git of downloads.
Maak een back-up van `data/` terwijl de app gestopt is. Gegevens gaan niet naar
AI-diensten. Twitch ontvangt zoekopdrachten en je geselecteerde moderatieaanvragen.
Verbinding verbreken verwijdert lokale tokens; trek de toestemming op Twitch in
via je accountverbindingen als je ook de Twitch-toegang wilt intrekken.

Acties worden vóór verzending vastgelegd. De batch stopt bij de eerste fout of
onzekerheid en herhaalt een onzekere aanvraag niet. Controleer Twitch voordat je
het resultaat in de geschiedenis bevestigt. Andere moderators kunnen buiten deze
app bans aanpassen; de lokale geschiedenis ontdekt die wijzigingen niet vanzelf.

## Ontwikkeling en delen

```sh
pnpm typecheck
pnpm test
node --check public/app.js
node --check public/i18n.js
node --check public/device-login.js
```

Tests gebruiken fictieve meldingen en nagebootste Twitch-antwoorden, zonder echte
moderatieaanvragen. GitHub Actions controleert Linux en Windows.
Deel de repository of een schoon bronpakket, niet je werkmap. Voer op Windows
`powershell -NoProfile -File scripts/Package-Source.ps1` uit nadat de openbare
bronbestanden in Git zijn gestaged. Dit maakt een nieuw ZIP-bestand in `release/`
op basis van de Git-bestandenlijst, inclusief dotfiles en de Windows-launcher.
Privépaden voor `.env`, gegevens en exports worden geweigerd. Pak het ZIP-bestand uit en volg
de installatiestappen. De app publiceert niet automatisch naar GitHub.

MIT-licentie: zie [LICENSE](LICENSE). De Engelse handleiding bevat API-referenties.
