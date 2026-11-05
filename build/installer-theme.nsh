; The installer's window in Bulwark's colours: the app's background, its text colours, the
; logo, and the progress bar in its accent colour. Dark or light as Windows' app mode is set
; (AppsUseLightTheme), light when that can't be read, Windows' own colours with High Contrast
; on. The native title bar stays, dark in dark mode.
;
; Only the one-click installer, which is what electron-builder.yml builds. Its window is
; electron-builder's: the instfiles page with the SpiderBanner plugin's dialog on top. Once
; the banner is up, this hides it and everything else on the window but the page's own
; progress bar, which NSIS keeps moving, and draws the rest:
;
;   installing     "Installing Bulwark…"  "Bulwark opens once it's installed."
;   --updated      "Updating Bulwark…"    "Bulwark restarts once it's updated."
;   uninstaller    "Removing Bulwark…"
;
; The uninstaller used to ask "Are you sure…?" and then run hidden. Started by a person (no
; /S), it now asks nothing and shows this window while it removes the files. Updates run it
; with /S and see nothing.
;
; NSIS's own "verifying installer" box still shows when the integrity check takes over a
; second. Only SilentInstall can hide it, and that also hides the "integrity check failed"
; message, so a broken download would close without a word.
;
; Nothing here changes what gets installed or written: only the window.
;
; installer.nsh includes this. makensis runs with -WX, so a function or variable that one of
; the two passes (installer, uninstaller) doesn't use would fail the build: each is only
; defined in the pass that calls it.

!ifdef ONE_CLICK

!define BULWARK_THEME_DIR "${__FILEDIR__}"
; Where Windows keeps the app mode. Tests point it elsewhere.
!ifndef BULWARK_THEME_KEY
  !define BULWARK_THEME_KEY "Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"
!endif

; Drawn at the screen's scale instead of stretched by Windows.
ManifestDPIAware true

!include "WinMessages.nsh"
!include "${BULWARK_THEME_DIR}\installer-strings.nsh"

; A length in pixels at the window's scale: VALUE is at 100 %, $R5 holds the DPI.
!macro bulwarkPx OUT VALUE
  IntOp ${OUT} ${VALUE} * $R5
  IntOp ${OUT} ${OUT} + 48
  IntOp ${OUT} ${OUT} / 96
!macroend

; Hides every child of PARENT but KEEP.
!macro bulwarkHideChildren PARENT KEEP
  StrCpy $0 0
  ${Do}
    FindWindow $0 "" "" ${PARENT} $0
    ${If} $0 == 0
      ${ExitDo}
    ${EndIf}
    ${If} $0 != ${KEEP}
      ShowWindow $0 ${SW_HIDE}
    ${EndIf}
  ${Loop}
!macroend

; The height of TEXT (a register) in FONT at WIDTH, wrapped at words, into OUT.
!macro bulwarkMeasure OUT TEXT FONT WIDTH
  System::Call 'user32::GetDC(p $R0) p .r8'
  System::Call 'gdi32::SelectObject(p r8, p ${FONT}) p .r7'
  System::Call '*(i 0, i 0, i ${WIDTH}, i 0) p .r6'
  System::Call 'user32::DrawTextW(p r8, w ${TEXT}, i -1, p r6, i 0xC10)'
  System::Call '*$6(i, i, i, i .s)'
  System::Free $6
  System::Call 'gdi32::SelectObject(p r8, p r7)'
  System::Call 'user32::ReleaseDC(p $R0, p r8)'
  Pop ${OUT}
!macroend

