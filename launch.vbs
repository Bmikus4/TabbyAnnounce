Dim node, dir, fso, port, tries, f

node = "C:\Users\thera\scoop\apps\nodejs\current\node.exe"
dir  = "C:\Users\thera\TabbyAnnounce"

Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = dir

' Delete old port file
Set fso = CreateObject("Scripting.FileSystemObject")
If fso.FileExists(dir & "\.port") Then fso.DeleteFile dir & "\.port"

' Launch bot in visible window
WshShell.Run """" & node & """ index.js", 1, False

' Wait for .port file (up to 20s)
tries = 0
port  = "3000"
Do While tries < 20
    WScript.Sleep 1000
    If fso.FileExists(dir & "\.port") Then
        Set f = fso.OpenTextFile(dir & "\.port", 1)
        port = Trim(f.ReadLine())
        f.Close
        Exit Do
    End If
    tries = tries + 1
Loop

If tries >= 20 Then
    MsgBox "TabbyAnnounce failed to start. Check the console window for errors.", 16, "Launch Failed"
Else
    WshShell.Run "http://localhost:" & port
End If
