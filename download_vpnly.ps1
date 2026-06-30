$id = "gghomapcbombhbldofoilgmdjnbmcckb"
$userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

$versions = @("125.0", "120.0", "118.0", "114.0", "110.0", "38.0")
$success = $false

foreach ($v in $versions) {
    $url = "https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&prodversion=$v&x=id%3D$id%26installsource%3Dondemand%26uc"
    Write-Host "Trying prodversion = $v..."
    try {
        $response = Invoke-WebRequest -Uri $url -UserAgent $userAgent -Method Get -TimeoutSec 10 -OutFile "vpnly.crx" -ErrorAction Stop
        $success = $true
        Write-Host "Success downloading with prodversion = $v!"
        break
    } catch {
        Write-Host "Failed for version $v"
    }
}

if ($success) {
    # Extract zip
    $crxPath = "vpnly.crx"
    $zipPath = "vpnly.zip"
    $destPath = "vpnly_ext"
    
    $bytes = [System.IO.File]::ReadAllBytes($crxPath)
    $offset = -1
    for ($i = 0; $i -lt $bytes.Length - 3; $i++) {
        if ($bytes[$i] -eq 0x50 -and $bytes[$i+1] -eq 0x4B -and $bytes[$i+2] -eq 0x03 -and $bytes[$i+3] -eq 0x04) {
            $offset = $i
            break
        }
    }
    
    if ($offset -ge 0) {
        $zipBytes = New-Object byte[] ($bytes.Length - $offset)
        [System.Array]::Copy($bytes, $offset, $zipBytes, 0, $zipBytes.Length)
        [System.IO.File]::WriteAllBytes($zipPath, $zipBytes)
        
        if (Test-Path $destPath) {
            Remove-Item $destPath -Recurse -Force -ErrorAction SilentlyContinue
        }
        New-Item -ItemType Directory -Force -Path $destPath | Out-Null
        Expand-Archive -Path $zipPath -DestinationPath $destPath -Force
        
        Remove-Item $crxPath -Force -ErrorAction SilentlyContinue
        Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
        Write-Host "Extraction completed successfully!"
    } else {
        Write-Error "ZIP header not found in the downloaded CRX."
    }
} else {
    Write-Error "Could not download VPNLY extension after trying all versions."
}