; The logo and the two lines: made hidden in .onGUIInit, placed and shown by
; bulwarkThemeWindow. Made there, they'd belong to the install section's thread, which
; paints them only while it waits for something (ExecWait): while an update ran the old
; uninstaller, the lines got a white background next to their text. Made here, they're the
; window's own, painted by its thread like the rest of it.
Var bulwarkLogo
Var bulwarkTitle
Var bulwarkLine
!macro bulwarkThemeStatics
  ; Styles: child, hidden, no & prefix; right to left: WS_EX_RTLREADING, SS_RIGHT.
  StrCpy $0 0
  StrCpy $1 0x40000080
  StrCpy $2 "$(^RTL)"
  ${If} $2 == 1
    StrCpy $0 0x2000
    StrCpy $1 0x40000082
  ${EndIf}
  ; SS_ICON, SS_CENTERIMAGE.
  System::Call 'user32::CreateWindowExW(i r0, w "STATIC", w "", i 0x40000043, i 0, i 0, i 0, i 0, p $HWNDPARENT, p 0, p 0, p 0) p .r2'
  StrCpy $bulwarkLogo $2
  System::Call 'user32::CreateWindowExW(i r0, w "STATIC", w "", i r1, i 0, i 0, i 0, i 0, p $HWNDPARENT, p 0, p 0, p 0) p .r2'
  StrCpy $bulwarkTitle $2
  System::Call 'user32::CreateWindowExW(i r0, w "STATIC", w "", i r1, i 0, i 0, i 0, i 0, p $HWNDPARENT, p 0, p 0, p 0) p .r2'
  StrCpy $bulwarkLine $2
!macroend

; Light or dark ($R4) colours for a control, unless High Contrast is on ($R3).
!macro bulwarkColours HWND TEXT
  ${If} $R3 == 0
    ${If} $R4 == 1
      !if "${TEXT}" == "title"
        SetCtlColors ${HWND} FAFAFA 0A0A0A
      !else
        SetCtlColors ${HWND} ADADAD 0A0A0A
      !endif
    ${Else}
      !if "${TEXT}" == "title"
        SetCtlColors ${HWND} 0F172A FFFFFF
      !else
        SetCtlColors ${HWND} 59687C FFFFFF
      !endif
    ${EndIf}
  ${EndIf}
!macroend

;  Until the window is drawn, it's see-through, so the plain one never flashes up: from
; .onGUIInit until the end of bulwarkThemeWindow, which every run with a window reaches.
!macro bulwarkThemeHide
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20) i .r0'
  IntOp $0 $0 | 0x80000
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -20, i r0)'
  System::Call 'user32::SetLayeredWindowAttributes(p $HWNDPARENT, i 0, i 0, i 2)'
!macroend
!macro bulwarkThemeShow
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20) i .r0'
  IntOp $1 0x80000 ~
  IntOp $0 $0 & $1
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -20, i r0)'
  System::Call 'user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i 0x585)'
!macroend

