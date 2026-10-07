$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$language = 'en'
$messages = @{
    en = @{
        Title = 'Crossban Review - local setup'
        Language = 'Choose your language: 1 = English, 2 = Nederlands'
        Choose = 'Language / Taal [{0}]'
        InvalidLanguage = 'Enter 1 (English) or 2 (Nederlands).'
        NodeMissing = 'Node.js 22.16 or newer is required. Your current Node.js was not found or is too old.'
        NodeConsent = 'Install Node.js LTS with Windows Package Manager? Windows may ask for installer permission [y/N]'
        NodeTerms = 'The installer will show any required agreements. Read and accept them yourself to continue.'
        NodeManual = 'Download the Windows LTS installer from https://nodejs.org/en/download, install it with npm, then double-click Start.cmd again.'
        NodeStopped = 'Node.js is still unavailable or too old. Existing installations were not forcibly upgraded or removed.'
        PnpmMissing = 'This app requires pnpm 11. A compatible copy was not found.'
        PnpmConsent = 'Download pnpm 11 into this app folder using npm? Your global pnpm will stay unchanged [y/N]'
        PnpmFailed = 'pnpm could not be installed. Check your internet connection and try Start.cmd again.'
        NpmMissing = 'npm is missing. Install Node.js LTS with npm from https://nodejs.org/en/download and start again.'
        Declined = 'Setup stopped. You can run Start.cmd again whenever you are ready.'
        ClientIntro = 'Optional Twitch setup: see README.md or https://dev.twitch.tv/console/apps to register a Public application (requires two-factor authentication). Paste its client ID below. This is an application ID, not a token or client secret. Press Enter to skip and import reports first.'
        ClientPrompt = 'Public Twitch client ID (optional)'
        ClientInvalid = 'Use an alphanumeric client ID (10-100 characters), or press Enter to skip.'
        ClientSaved = 'Application ID saved locally. Connect your personal Twitch account in the browser.'
        Install = 'Checking and installing the locked app dependencies...'
        InstallFailed = 'App dependencies could not be installed. Check your internet connection and try again.'
        Start = 'Opening Crossban Review. Keep this window open while using the app. Ctrl+C stops the server.'
        ServerFailed = 'The app stopped with an error. The output above may explain what went wrong.'
        Error = 'Could not start Crossban Review: {0}'
        Close = 'Press Enter to close this window'
    }
    nl = @{
        Title = 'Crossban Review - lokale installatie'
        Language = 'Choose your language: 1 = English, 2 = Nederlands'
        Choose = 'Language / Taal [{0}]'
        InvalidLanguage = 'Voer 1 (English) of 2 (Nederlands) in.'
        NodeMissing = 'Node.js 22.16 of nieuwer is vereist. Je huidige Node.js is niet gevonden of is te oud.'
        NodeConsent = 'Node.js LTS installeren met Windows Package Manager? Windows kan om toestemming voor de installatie vragen [j/N]'
        NodeTerms = 'Het installatieprogramma toont eventuele voorwaarden. Lees en accepteer ze zelf om verder te gaan.'
        NodeManual = 'Download het Windows LTS-installatieprogramma van https://nodejs.org/en/download, installeer het met npm en dubbelklik daarna opnieuw op Start.cmd.'
        NodeStopped = 'Node.js is nog niet beschikbaar of is te oud. Bestaande installaties zijn niet geforceerd bijgewerkt of verwijderd.'
        PnpmMissing = 'Deze app vereist pnpm 11. Er is geen geschikte versie gevonden.'
        PnpmConsent = 'pnpm 11 met npm downloaden in deze appmap? Je globale pnpm blijft ongewijzigd [j/N]'
        PnpmFailed = 'pnpm kon niet worden geinstalleerd. Controleer je internetverbinding en probeer Start.cmd opnieuw.'
        NpmMissing = 'npm ontbreekt. Installeer Node.js LTS met npm via https://nodejs.org/en/download en start opnieuw.'
        Declined = 'De installatie is gestopt. Je kunt Start.cmd opnieuw starten wanneer je klaar bent.'
        ClientIntro = 'Optionele Twitch-instelling: zie README.nl.md of https://dev.twitch.tv/console/apps om een Public-applicatie te registreren (tweestapsverificatie vereist). Plak hieronder de client-ID. Dit is een applicatie-ID, geen token of client secret. Druk op Enter om over te slaan en eerst rapporten te importeren.'
        ClientPrompt = 'Public Twitch client-ID (optioneel)'
        ClientInvalid = 'Gebruik een alfanumerieke client-ID (10-100 tekens) of druk op Enter om over te slaan.'
        ClientSaved = 'De applicatie-ID is lokaal opgeslagen. Verbind je persoonlijke Twitch-account in de browser.'
        Install = 'De vastgelegde app-afhankelijkheden worden gecontroleerd en geinstalleerd...'
        InstallFailed = 'De app-afhankelijkheden konden niet worden geinstalleerd. Controleer je internetverbinding en probeer opnieuw.'
        Start = 'Crossban Review wordt geopend. Houd dit venster open tijdens het gebruik. Ctrl+C stopt de server.'
        ServerFailed = 'De app is gestopt met een fout. De uitvoer hierboven kan de oorzaak aangeven.'
        Error = 'Crossban Review kon niet starten: {0}'
        Close = 'Druk op Enter om dit venster te sluiten'
    }
}

