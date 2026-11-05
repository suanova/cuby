param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
$uri = 'https://en-rules.hkex.com.hk/sites/default/files/net_file_store/HKEX4476_3841_VER36624.pdf'
Invoke-WebRequest -Uri $uri -OutFile $OutputPath -TimeoutSec 25 -MaximumRedirection 3
if ((Get-Item -LiteralPath $OutputPath).Length -gt 5242880) { throw 'Official C2 PDF exceeds 5 MiB' }