; Push the second line (or ""), then the first, then call.
!macro bulwarkThemeFunction UN
Function ${UN}bulwarkThemeWindow
  Exch $R9
  Exch
  Exch $R8
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6

  StrCpy $R0 $HWNDPARENT
  ; The page: the dialog with the progress bar in it.
  StrCpy $R1 0
  StrCpy $R2 0
  StrCpy $0 0
  ${Do}
    FindWindow $0 "#32770" "" $R0 $0
    ${If} $0 == 0
      ${ExitDo}
    ${EndIf}
    GetDlgItem $1 $0 1004
    ${If} $1 != 0
      StrCpy $R1 $0
      StrCpy $R2 $1
      ${ExitDo}
    ${EndIf}
  ${Loop}
  ${If} $R2 == 0
    Goto done
  ${EndIf}

  ; High Contrast: SPI_GETHIGHCONTRAST, HCF_HIGHCONTRASTON.
  System::Call '*(i 12, i 0, i 0) p .r0'
  System::Call 'user32::SystemParametersInfoW(i 0x42, i 12, p r0, i 0)'
  System::Call '*$0(i, i .r1)'
  System::Free $0
  IntOp $R3 $1 & 1
  ; Dark only when Windows says so.
  StrCpy $R4 0
  ${If} $R3 == 0
    ClearErrors
    ReadRegDWORD $0 HKCU "${BULWARK_THEME_KEY}" "AppsUseLightTheme"
    ${IfNot} ${Errors}
    ${AndIf} $0 == 0
      StrCpy $R4 1
    ${EndIf}
  ${EndIf}
  System::Call 'user32::GetDC(p $R0) p .r0'
  System::Call 'gdi32::GetDeviceCaps(p r0, i 90) i .R5'
  System::Call 'user32::ReleaseDC(p $R0, p r0)'
  !ifdef BULWARK_THEME_DPI
    StrCpy $R5 ${BULWARK_THEME_DPI}
  !endif
  ; Right to left: the logo on the right, text aligned right.
  StrCpy $R6 "$(^RTL)"

  ; Segoe UI, 12 pt semibold and 9 pt.
  !insertmacro bulwarkPx $0 16
  IntOp $0 0 - $0
  System::Call 'gdi32::CreateFontW(i r0, i 0, i 0, i 0, i 600, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "Segoe UI") p .r4'
  !insertmacro bulwarkPx $0 12
  IntOp $0 0 - $0
  System::Call 'gdi32::CreateFontW(i r0, i 0, i 0, i 0, i 400, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "Segoe UI") p .r5'

  ; 460 by at least 96 at 100 %: 24 around, the 48 logo, 16 to the text column.
  !insertmacro bulwarkPx $1 348
  !insertmacro bulwarkMeasure $2 R9 $4 $1
  StrCpy $3 0
  ${If} $R8 != ""
    !insertmacro bulwarkMeasure $3 R8 $5 $1
  ${EndIf}
  ; The text block: title, 2, second line, 12, bar of 4.
  !insertmacro bulwarkPx $6 4
  !insertmacro bulwarkPx $7 12
  IntOp $0 $2 + $7
  IntOp $0 $0 + $6
  ${If} $3 != 0
    !insertmacro bulwarkPx $7 2
    IntOp $0 $0 + $7
    IntOp $0 $0 + $3
  ${EndIf}
  ; Next to the logo, centred on it when shorter.
  !insertmacro bulwarkPx $7 48
  !insertmacro bulwarkPx $8 24
  StrCpy $9 $8
  ${If} $0 < $7
    IntOp $9 $7 - $0
    IntOp $9 $9 / 2
    IntOp $9 $9 + $8
    StrCpy $0 $7
  ${EndIf}
  ; $0 block height, $9 its top. Client height into $0. Kept: $1 width, $2 and $3 heights.
  IntOp $0 $0 + $8
  IntOp $0 $0 + $8
  Push $1
  Push $2
  Push $3
  Push $9
  Push $0

  ; The window, centred where it was.
  System::Call '*(i, i, i, i) p .r9'
  System::Call 'user32::GetWindowRect(p $R0, p r9)'
  System::Call '*$9(i .r0, i .r1, i .r2, i .r3)'
  System::Call 'user32::GetClientRect(p $R0, p r9)'
  System::Call '*$9(i, i, i .r6, i .r7)'
  System::Free $9
  IntOp $2 $2 - $0
  IntOp $3 $3 - $1
  IntOp $6 $2 - $6
  IntOp $7 $3 - $7
  !insertmacro bulwarkPx $8 460
  IntOp $6 $6 + $8
  Pop $8
  IntOp $7 $7 + $8
  IntOp $8 $2 - $6
  IntOp $8 $8 / 2
  IntOp $0 $0 + $8
  IntOp $8 $3 - $7
  IntOp $8 $8 / 2
  IntOp $1 $1 + $8
  System::Call 'user32::SetWindowPos(p $R0, p 0, i r0, i r1, i r6, i r7, i 0x34)'
  Pop $9
  Pop $3
  Pop $2
  Pop $1

  ; Only the page stays, and on it only the bar.
  !insertmacro bulwarkHideChildren $R0 $R1
  !insertmacro bulwarkHideChildren $R1 $R2

  ; Text column: x into $6, width $1.
  !insertmacro bulwarkPx $6 88
  ${If} $R6 == 1
    !insertmacro bulwarkPx $6 24
  ${EndIf}

  ; The logo, at its exact size from the .ico, so it's never scaled.
  Push $9
  InitPluginsDir
  File "/oname=$PLUGINSDIR\bulwark-installer-logo.ico" "${BULWARK_THEME_DIR}\installer-logo.ico"
  StrCpy $0 "$PLUGINSDIR\bulwark-installer-logo.ico"
  !insertmacro bulwarkPx $7 48
  System::Call 'user32::LoadImageW(p 0, w r0, i 1, i r7, i r7, i 0x10) p .r0'
  !insertmacro bulwarkPx $8 24
  ${If} $R6 == 1
    !insertmacro bulwarkPx $8 388
  ${EndIf}
  !insertmacro bulwarkPx $9 24
  SendMessage $bulwarkLogo 0x172 1 $0
  !insertmacro bulwarkColours $bulwarkLogo title
  ; SWP_NOZORDER, SWP_NOACTIVATE, SWP_SHOWWINDOW.
  System::Call 'user32::SetWindowPos(p $bulwarkLogo, p 0, i r8, i r9, i r7, i r7, i 0x54)'
  Pop $9

  ; The lines.
  SendMessage $bulwarkTitle ${WM_SETTEXT} 0 "STR:$R9"
  SendMessage $bulwarkTitle ${WM_SETFONT} $4 0
  !insertmacro bulwarkColours $bulwarkTitle title
  System::Call 'user32::SetWindowPos(p $bulwarkTitle, p 0, i r6, i r9, i r1, i r2, i 0x54)'
  IntOp $9 $9 + $2
  ${If} $R8 != ""
    !insertmacro bulwarkPx $0 2
    IntOp $9 $9 + $0
    SendMessage $bulwarkLine ${WM_SETTEXT} 0 "STR:$R8"
    SendMessage $bulwarkLine ${WM_SETFONT} $5 0
    !insertmacro bulwarkColours $bulwarkLine muted
    System::Call 'user32::SetWindowPos(p $bulwarkLine, p 0, i r6, i r9, i r1, i r3, i 0x54)'
    IntOp $9 $9 + $3
  ${EndIf}

  ; The bar: the page, cut down to it, under the text.
  !insertmacro bulwarkPx $0 12
  IntOp $9 $9 + $0
  !insertmacro bulwarkPx $2 6
  System::Call 'user32::SetWindowPos(p $R1, p 0, i r6, i r9, i r1, i r2, i 0x54)'

  ${If} $R3 == 0
    ; Without the visual style, so the bar takes the colours: PBM_SETBARCOLOR, PBM_SETBKCOLOR.
    ; Colours are 0xBBGGRR.
    System::Call 'uxtheme::SetWindowTheme(p $R2, w "", w "")'
    ${If} $R4 == 1
      ; #60a5fa on #262626, the app's dark accent and muted.
      SendMessage $R2 0x409 0 0xFAA560
      SendMessage $R2 0x2001 0 0x262626
      SetCtlColors $R0 FAFAFA 0A0A0A
      SetCtlColors $R1 FAFAFA 0A0A0A
      ; Dark title bar: DWMWA_USE_IMMERSIVE_DARK_MODE, 19 before Windows 10 20H1.
      System::Call 'dwmapi::DwmSetWindowAttribute(p $R0, i 20, *i 1, i 4) i .r0'
      ${If} $0 != 0
        System::Call 'dwmapi::DwmSetWindowAttribute(p $R0, i 19, *i 1, i 4)'
      ${EndIf}
    ${Else}
      ; #185aea on #e2e8f0, the app's light primary and border.
      SendMessage $R2 0x409 0 0xEA5A18
      SendMessage $R2 0x2001 0 0xF0E8E2
      SetCtlColors $R0 0F172A FFFFFF
      SetCtlColors $R1 0F172A FFFFFF
    ${EndIf}
  ${EndIf}
  ; No border or edge: a flat bar. After the theme, which puts the edge back.
  System::Call 'user32::GetWindowLongW(p $R2, i -20) i .r0'
  IntOp $3 0x20200 ~
  IntOp $0 $0 & $3
  System::Call 'user32::SetWindowLongW(p $R2, i -20, i r0)'
  System::Call 'user32::GetWindowLongW(p $R2, i -16) i .r0'
  IntOp $3 0x800000 ~
  IntOp $0 $0 & $3
  System::Call 'user32::SetWindowLongW(p $R2, i -16, i r0)'
  System::Call 'user32::SetWindowPos(p $R2, p 0, i 0, i 0, i r1, i r2, i 0x34)'
  ; Frame and all.
  System::Call 'user32::SetWindowPos(p $R0, p 0, i 0, i 0, i 0, i 0, i 0x37)'
  System::Call 'user32::RedrawWindow(p $R0, p 0, p 0, i 0x585)'