function Message([string] $key) { return $messages[$language][$key] }

function Ask([string] $prompt) {
    Write-Host $prompt
    return Read-Host
}

function Confirm([string] $key) {
    $answer = Ask (Message $key)
    return $answer.Trim().ToLowerInvariant() -in @('y', 'yes', 'j', 'ja')
}

function Find-Application([string] $name) {
    $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}

function Read-Version([string] $command) {
    if (-not $command) { return $null }
    try {
        $output = @(& $command --version 2>$null)
        if ($LASTEXITCODE -eq 0 -and $output.Count -eq 1 -and "$($output[0])" -match '^v?(\d+)\.(\d+)\.(\d+)$') {
            return [version] ('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3])
        }
    } catch { }
    return $null
}

function Refresh-Path {
    $paths = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), $env:Path)
    $env:Path = ($paths | Where-Object { $_ }) -join ';'
}

function Ensure-Node {
    $node = Find-Application 'node'
    $version = Read-Version $node
    if ($version -and $version -ge [version]'22.16.0') { return }
    Write-Host (Message 'NodeMissing')
    $winget = Find-Application 'winget'
    if (-not $winget) { throw (Message 'NodeManual') }
    if (-not (Confirm 'NodeConsent')) { throw (Message 'Declined') }
    Write-Host (Message 'NodeTerms')
    & $winget install --id OpenJS.NodeJS.LTS --exact --source winget
    if ($LASTEXITCODE -ne 0) { throw (Message 'NodeManual') }
    Refresh-Path
    $version = Read-Version (Find-Application 'node')
    if (-not $version -or $version -lt [version]'22.16.0') {
        throw ((Message 'NodeStopped') + ' ' + (Message 'NodeManual'))
    }
}

function Ensure-Pnpm {
    $tools = Join-Path $root 'data\launcher-tools'
    $localPnpm = Join-Path $tools 'node_modules\.bin\pnpm.cmd'
    foreach ($candidate in @($localPnpm, (Find-Application 'pnpm.cmd'))) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            $version = Read-Version $candidate
            if ($version -and $version.Major -eq 11) { return $candidate }
        }
    }
    Write-Host (Message 'PnpmMissing')
    if (-not (Confirm 'PnpmConsent')) { throw (Message 'Declined') }
    $npm = Find-Application 'npm.cmd'
    if (-not $npm) { throw (Message 'NpmMissing') }
    New-Item -ItemType Directory -Path $tools -Force | Out-Null
    & $npm install --prefix $tools --no-audit --no-fund --no-package-lock pnpm@11 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw (Message 'PnpmFailed') }
    $version = Read-Version $localPnpm
    if (-not $version -or $version.Major -ne 11) { throw (Message 'PnpmFailed') }
    return $localPnpm
}

function Configure-Client {
    $destination = Join-Path $root '.env'
    if (Test-Path -LiteralPath $destination) { return }
    Write-Host (Message 'ClientIntro')
    while ($true) {
        $clientId = (Ask (Message 'ClientPrompt')).Trim()
        if (-not $clientId) { return }
        if ($clientId -match '^[a-zA-Z0-9]{10,100}$') { break }
        Write-Host (Message 'ClientInvalid')
    }
    $template = [IO.File]::ReadAllText((Join-Path $root '.env.example'))
    $content = [regex]::Replace($template, '(?m)^TWITCH_CLIENT_ID=.*$', ('TWITCH_CLIENT_ID=' + $clientId))
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($content)
    $file = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try { $file.Write($bytes, 0, $bytes.Length) } finally { $file.Dispose() }
    Write-Host (Message 'ClientSaved')
}

$exitCode = 0
try {
    Write-Host (Message 'Language')
    $languageFile = Join-Path $root 'data\launcher-language.txt'
    $default = '1'
    if (Test-Path -LiteralPath $languageFile) {
        $saved = [IO.File]::ReadAllText($languageFile).Trim()
        if ($saved -eq 'nl') { $default = '2' }
    }
    while ($true) {
        $choice = (Ask ((Message 'Choose') -f $default)).Trim()
        if (-not $choice) { $choice = $default }
        if ($choice -in @('1', 'en', 'English')) { $language = 'en'; break }
        if ($choice -in @('2', 'nl', 'Nederlands')) { $language = 'nl'; break }
        Write-Host (Message 'InvalidLanguage')
    }
    Write-Host (Message 'Title')
    Set-Location -LiteralPath $root
    New-Item -ItemType Directory -Path (Join-Path $root 'data') -Force | Out-Null
    [IO.File]::WriteAllText($languageFile, $language, [Text.UTF8Encoding]::new($false))
    $env:CROSSBAN_UI_LANGUAGE = $language
    Ensure-Node
    $pnpm = Ensure-Pnpm
    Configure-Client
    Write-Host (Message 'Install')
    & $pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw (Message 'InstallFailed') }
    Write-Host (Message 'Start')
    & $pnpm start --open
    if ($LASTEXITCODE -ne 0) { throw (Message 'ServerFailed') }
} catch {
    $exitCode = 1
    Write-Host ((Message 'Error') -f $_.Exception.Message) -ForegroundColor Red
} finally {
    [void] (Ask (Message 'Close'))
}
exit $exitCode
