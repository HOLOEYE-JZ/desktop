; What the app writes under HKCU at runtime (src/main/features/os-default-app.ts, os-toasts.ts)
; goes when the app is uninstalled. An update runs this too, with ${isUpdated} set: the app
; writes them again at its next start, but only a real uninstall should drop the login item.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\RegisteredApplications" "Bulwark"
    DeleteRegKey HKCU "Software\Bulwark"
    DeleteRegKey HKCU "Software\Classes\Bulwark.Url.mailto"
    DeleteRegKey HKCU "Software\Classes\Bulwark.Url.webcal"
    DeleteRegKey HKCU "Software\Classes\Bulwark.File.eml"
    DeleteRegKey HKCU "Software\Classes\Bulwark.File.ics"
    DeleteRegKey HKCU "Software\Classes\Bulwark.File.vcf"
    DeleteRegKey HKCU "Software\Classes\bulwark"
    DeleteRegValue HKCU "Software\Classes\.eml\OpenWithProgids" "Bulwark.File.eml"
    DeleteRegValue HKCU "Software\Classes\.ics\OpenWithProgids" "Bulwark.File.ics"
    DeleteRegValue HKCU "Software\Classes\.vcf\OpenWithProgids" "Bulwark.File.vcf"
    DeleteRegKey HKCU "Software\Classes\CLSID\{7B1E4F2A-93C6-4D0E-A5B8-2F6C1D9E3A47}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Bulwark"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Bulwark"
  ${endIf}
!macroend
