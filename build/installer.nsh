; The NSIS installer's managed deployment switches, the same as the MSI's properties:
;
;   Bulwark-Setup.exe /S /INSTANCE_URL=https://mail.example.com /FORCE_INSTANCE=1 /UPDATE_CHANNEL=stable
;
; writes HKLM\SOFTWARE\Policies\Bulwark\Desktop, or \Recommended without
; /FORCE_INSTANCE=1, and takes the value out of the other one. electron-builder includes
; this file by itself. /FORCE_INSTANCE=1 needs /INSTANCE_URL=: without it nothing is
; written and the installer ends with exit code 87, since an install that looks forced
; and isn't would be worse.
;
; The per-user install doesn't elevate, and only an administrator can write policies. So
; this has to run elevated. If it can't write, it says so and ends with exit code 5: the
; app is installed, but silently leaving it unmanaged would be worse.
;
; Nothing here removes the values on uninstall: updates run the old uninstaller, and a
; machine's policy isn't this installer's to take back.

!include "FileFunc.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
; Not ${GetOptions}: it ends a value at the next "/", which is most of an address.
; A value runs to the next space, or is in double quotes. Sets the error flag if absent.
; Push the parameters, push the option; pops both and leaves the value on the stack.
Function bulwarkOption
  Exch $R1
  Exch
  Exch $R0
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  StrLen $R2 $R1
  StrCpy $R3 0
  ClearErrors
find:
  StrCpy $R4 $R0 $R2 $R3
  StrCmp $R4 "" absent
  StrCmp $R4 $R1 0 next
  ; An option starts the line or follows a space or a quote.
  IntCmp $R3 0 found
  IntOp $R4 $R3 - 1
  StrCpy $R4 $R0 1 $R4
  StrCmp $R4 " " found
  StrCmp $R4 '"' found
next:
  IntOp $R3 $R3 + 1
  Goto find
found:
  IntOp $R3 $R3 + $R2
  StrCpy $R0 $R0 "" $R3
  StrCpy $R5 " "
  StrCpy $R4 $R0 1
  StrCmp $R4 '"' 0 scan
  StrCpy $R5 '"'
  StrCpy $R0 $R0 "" 1
scan:
  StrCpy $R3 0
scanNext:
  StrCpy $R4 $R0 1 $R3
  StrCmp $R4 "" done
  StrCmp $R4 $R5 done
  IntOp $R3 $R3 + 1
  Goto scanNext
done:
  StrCpy $R0 $R0 $R3
  ; No quotes in a value: the app's check would refuse it, but it shouldn't get that far.
  StrCpy $R5 ""
  StrCpy $R3 0
strip:
  StrCpy $R4 $R0 1 $R3
  StrCmp $R4 "" stripped
  IntOp $R3 $R3 + 1
  StrCmp $R4 '"' strip
  StrCpy $R5 "$R5$R4"
  Goto strip
stripped:
  StrCpy $R0 $R5
  ClearErrors
  Goto finish
absent:
  StrCpy $R0 ""
  SetErrors
finish:
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Exch
  Pop $R1
  Exch $R0
FunctionEnd
!endif

!ifndef BULWARK_POLICY_HIVE
  !define BULWARK_POLICY_HIVE "HKLM"
!endif
!ifndef BULWARK_POLICY_KEY
  !define BULWARK_POLICY_KEY "SOFTWARE\Policies\Bulwark\Desktop"
!endif

!macro bulwarkWritePolicies
  Push $0
  Push $1
  Push $2
  Push $3
  ${GetParameters} $0

  Push $0
  Push "/FORCE_INSTANCE="
  Call bulwarkOption
  Pop $1
  Push $4
  ${If} $1 == "1"
    StrCpy $2 "${BULWARK_POLICY_KEY}"
    StrCpy $4 "${BULWARK_POLICY_KEY}\Recommended"
  ${Else}
    StrCpy $2 "${BULWARK_POLICY_KEY}\Recommended"
    StrCpy $4 "${BULWARK_POLICY_KEY}"
  ${EndIf}

  StrCpy $3 ""
  ${If} $1 == "1"
    Push $0
    Push "/INSTANCE_URL="
    Call bulwarkOption
    Pop $3
    ${If} ${Errors}
    ${OrIf} $3 == ""
      StrCpy $3 "stop"
    ${Else}
      StrCpy $3 ""
    ${EndIf}
  ${EndIf}

  SetRegView 64
  StrCpy $1 ""

  ${If} $3 == "stop"
    StrCpy $1 "unforced"
    Goto bulwarkPoliciesDone
  ${EndIf}

  Push $0
  Push "/INSTANCE_URL="
  Call bulwarkOption
  Pop $3
  ${IfNot} ${Errors}
    ClearErrors
    WriteRegStr ${BULWARK_POLICY_HIVE} "$2" "InstanceUrl" "$3"
    ${If} ${Errors}
      StrCpy $1 "failed"
    ${Else}
      DeleteRegValue ${BULWARK_POLICY_HIVE} "$4" "InstanceUrl"
    ${EndIf}
  ${EndIf}

  Push $0
  Push "/UPDATE_CHANNEL="
  Call bulwarkOption
  Pop $3
  ${IfNot} ${Errors}
    ClearErrors
    WriteRegStr ${BULWARK_POLICY_HIVE} "$2" "UpdateChannel" "$3"
    ${If} ${Errors}
      StrCpy $1 "failed"
    ${Else}
      DeleteRegValue ${BULWARK_POLICY_HIVE} "$4" "UpdateChannel"
    ${EndIf}
  ${EndIf}

bulwarkPoliciesDone:
  SetRegView lastused
  Pop $4
  ${If} $1 == "unforced"
    SetErrorLevel 87
    MessageBox MB_ICONEXCLAMATION|MB_OK "Bulwark was installed, but /FORCE_INSTANCE=1 needs /INSTANCE_URL=. No settings were written." /SD IDOK
  ${EndIf}
  ${If} $1 == "failed"
    SetErrorLevel 5
    MessageBox MB_ICONEXCLAMATION|MB_OK "Bulwark was installed, but its settings could not be written. Run the installer as an administrator to set /INSTANCE_URL or /UPDATE_CHANNEL." /SD IDOK
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro customInstall
  !insertmacro bulwarkWritePolicies
!macroend

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
