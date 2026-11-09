$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PanoramaWindows {
  public delegate bool EnumCallback(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder text,int length);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h,int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect rect);
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FlashInfo info);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct FlashInfo {public uint cbSize;public IntPtr hwnd;public uint flags;public uint count;public uint timeout;}
  public class Window {public string handle;public uint pid;public string title;}
  public static Window[] List() {
    var windows=new List<Window>();
    EnumWindows((h,p)=>{if(IsWindowVisible(h)){int n=GetWindowTextLength(h);if(n>0){var title=new StringBuilder(n+1);GetWindowText(h,title,n+1);uint pid;GetWindowThreadProcessId(h,out pid);windows.Add(new Window{handle=h.ToInt64().ToString(),pid=pid,title=title.ToString()});}}return true;},IntPtr.Zero);
    return windows.ToArray();
  }
  public static void Validate(IntPtr h,uint pid){uint actual;GetWindowThreadProcessId(h,out actual);if(!IsWindow(h)||actual!=pid)throw new Exception("Window closed or changed. Choose it again.");}
  public static bool Focus(IntPtr h,uint pid){
    Validate(h,pid);if(IsIconic(h))ShowWindowAsync(h,9);
    bool ok=SetForegroundWindow(h);
    if(!ok){var f=new FlashInfo{cbSize=(uint)Marshal.SizeOf(typeof(FlashInfo)),hwnd=h,flags=3,count=5,timeout=0};FlashWindowEx(ref f);}
    return ok;
  }
}
'@
[void][PanoramaWindows]::SetProcessDPIAware()
$action = $env:PANORAMA_NATIVE_ACTION
if ($action -eq 'list') {
  $windows = @([PanoramaWindows]::List() | ForEach-Object {
    $w = $_
    try {
      $process = Get-Process -Id $w.pid -ErrorAction Stop
      if ($process.ProcessName -match '^(Code|Code - Insiders|Claude|ChatGPT|Codex|WindowsTerminal)$') {
        @{handle=$w.handle;pid=$w.pid;title=$w.title;process=$process.ProcessName}
      }
    } catch { }
  })
  ConvertTo-Json -InputObject $windows -Compress
  exit
}
$handle = [IntPtr]([long]$env:PANORAMA_WINDOW_HANDLE)
$targetPid = [uint32]$env:PANORAMA_WINDOW_PID
if ($action -eq 'inspect') {
  [PanoramaWindows]::Validate($handle,$targetPid)
  $processName=(Get-Process -Id $targetPid).ProcessName
  if ($processName -ne 'Claude') { throw 'Accessibility monitoring is limited to Claude app windows.' }
  if ([PanoramaWindows]::IsIconic($handle)) { @{nodes=@();unavailable='Claude is minimized. Restore its window for accessibility monitoring.'} | ConvertTo-Json -Compress; exit }
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $root=[System.Windows.Automation.AutomationElement]::FromHandle($handle)
  $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
  $stack=[System.Collections.Generic.Stack[object]]::new()
  $stack.Push(@{element=$root;parent=-1;depth=0})
  $nodes=[System.Collections.Generic.List[object]]::new()
  $clock=[System.Diagnostics.Stopwatch]::StartNew()
  while ($stack.Count -gt 0 -and $nodes.Count -lt 1200 -and $clock.ElapsedMilliseconds -lt 2500) {
    $item=$stack.Pop()
    try {
      $element=$item.element; $current=$element.Current
      $id=$nodes.Count; $name=[string]$current.Name; $automationId=[string]$current.AutomationId
      $entry=@{id=$id;parent=$item.parent;type=$current.ControlType.ProgrammaticName.Replace('ControlType.','');name=$name.Substring(0,[Math]::Min(900,$name.Length));automationId=$automationId;enabled=$current.IsEnabled;offscreen=$current.IsOffscreen}
      if (!$current.IsOffscreen -and $entry.type -ne 'Edit' -and ($name+' '+$automationId) -match '(?i)assistant[-_ ]?(message|response)|claude.*response|response.*claude|Claude 回复') {
        $pattern=$null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$pattern)) {$entry.text=$pattern.DocumentRange.GetText(12000)}
      }
      $nodes.Add($entry)
      if ($item.depth -lt 35) {
        $child=$walker.GetLastChild($element); $children=0
        while ($null -ne $child -and $children -lt 1200 -and $clock.ElapsedMilliseconds -lt 2500) {
          $stack.Push(@{element=$child;parent=$id;depth=$item.depth+1});$children++
          $child=$walker.GetPreviousSibling($child)
        }
      }
    } catch { }
  }
  @{nodes=@($nodes.ToArray());truncated=($stack.Count -gt 0);unavailable=$(if($nodes.Count -lt 3){'Claude did not expose readable accessibility controls. Open its chat window and inspect diagnostics.'}else{''})} | ConvertTo-Json -Depth 7 -Compress
  exit
}
if ($action -eq 'focus') {
  $ok = [PanoramaWindows]::Focus($handle,$targetPid)
  @{focused=$ok;message=$(if($ok){'Window brought forward.'}else{'Windows prevented focus switching; the taskbar button is flashing.'})} | ConvertTo-Json -Compress
  exit
}
if ($action -eq 'capture') {
  [PanoramaWindows]::Validate($handle,$targetPid)
  if ([PanoramaWindows]::IsIconic($handle)) { throw 'Restore the window first. Minimized previews are unavailable.' }
  $rect = [PanoramaWindows+Rect]::new()
  [void][PanoramaWindows]::GetWindowRect($handle,[ref]$rect)
  $width=$rect.Right-$rect.Left; $height=$rect.Bottom-$rect.Top
  if ($width -le 0 -or $height -le 0 -or $width -gt 8192 -or $height -gt 8192) { throw 'Unsupported window dimensions.' }
  $bitmap = [System.Drawing.Bitmap]::new($width,$height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $dc=$graphics.GetHdc()
  try {$ok=[PanoramaWindows]::PrintWindow($handle,$dc,2)} finally {$graphics.ReleaseHdc($dc)}
  try {
    if (!$ok) { throw 'This app did not provide a window preview.' }
    $scale=[Math]::Min(680.0/$width,400.0/$height)
    $scaled=[System.Drawing.Bitmap]::new([int][Math]::Max(1,$width*$scale),[int][Math]::Max(1,$height*$scale))
    $g=[System.Drawing.Graphics]::FromImage($scaled)
    try {
      $g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.DrawImage($bitmap,0,0,$scaled.Width,$scaled.Height)
      $stream=New-Object System.IO.MemoryStream
      try {$scaled.Save($stream,[System.Drawing.Imaging.ImageFormat]::Jpeg);[Convert]::ToBase64String($stream.ToArray())} finally {$stream.Dispose()}
    } finally {$g.Dispose();$scaled.Dispose()}
  } finally {$graphics.Dispose();$bitmap.Dispose()}
  exit
}
if ($action -eq 'notify') {
  $note=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PANORAMA_NOTIFICATION)) | ConvertFrom-Json
  $icon=New-Object System.Windows.Forms.NotifyIcon
  $icon.Icon=[System.Drawing.SystemIcons]::Information
  $icon.Text='Panorama'
  $icon.Visible=$true
  $icon.BalloonTipTitle=$note.title
  $icon.BalloonTipText=$note.message
  $icon.add_BalloonTipClicked({
    if ($handle -ne [IntPtr]::Zero) {try {[void][PanoramaWindows]::Focus($handle,$targetPid)} catch {}}
    else {Start-Process $env:PANORAMA_DASHBOARD_URL}
  })
  $timer=New-Object System.Windows.Forms.Timer
  $timer.Interval=10000
  $timer.add_Tick({[System.Windows.Forms.Application]::ExitThread()})
  $timer.Start()
  try {$icon.ShowBalloonTip(8000);[System.Windows.Forms.Application]::Run()} finally {$timer.Dispose();$icon.Visible=$false;$icon.Dispose()}
  exit
}
throw 'Unknown native action.'
