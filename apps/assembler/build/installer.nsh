; Himmel:CAD Assembler NSIS hooks (electron-builder `nsis.include`).
; electron-builder's uninstaller removes the ProgId but leaves the `.hcasm`
; extension key pointing at it; remove the key while it still names ours.
!macro customUnInstall
  ReadRegStr $0 SHCTX "Software\Classes\.hcasm" ""
  StrCmp $0 "HimmelCAD Assembler Project" 0 +2
    DeleteRegKey SHCTX "Software\Classes\.hcasm"
!macroend