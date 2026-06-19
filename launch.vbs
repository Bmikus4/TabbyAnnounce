Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\thera\TabbyAnnounce"
WshShell.Run "node index.js", 1, False
WScript.Sleep 2500
Dim fso, port
Set fso = CreateObject("Scripting.FileSystemObject")
port = "3000"
Dim tries : tries = 0
Do While tries < 10
    If fso.FileExists("C:\Users\thera\TabbyAnnounce\.port") Then
        Dim f : Set f = fso.OpenTextFile("C:\Users\thera\TabbyAnnounce\.port", 1)
        port = Trim(f.ReadLine())
        f.Close
        Exit Do
    End If
    WScript.Sleep 1000
    tries = tries + 1
Loop
WshShell.Run "http://localhost:" & port, 1, False
