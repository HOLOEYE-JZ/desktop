; What makes the one-click installer and its uninstaller quicker than electron-builder's own,
; measured on an install with Windows Defender on:
;
; - "Is Bulwark running?" without PowerShell. electron-builder starts PowerShell three times
;   for it, about seven seconds on a busy machine, and an update paid that twice: once in the
;   installer and once in the old uninstaller. The BulwarkSplash plugin (native/nsis-splash)
;   asks Windows for the processes running from $INSTDIR instead, in milliseconds. Same steps
;   as electron-builder's: an update gives the app a moment to quit by itself, a person is
;   asked first, then the app is ended, and one that can't be ended (run as administrator) is
;   left to the person.
; - The unpacked files are moved into $INSTDIR, not copied. electron-builder unpacks into
;   $PLUGINSDIR and then copies everything, so each byte was written twice and scanned twice,
;   and the copy was deleted again when the installer closed. $PLUGINSDIR is in %TEMP%, under
;   %LOCALAPPDATA% like the default install folder, so a move is a rename. Anything that can't
;   move (another drive, a file in the way) is copied as before. Only for a folder under
;   %LOCALAPPDATA%: a moved file keeps the permissions it got in %TEMP%, which are the same
;   there and might not be somewhere else.
; - The unpacking reports its progress to the window, so the bar follows it.
;
; installer-extract.nsh puts the last two into electron-builder's extractUsing7za.

!ifndef BUILD_UNINSTALLER
; Pops the folder; pushes how many entries are left in 7z-out, which the copy then takes.
Function bulwarkMoveExtracted
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  StrCpy $R3 0
  StrLen $R1 "$LOCALAPPDATA\"
  StrCpy $R2 "$R0" $R1
  ${If} $R2 == "$LOCALAPPDATA\"
    FindFirst $R1 $R2 "$PLUGINSDIR\7z-out\*"
    ${DoWhile} $R2 != ""
      ${If} $R2 != "."
      ${AndIf} $R2 != ".."
        ; Never over something: a folder already there would take this one inside it.
        ${IfNot} ${FileExists} "$R0\$R2"
          ClearErrors
          Rename "$PLUGINSDIR\7z-out\$R2" "$R0\$R2"
        ${EndIf}
      ${EndIf}
      FindNext $R1 $R2
    ${Loop}
    FindClose $R1
  ${EndIf}
  FindFirst $R1 $R2 "$PLUGINSDIR\7z-out\*"
  ${DoWhile} $R2 != ""
    ${If} $R2 != "."
    ${AndIf} $R2 != ".."
      IntOp $R3 $R3 + 1
    ${EndIf}
    FindNext $R1 $R2
  ${Loop}
  FindClose $R1
  ClearErrors
  StrCpy $R0 $R3
  Pop $R3
  Pop $R2
  Pop $R1
  Exch $R0
FunctionEnd
!endif

!macro bulwarkCheckAppRunning
  Push $R0
  Push $R1
  BulwarkSplash::Running "$INSTDIR"
  Pop $R0
  ${If} $R0 == 1
  ${AndIf} ${isUpdated}
    ; The app started this update and is on its way out: up to three seconds to finish.
    StrCpy $R1 0
    ${Do}
      Sleep 100
      IntOp $R1 $R1 + 1
      BulwarkSplash::Running "$INSTDIR"
      Pop $R0
      ${If} $R0 != 1
      ${OrIf} $R1 >= 30
        ${ExitDo}
      ${EndIf}
    ${Loop}
  ${EndIf}
  ${If} $R0 == 1
    ${IfNot} ${isUpdated}
    ${AndIf} ${Cmd} `MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDCANCEL`
      Quit
    ${EndIf}
    DetailPrint "$(appClosing)"
    StrCpy $R1 0
    ${Do}
      BulwarkSplash::Stop "$INSTDIR"
      Pop $R0
      ${If} $R0 != 1
        ${ExitDo}
      ${EndIf}
      IntOp $R1 $R1 + 1
      ${If} $R1 > 1
        ; Most likely run as administrator: only the person can close it.
        ${IfNot} ${Cmd} `MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY`
          Quit
        ${EndIf}
      ${Else}
        Sleep 1000
      ${EndIf}
    ${Loop}
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend
