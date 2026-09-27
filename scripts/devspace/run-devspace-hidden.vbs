Set sh = CreateObject("WScript.Shell")
Set procEnv = sh.Environment("PROCESS")
procEnv("DEVSPACE_TOOL_MODE") = "minimal"
procEnv("DEVSPACE_SUBAGENTS") = "0"
ps = Chr(34) & sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe" & Chr(34)
scriptPath = Chr(34) & sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.devspace\start-devspace-longterm.ps1" & Chr(34)
cmd = ps & " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & scriptPath
rc = sh.Run(cmd, 0, True)
WScript.Quit rc