done:
  ; Shown now: bulwarkThemeHide made it see-through until here.
  !insertmacro bulwarkThemeShow
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  Pop $R8
  Pop $R9
FunctionEnd
!macroend

!ifndef BUILD_UNINSTALLER
  !insertmacro bulwarkThemeFunction ""

  Function bulwarkThemeGuiInit
    Push $0
    Push $1
    Push $2
    !insertmacro bulwarkThemeHide
    !insertmacro bulwarkThemeStatics
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd
  !define MUI_CUSTOMFUNCTION_GUIINIT bulwarkThemeGuiInit

  ; electron-builder's "is the app running" check comes right after the banner is up: this
  ; draws the window there, then runs the same check as the template does without it.
  ; electron-builder only includes getProcessInfo.nsh and declares $pid when no
  ; customCheckAppRunning is defined, so it's done here.
  !macro customCheckAppRunning
    ${IfNot} ${Silent}
      !ifdef RUN_AFTER_FINISH
        ${If} ${isUpdated}
          Push "$(bulwarkRestartsAfter)"
          Push "$(bulwarkUpdating)"
        ${Else}
          Push "$(bulwarkOpensAfter)"
          Push "$(bulwarkInstalling)"
        ${EndIf}
      !else
        Push ""
        ${If} ${isUpdated}
          Push "$(bulwarkUpdating)"
        ${Else}
          Push "$(bulwarkInstalling)"
        ${EndIf}
      !endif
      Call bulwarkThemeWindow
    ${EndIf}
    !insertmacro IS_POWERSHELL_AVAILABLE
    !insertmacro _CHECK_APP_RUNNING
  !macroend
