$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$projectRoot = Split-Path -Parent $PSScriptRoot
$projectRoot = (Resolve-Path -LiteralPath $projectRoot).Path
$manifest = @(& git -C $projectRoot ls-files)
if ($LASTEXITCODE -ne 0 -or $manifest.Count -eq 0) { throw 'Stage the public source files in Git before packaging.' }
foreach ($required in @('.gitignore', '.env.example', 'LICENSE', 'README.md', 'README.nl.md')) {
    if ($manifest -notcontains $required) { throw "Missing source file: $required" }
}
foreach ($entry in $manifest) {
    if ($entry -ne '.env.example' -and $entry -match '(^|/)(data|export|node_modules|\.dev_docs|\.git)(/|$)|(^|/)\.env(\.|$)') {
        throw "Private file in source manifest: $entry"
    }
    $absolute = (Resolve-Path -LiteralPath (Join-Path $projectRoot $entry)).Path
    if (-not $absolute.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Source path leaves project: $entry"
    }
    $item = Get-Item -LiteralPath $absolute -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Unexpected source entry: $entry" }
}
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$releaseDirectory = Join-Path $projectRoot 'release'
New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
$name = 'crossban-review-{0}-{1}.zip' -f $package.version, ([guid]::NewGuid().ToString('N').Substring(0, 8))
$destination = Join-Path $releaseDirectory $name
$archive = [IO.Compression.ZipFile]::Open($destination, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($entry in $manifest) {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $projectRoot $entry), $entry, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally { $archive.Dispose() }
Write-Output "Source package: $destination"
