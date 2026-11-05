param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
# Fixed public regulator URL. Windows' normal certificate verification stays enabled.
$uri = 'https://en-rules.hkex.com.hk/rulebook/appendix-c2-environmental-social-and-governance-reporting-code-0'
$response = Invoke-WebRequest -Uri $uri -TimeoutSec 15 -MaximumRedirection 3
$bytes = [System.Text.Encoding]::UTF8.GetBytes($response.Content)
if ($bytes.Length -gt 3145728) { throw 'Rulebook response exceeds 3 MiB' }
[System.IO.File]::WriteAllBytes($OutputPath, $bytes)
