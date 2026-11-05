; The installer's window: a borderless square in Bulwark's colours, like the app's own splash.
; The logo, a heading, a short line under it, a rounded progress bar in the accent colour and
; the progress in percent. Dark or light as Windows' app mode is set (AppsUseLightTheme), light
; when that can't be read, Windows' own colours with High Contrast on. It can be dragged by any
; point, stays in the taskbar, and keeps its title for Alt+Tab.
;
;   installing     "Installing Bulwark…"  "Bulwark opens once it's installed."
;   --updated      "Updating Bulwark…"    "Bulwark restarts once it's updated."
;   uninstaller    "Removing Bulwark…"    "Your mail profile stays on this computer."
;
; Only the one-click installer, which is what electron-builder.yml builds. Its window is
; electron-builder's: the instfiles page with the SpiderBanner plugin's dialog on top. Once
; the banner is up, the BulwarkSplash plugin (native/nsis-splash, built into
; build/x86-unicode by scripts/build-nsis-splash.mjs) takes the window over and paints it
; itself. NSIS has no way to handle a window message from a script, and dragging, painting
; without flicker and a live percent all need one. The page's own progress bar stays,
; hidden: NSIS keeps moving it and the plugin reads it.
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
; 0: the window's own DPI. Tests set one to see a scale this screen doesn't have.
!ifndef BULWARK_THEME_DPI
  !define BULWARK_THEME_DPI 0
!endif

; Drawn at the screen's scale instead of stretched by Windows.
ManifestDPIAware true

!addplugindir /x86-unicode "${BULWARK_THEME_DIR}\x86-unicode"
!include "${BULWARK_THEME_DIR}\installer-strings.nsh"

; Until the window is drawn, it's see-through, so the plain one never flashes up: from
; .onGUIInit until the plugin has painted it. Uses $0 and $1.
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

; Push the line under the heading (or ""), then the heading, then call.
!macro bulwarkThemeFunction UN
Function ${UN}bulwarkThemeWindow
  Exch $R9
  Exch
  Exch $R8
  Push $0
  Push $1
  InitPluginsDir
  ; Every scale step from 100 to 250 % in it, so the logo is never scaled.
  File "/oname=$PLUGINSDIR\bulwark-installer-logo.ico" "${BULWARK_THEME_DIR}\installer-logo.ico"
  Push "${BULWARK_THEME_KEY}"
  Push "$(^RTL)"
  Push "${BULWARK_THEME_DPI}"
  Push "$PLUGINSDIR\bulwark-installer-logo.ico"
  Push "$(bulwarkPercent)"
  Push $R8
  Push $R9
  BulwarkSplash::Show
  Pop $0
  ${If} $0 != "ok"
    ; Not drawn: the window as electron-builder made it, rather than none.
    !insertmacro bulwarkThemeShow
  ${EndIf}
  Pop $1
  Pop $0
  Pop $R8
  Pop $R9
FunctionEnd

Function ${UN}bulwarkThemeGuiInit
  Push $0
  Push $1
  !insertmacro bulwarkThemeHide
  Pop $1
  Pop $0
FunctionEnd
!macroend

!ifndef BUILD_UNINSTALLER
  !insertmacro bulwarkThemeFunction ""
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

  ; From customUnInstall, which runs first in the uninstall section, with the page up. The
  ; profile stays unless --delete-app-data asks for it to go.
  !macro bulwarkThemeUninstallerPage
    ${IfNot} ${Silent}
      Push $R0
      Push $R1
      ${GetParameters} $R0
      ClearErrors
      ${GetOptions} $R0 "--delete-app-data" $R1
      ${If} ${Errors}
        StrCpy $R1 "$(bulwarkProfileStays)"
      ${Else}
        StrCpy $R1 ""
      ${EndIf}
      Push $R1
      Push "$(bulwarkRemoving)"
      Call un.bulwarkThemeWindow
      Pop $R1
      Pop $R0
    ${EndIf}
  !macroend
!endif

!include "getProcessInfo.nsh"
Var pid

!endif
