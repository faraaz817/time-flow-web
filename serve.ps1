# Minimal static file server for Time Flow web preview / phone LAN testing
param(
  [int]$Port = 5173,
  [string]$Root = $PSScriptRoot,
  [switch]$Lan
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path $Root).Path
$listener = New-Object System.Net.HttpListener

if ($Lan) {
  # Phone on same Wi‑Fi: http://YOUR_PC_IP:5173/  (admin/URL ACL may be required)
  $prefix = "http://+:$Port/"
} else {
  $prefix = "http://127.0.0.1:$Port/"
}
$listener.Prefixes.Add($prefix)

try {
  $listener.Start()
} catch {
  Write-Output "Failed to bind $prefix : $($_.Exception.Message)"
  if ($Lan) {
    Write-Output "Tip: run PowerShell as Admin, or: netsh http add urlacl url=$prefix user=Everyone"
  }
  throw
}

Write-Output "Time Flow web: $prefix"
if ($Lan) {
  try {
    $ip = Get-NetIPAddress -AddressFamily IPv4 |
      Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } |
      Select-Object -First 1 -ExpandProperty IPAddress
    if ($ip) { Write-Output "Phone URL: http://${ip}:$Port/" }
  } catch {}
}
Write-Output "Serving: $root"
Write-Output "Press Ctrl+C to stop."

function Get-ContentType([string]$path) {
  switch ([IO.Path]::GetExtension($path).ToLowerInvariant()) {
    ".html" { "text/html; charset=utf-8" }
    ".css"  { "text/css; charset=utf-8" }
    ".js"   { "text/javascript; charset=utf-8" }
    ".svg"  { "image/svg+xml" }
    ".png"  { "image/png" }
    ".ico"  { "image/x-icon" }
    ".json" { "application/json" }
    ".webmanifest" { "application/manifest+json; charset=utf-8" }
    default { "application/octet-stream" }
  }
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response

    try {
      $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart("/"))
      if ([string]::IsNullOrWhiteSpace($rel)) { $rel = "index.html" }
      $full = [IO.Path]::GetFullPath((Join-Path $root $rel))

      if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        $res.StatusCode = 403
        $bytes = [Text.Encoding]::UTF8.GetBytes("Forbidden")
      } elseif (-not (Test-Path $full -PathType Leaf)) {
        $res.StatusCode = 404
        $bytes = [Text.Encoding]::UTF8.GetBytes("Not found")
      } else {
        $bytes = [IO.File]::ReadAllBytes($full)
        $res.StatusCode = 200
        $res.ContentType = Get-ContentType $full
        # Allow SW + HTML to update; icons can cache
        if ($full -match "\.(png|ico)$") {
          $res.Headers.Add("Cache-Control", "public, max-age=86400")
        } else {
          $res.Headers.Add("Cache-Control", "no-cache")
        }
      }

      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
      try {
        $res.StatusCode = 500
        $err = [Text.Encoding]::UTF8.GetBytes("$($_.Exception.Message)")
        $res.OutputStream.Write($err, 0, $err.Length)
      } catch {}
    } finally {
      $res.OutputStream.Close()
    }
  }
} finally {
  if ($listener.IsListening) { $listener.Stop() }
  $listener.Close()
}
