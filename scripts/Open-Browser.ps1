param([Parameter(Mandatory = $true)][string]$Url)

$ErrorActionPreference = 'Stop'
Start-Process -FilePath $Url