!else
  !insertmacro bulwarkThemeFunction "un."

  Function un.bulwarkThemeGuiInit
    Push $0
    Push $1
    Push $2
    !insertmacro bulwarkThemeHide
    !insertmacro bulwarkThemeStatics
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.bulwarkThemeGuiInit

  ; Started without /S, the uninstaller's "Are you sure…?" is left out: the one-click
  ; installer asks nothing either, and Windows' Apps page has just asked the same. The
  ; template asks it in un.onInit only when not silent, and the first thing un.onInit runs
  ; is ${LogSet}, so un.onInit's ${LogSet} turns silent on for a moment. Not SilentUnInstall:
  ; with it makensis leaves out the uninstaller's window.
  !macro bulwarkLogSet SETTING
    !insertmacro LogSetMacro ${SETTING}
    !ifdef __UNINSTALL__
      !if "${__FUNCTION__}" == "onInit"
        Push $R0
        Push $R1
        ${GetParameters} $R0
        ClearErrors
        ${GetOptions} $R0 "/S" $R1
        ${If} ${Errors}
          SetSilent silent
        ${EndIf}
        Pop $R1
        Pop $R0
      !endif
    !endif
  !macroend
  ; After common.nsh, which defines ${LogSet}, and before uninstaller.nsh, which uses it.
  !macro customHeader
    !undef LogSet
    !define LogSet "!insertmacro bulwarkLogSet"
  !macroend

  ; The same check in the uninstaller. It runs right where the question was, and started
  ; without /S it's out of silent again, so a running Bulwark is still asked about first.
  !macro customCheckAppRunning
    Push $R0
    Push $R1
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/S" $R1
    ${If} ${Errors}
      SetSilent normal
    ${EndIf}
    Pop $R1
    Pop $R0
    !insertmacro IS_POWERSHELL_AVAILABLE
    !insertmacro _CHECK_APP_RUNNING
  !macroend

  ; electron-builder's one-click uninstaller goes silent after its check. Started by a person,
  ; it shows the window instead. With /S (updates, scripts) it stays silent.
  !macro customUnInit
    Push $R0
    Push $R1
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/S" $R1
    ${If} ${Errors}
      SetSilent normal
    ${EndIf}
    Pop $R1
    Pop $R0
  !macroend

  ; From customUnInstall, which runs first in the uninstall section, with the page up.
  !macro bulwarkThemeUninstallerPage
    ${IfNot} ${Silent}
      Push ""
      Push "$(bulwarkRemoving)"
      Call un.bulwarkThemeWindow
    ${EndIf}
  !macroend
!endif

!include "getProcessInfo.nsh"
Var pid

!endif
