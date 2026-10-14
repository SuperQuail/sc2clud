param(
  [string]$Base = 'http://localhost:5212/admin.html',
  [string]$Out = 'D:\Code\Rust\SC2clud\shots\wd2',
  [int]$Width = 1440,
  [int]$Height = 1000,
  [string[]]$Screens = @()
)

# 管理后台的出图脚本（W-D2）。**按 PID 只关自己起的 chrome**，绝不按进程名群杀。
#
# 用法（先起预览服务：cd web; npx vite --config vite.preview.config.ts --port 5212 --strictPort）：
#   pwsh -File web/scripts/shoot-admin.ps1 -Screens review,reports,rewards
#
# 为什么不用 scripts/shoot-previews.ts：那个脚本的入口是 preview.html，而管理后台的入口是
# admin.html（见 src/preview/admin-preview.tsx 的说明）。两者的出图参数也不一样（route= / asAdmin=）。

$chrome = @(
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Write-Error '找不到 Chrome/Edge'; exit 2 }

New-Item -ItemType Directory -Force -Path $Out | Out-Null
if ($Screens.Count -eq 0) {
  $Screens = @('users', 'review', 'reports', 'rewards', 'boards', 'roles', 'titles', 'mail', 'settings', 'audit', 'ai', 'diagnostics')
}

$profile = Join-Path $Out 'chrome-profile'
$failed = 0
foreach ($screen in $Screens) {
  $url = $Base + '?stub=1&asAdmin=1&route=/admin/' + $screen
  $png = Join-Path $Out ($screen + '-' + $Width + '.png')
  $args = @(
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--force-device-scale-factor=1', ('--window-size=' + $Width + ',' + $Height),
    '--virtual-time-budget=8000', ('--user-data-dir=' + $profile), ('--screenshot=' + $png), $url
  )
  # -Wait：等这一个 chrome 真的落盘再拍下一张。**只等这一个进程**，不动别人的浏览器。
  $proc = Start-Process -FilePath $chrome -ArgumentList $args -PassThru -Wait -WindowStyle Hidden
  if ((Test-Path $png) -and $proc.ExitCode -eq 0) {
    $len = (Get-Item $png).Length
    Write-Output ('OK   ' + $screen + '  ' + $len + ' bytes  ' + $png)
  } else {
    $failed++
    Write-Output ('FAIL ' + $screen + '  exit=' + $proc.ExitCode)
  }
}
Write-Output ('输出目录 ' + $Out + '，失败 ' + $failed + ' 张')
exit $failed
