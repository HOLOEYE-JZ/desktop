; electron-builder's extractUsing7za (templates/nsis/include/extractAppPackage.nsh) with the
; changes installer-speed.nsh describes: the unpacking reports its progress to the window, and
; the unpacked files are moved into place where they can be. The retry loop and the copy after
; it are electron-builder's, for whatever didn't move.
;
; installer-theme.nsh includes this from customCheckAppRunning: electron-builder has defined
; the macro by then and uses it only later, in installApplicationFiles. A macro can't be
; defined inside another one, but an !include can be inserted. test/installer-look.spec.ts
; checks that electron-builder's own still looks the way this one copies it.

!macroundef extractUsing7za
!macro extractUsing7za FILE
  Push $OUTDIR
  CreateDirectory "$PLUGINSDIR\7z-out"
  ClearErrors
  SetOutPath "$PLUGINSDIR\7z-out"
  !insertmacro bulwarkThemeUnpackStep
  GetFunctionAddress $R9 bulwarkExtractProgress
  Nsis7z::ExtractWithCallback "${FILE}" $R9
  Pop $R0
  SetOutPath $R0

  !insertmacro bulwarkThemePlaceStep
  Push $OUTDIR
  Call bulwarkMoveExtracted
  Pop $R1
  StrCmp $R1 "0" DoneExtract7za

  # Retry counter
  StrCpy $R1 0

  LoopExtract7za:
    IntOp $R1 $R1 + 1

    # Attempt to copy files in atomic way
    CopyFiles /SILENT "$PLUGINSDIR\7z-out\*" $OUTDIR
    IfErrors 0 DoneExtract7za

    DetailPrint `Can't modify "${PRODUCT_NAME}"'s files.`
    ${if} $R1 < 5
      # Try copying a few times before asking for a user action.
      Goto RetryExtract7za
    ${else}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDRETRY IDCANCEL AbortExtract7za
    ${endIf}

    # As an absolutely last resort after a few automatic attempts and user
    # intervention - we will just overwrite everything with `Nsis7z::Extract`
    # even though it is not atomic and will ignore errors.

    # Clear the temporary folder first to make sure we don't use twice as
    # much disk space.
    RMDir /r "$PLUGINSDIR\7z-out"

    Nsis7z::Extract "${FILE}"
    Goto DoneExtract7za

  AbortExtract7za:
    Quit

  RetryExtract7za:
    Sleep 1000
    Goto LoopExtract7za

  DoneExtract7za:
!macroend
