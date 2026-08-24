[CmdletBinding()]
param(
    [string]$DataRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "fetch-companyx.ts"
if ([string]::IsNullOrWhiteSpace($DataRoot)) {
    & node $scriptPath
}
else {
    & node $scriptPath $DataRoot
}
if ($LASTEXITCODE -ne 0) {
    throw "Company-X installer failed with exit code $LASTEXITCODE."
}
