; What the app writes at runtime outside its folder goes at a real uninstall. An update runs
; this too, with ${isUpdated} set, and those stay: the app keeps its pending download, and
; the toast keys come back at the next toast anyway.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\bulwark-desktop-updater"
    ; Electron registers a COM server for toasts under a CLSID it may make up itself. Any
    ; that names this install goes.
    Push $R6
    Push $R7
    Push $R8
    StrCpy $R6 0
    ${Do}
      EnumRegKey $R7 HKCU "Software\Classes\CLSID" $R6
      ${If} $R7 == ""
        ${ExitDo}
      ${EndIf}
      ReadRegStr $R8 HKCU "Software\Classes\CLSID\$R7\LocalServer32" ""
      ${If} $R8 == "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      ${OrIf} $R8 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
        DeleteRegKey HKCU "Software\Classes\CLSID\$R7"
      ${Else}
        IntOp $R6 $R6 + 1
      ${EndIf}
    ${Loop}
    Pop $R8
    Pop $R7
    Pop $R6
  ${endIf}
!macroend
