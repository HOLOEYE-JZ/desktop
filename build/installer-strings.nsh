; What the installer window says, in each language the installer has (installerLanguages in
; electron-builder.yml). The numbers are the language ids of NSIS's language files. Saved as
; UTF-8 with a byte order mark, so makensis reads it as UTF-8 whatever the code page.
;
;   bulwarkInstalling   installing, the first time or again
;   bulwarkUpdating     an update from the app (--updated)
;   bulwarkRemoving     the uninstaller
;   bulwarkOpensAfter   under the first: the installer starts the app when it's done
;   bulwarkRestartsAfter  under the second

; English
LangString bulwarkInstalling 1033 "Installing ${PRODUCT_NAME}…"
LangString bulwarkUpdating 1033 "Updating ${PRODUCT_NAME}…"
LangString bulwarkRemoving 1033 "Removing ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 1033 "${PRODUCT_NAME} opens once it's installed."
LangString bulwarkRestartsAfter 1033 "${PRODUCT_NAME} restarts once it's updated."

; German
LangString bulwarkInstalling 1031 "${PRODUCT_NAME} wird installiert…"
LangString bulwarkUpdating 1031 "${PRODUCT_NAME} wird aktualisiert…"
LangString bulwarkRemoving 1031 "${PRODUCT_NAME} wird deinstalliert…"
LangString bulwarkOpensAfter 1031 "${PRODUCT_NAME} wird danach geöffnet."
LangString bulwarkRestartsAfter 1031 "${PRODUCT_NAME} wird danach neu gestartet."

; French
LangString bulwarkInstalling 1036 "Installation de ${PRODUCT_NAME}…"
LangString bulwarkUpdating 1036 "Mise à jour de ${PRODUCT_NAME}…"
LangString bulwarkRemoving 1036 "Désinstallation de ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 1036 "${PRODUCT_NAME} s’ouvrira une fois installé."
LangString bulwarkRestartsAfter 1036 "${PRODUCT_NAME} redémarrera une fois mis à jour."

; Spanish
LangString bulwarkInstalling 3082 "Instalando ${PRODUCT_NAME}…"
LangString bulwarkUpdating 3082 "Actualizando ${PRODUCT_NAME}…"
LangString bulwarkRemoving 3082 "Desinstalando ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 3082 "${PRODUCT_NAME} se abrirá cuando termine la instalación."
LangString bulwarkRestartsAfter 3082 "${PRODUCT_NAME} se reiniciará cuando termine la actualización."

; Chinese (Simplified)
LangString bulwarkInstalling 2052 "正在安装 ${PRODUCT_NAME}…"
LangString bulwarkUpdating 2052 "正在更新 ${PRODUCT_NAME}…"
LangString bulwarkRemoving 2052 "正在卸载 ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 2052 "安装完成后将打开 ${PRODUCT_NAME}。"
LangString bulwarkRestartsAfter 2052 "更新完成后将重新启动 ${PRODUCT_NAME}。"

; Chinese (Traditional)
LangString bulwarkInstalling 1028 "正在安裝 ${PRODUCT_NAME}…"
LangString bulwarkUpdating 1028 "正在更新 ${PRODUCT_NAME}…"
LangString bulwarkRemoving 1028 "正在解除安裝 ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 1028 "安裝完成後將開啟 ${PRODUCT_NAME}。"
LangString bulwarkRestartsAfter 1028 "更新完成後將重新啟動 ${PRODUCT_NAME}。"

; Japanese
LangString bulwarkInstalling 1041 "${PRODUCT_NAME} をインストールしています…"
LangString bulwarkUpdating 1041 "${PRODUCT_NAME} を更新しています…"
LangString bulwarkRemoving 1041 "${PRODUCT_NAME} をアンインストールしています…"
LangString bulwarkOpensAfter 1041 "インストールが終わると ${PRODUCT_NAME} が開きます。"
LangString bulwarkRestartsAfter 1041 "更新が終わると ${PRODUCT_NAME} が再起動します。"

; Korean
LangString bulwarkInstalling 1042 "${PRODUCT_NAME} 설치 중…"
LangString bulwarkUpdating 1042 "${PRODUCT_NAME} 업데이트 중…"
LangString bulwarkRemoving 1042 "${PRODUCT_NAME} 제거 중…"
LangString bulwarkOpensAfter 1042 "설치가 끝나면 ${PRODUCT_NAME}이(가) 열립니다."
LangString bulwarkRestartsAfter 1042 "업데이트가 끝나면 ${PRODUCT_NAME}이(가) 다시 시작됩니다."

; Italian
LangString bulwarkInstalling 1040 "Installazione di ${PRODUCT_NAME}…"
LangString bulwarkUpdating 1040 "Aggiornamento di ${PRODUCT_NAME}…"
LangString bulwarkRemoving 1040 "Disinstallazione di ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 1040 "${PRODUCT_NAME} si aprirà al termine dell’installazione."
LangString bulwarkRestartsAfter 1040 "${PRODUCT_NAME} si riavvierà al termine dell’aggiornamento."

; Dutch
LangString bulwarkInstalling 1043 "${PRODUCT_NAME} wordt geïnstalleerd…"
LangString bulwarkUpdating 1043 "${PRODUCT_NAME} wordt bijgewerkt…"
LangString bulwarkRemoving 1043 "${PRODUCT_NAME} wordt verwijderd…"
LangString bulwarkOpensAfter 1043 "${PRODUCT_NAME} wordt daarna geopend."
LangString bulwarkRestartsAfter 1043 "${PRODUCT_NAME} wordt daarna opnieuw gestart."

; Danish
LangString bulwarkInstalling 1030 "Installerer ${PRODUCT_NAME}…"
LangString bulwarkUpdating 1030 "Opdaterer ${PRODUCT_NAME}…"
LangString bulwarkRemoving 1030 "Afinstallerer ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 1030 "${PRODUCT_NAME} åbnes, når installationen er færdig."
LangString bulwarkRestartsAfter 1030 "${PRODUCT_NAME} genstartes, når opdateringen er færdig."

; Swedish
LangString bulwarkInstalling 1053 "Installerar ${PRODUCT_NAME}…"
LangString bulwarkUpdating 1053 "Uppdaterar ${PRODUCT_NAME}…"
LangString bulwarkRemoving 1053 "Avinstallerar ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 1053 "${PRODUCT_NAME} öppnas när installationen är klar."
LangString bulwarkRestartsAfter 1053 "${PRODUCT_NAME} startas om när uppdateringen är klar."

; Norwegian (Bokmål)
LangString bulwarkInstalling 1044 "Installerer ${PRODUCT_NAME}…"
LangString bulwarkUpdating 1044 "Oppdaterer ${PRODUCT_NAME}…"
LangString bulwarkRemoving 1044 "Avinstallerer ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 1044 "${PRODUCT_NAME} åpnes når installasjonen er ferdig."
LangString bulwarkRestartsAfter 1044 "${PRODUCT_NAME} starter på nytt når oppdateringen er ferdig."

; Finnish
LangString bulwarkInstalling 1035 "Asennetaan sovellusta ${PRODUCT_NAME}…"
LangString bulwarkUpdating 1035 "Päivitetään sovellusta ${PRODUCT_NAME}…"
LangString bulwarkRemoving 1035 "Poistetaan sovellusta ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 1035 "${PRODUCT_NAME} avautuu, kun asennus on valmis."
LangString bulwarkRestartsAfter 1035 "${PRODUCT_NAME} käynnistyy uudelleen, kun päivitys on valmis."

; Russian
LangString bulwarkInstalling 1049 "Установка ${PRODUCT_NAME}…"
LangString bulwarkUpdating 1049 "Обновление ${PRODUCT_NAME}…"
LangString bulwarkRemoving 1049 "Удаление ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 1049 "${PRODUCT_NAME} откроется после установки."
LangString bulwarkRestartsAfter 1049 "${PRODUCT_NAME} перезапустится после обновления."

; Portuguese (Portugal)
LangString bulwarkInstalling 2070 "A instalar o ${PRODUCT_NAME}…"
LangString bulwarkUpdating 2070 "A atualizar o ${PRODUCT_NAME}…"
LangString bulwarkRemoving 2070 "A desinstalar o ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 2070 "O ${PRODUCT_NAME} abre quando a instalação terminar."
LangString bulwarkRestartsAfter 2070 "O ${PRODUCT_NAME} reinicia quando a atualização terminar."

; Portuguese (Brazil)
LangString bulwarkInstalling 1046 "Instalando o ${PRODUCT_NAME}…"
LangString bulwarkUpdating 1046 "Atualizando o ${PRODUCT_NAME}…"
LangString bulwarkRemoving 1046 "Desinstalando o ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 1046 "O ${PRODUCT_NAME} será aberto quando a instalação terminar."
LangString bulwarkRestartsAfter 1046 "O ${PRODUCT_NAME} será reiniciado quando a atualização terminar."

; Polish
LangString bulwarkInstalling 1045 "Instalowanie aplikacji ${PRODUCT_NAME}…"
LangString bulwarkUpdating 1045 "Aktualizowanie aplikacji ${PRODUCT_NAME}…"
LangString bulwarkRemoving 1045 "Odinstalowywanie aplikacji ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 1045 "Aplikacja ${PRODUCT_NAME} otworzy się po zakończeniu instalacji."
LangString bulwarkRestartsAfter 1045 "Aplikacja ${PRODUCT_NAME} uruchomi się ponownie po zakończeniu aktualizacji."

; Ukrainian
LangString bulwarkInstalling 1058 "Встановлення ${PRODUCT_NAME}…"
LangString bulwarkUpdating 1058 "Оновлення ${PRODUCT_NAME}…"
LangString bulwarkRemoving 1058 "Видалення ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 1058 "${PRODUCT_NAME} відкриється після встановлення."
LangString bulwarkRestartsAfter 1058 "${PRODUCT_NAME} перезапуститься після оновлення."

; Czech
LangString bulwarkInstalling 1029 "Instalace aplikace ${PRODUCT_NAME}…"
LangString bulwarkUpdating 1029 "Aktualizace aplikace ${PRODUCT_NAME}…"
LangString bulwarkRemoving 1029 "Odinstalace aplikace ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 1029 "Aplikace ${PRODUCT_NAME} se po instalaci otevře."
LangString bulwarkRestartsAfter 1029 "Aplikace ${PRODUCT_NAME} se po aktualizaci znovu spustí."

; Slovak
LangString bulwarkInstalling 1051 "Inštalácia aplikácie ${PRODUCT_NAME}…"
LangString bulwarkUpdating 1051 "Aktualizácia aplikácie ${PRODUCT_NAME}…"
LangString bulwarkRemoving 1051 "Odinštalovanie aplikácie ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 1051 "Aplikácia ${PRODUCT_NAME} sa po inštalácii otvorí."
LangString bulwarkRestartsAfter 1051 "Aplikácia ${PRODUCT_NAME} sa po aktualizácii znova spustí."

; Hungarian
LangString bulwarkInstalling 1038 "A(z) ${PRODUCT_NAME} telepítése…"
LangString bulwarkUpdating 1038 "A(z) ${PRODUCT_NAME} frissítése…"
LangString bulwarkRemoving 1038 "A(z) ${PRODUCT_NAME} eltávolítása…"
LangString bulwarkOpensAfter 1038 "A(z) ${PRODUCT_NAME} a telepítés után megnyílik."
LangString bulwarkRestartsAfter 1038 "A(z) ${PRODUCT_NAME} a frissítés után újraindul."

; Arabic
LangString bulwarkInstalling 1025 "جارٍ تثبيت ${PRODUCT_NAME}…"
LangString bulwarkUpdating 1025 "جارٍ تحديث ${PRODUCT_NAME}…"
LangString bulwarkRemoving 1025 "جارٍ إزالة ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 1025 "سيُفتح ${PRODUCT_NAME} بعد اكتمال التثبيت."
LangString bulwarkRestartsAfter 1025 "سيُعاد تشغيل ${PRODUCT_NAME} بعد اكتمال التحديث."

; Turkish
LangString bulwarkInstalling 1055 "${PRODUCT_NAME} yükleniyor…"
LangString bulwarkUpdating 1055 "${PRODUCT_NAME} güncelleniyor…"
LangString bulwarkRemoving 1055 "${PRODUCT_NAME} kaldırılıyor…"
LangString bulwarkOpensAfter 1055 "${PRODUCT_NAME}, yükleme bitince açılır."
LangString bulwarkRestartsAfter 1055 "${PRODUCT_NAME}, güncelleme bitince yeniden başlar."

; Thai
LangString bulwarkInstalling 1054 "กำลังติดตั้ง ${PRODUCT_NAME}…"
LangString bulwarkUpdating 1054 "กำลังอัปเดต ${PRODUCT_NAME}…"
LangString bulwarkRemoving 1054 "กำลังถอนการติดตั้ง ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 1054 "${PRODUCT_NAME} จะเปิดขึ้นเมื่อติดตั้งเสร็จ"
LangString bulwarkRestartsAfter 1054 "${PRODUCT_NAME} จะเริ่มใหม่เมื่ออัปเดตเสร็จ"

; Vietnamese
LangString bulwarkInstalling 1066 "Đang cài đặt ${PRODUCT_NAME}…"
LangString bulwarkUpdating 1066 "Đang cập nhật ${PRODUCT_NAME}…"
LangString bulwarkRemoving 1066 "Đang gỡ cài đặt ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 1066 "${PRODUCT_NAME} sẽ mở khi cài đặt xong."
LangString bulwarkRestartsAfter 1066 "${PRODUCT_NAME} sẽ khởi động lại khi cập nhật xong."

; Catalan
LangString bulwarkInstalling 1027 "S’està instal·lant ${PRODUCT_NAME}…"
LangString bulwarkUpdating 1027 "S’està actualitzant ${PRODUCT_NAME}…"
LangString bulwarkRemoving 1027 "S’està desinstal·lant ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 1027 "${PRODUCT_NAME} s’obrirà quan acabi la instal·lació."
LangString bulwarkRestartsAfter 1027 "${PRODUCT_NAME} es reiniciarà quan acabi l’actualització."

; Estonian
LangString bulwarkInstalling 1061 "Rakenduse ${PRODUCT_NAME} installimine…"
LangString bulwarkUpdating 1061 "Rakenduse ${PRODUCT_NAME} värskendamine…"
LangString bulwarkRemoving 1061 "Rakenduse ${PRODUCT_NAME} desinstallimine…"
LangString bulwarkOpensAfter 1061 "${PRODUCT_NAME} avaneb pärast installimist."
LangString bulwarkRestartsAfter 1061 "${PRODUCT_NAME} taaskäivitub pärast värskendamist."

; Hebrew
LangString bulwarkInstalling 1037 "מתקין את ${PRODUCT_NAME}…"
LangString bulwarkUpdating 1037 "מעדכן את ${PRODUCT_NAME}…"
LangString bulwarkRemoving 1037 "מסיר את ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 1037 "${PRODUCT_NAME} ייפתח בסיום ההתקנה."
LangString bulwarkRestartsAfter 1037 "${PRODUCT_NAME} יופעל מחדש בסיום העדכון."

; Latvian
LangString bulwarkInstalling 1062 "Notiek ${PRODUCT_NAME} instalēšana…"
LangString bulwarkUpdating 1062 "Notiek ${PRODUCT_NAME} atjaunināšana…"
LangString bulwarkRemoving 1062 "Notiek ${PRODUCT_NAME} atinstalēšana…"
LangString bulwarkOpensAfter 1062 "${PRODUCT_NAME} tiks atvērts pēc instalēšanas."
LangString bulwarkRestartsAfter 1062 "${PRODUCT_NAME} tiks restartēts pēc atjaunināšanas."

; Mongolian
LangString bulwarkInstalling 1104 "${PRODUCT_NAME}-г суулгаж байна…"
LangString bulwarkUpdating 1104 "${PRODUCT_NAME}-г шинэчилж байна…"
LangString bulwarkRemoving 1104 "${PRODUCT_NAME}-г устгаж байна…"
LangString bulwarkOpensAfter 1104 "Суулгаж дууссаны дараа ${PRODUCT_NAME} нээгдэнэ."
LangString bulwarkRestartsAfter 1104 "Шинэчилж дууссаны дараа ${PRODUCT_NAME} дахин эхэлнэ."

; Romanian
LangString bulwarkInstalling 1048 "Se instalează ${PRODUCT_NAME}…"
LangString bulwarkUpdating 1048 "Se actualizează ${PRODUCT_NAME}…"
LangString bulwarkRemoving 1048 "Se dezinstalează ${PRODUCT_NAME}…"
LangString bulwarkOpensAfter 1048 "${PRODUCT_NAME} se va deschide după instalare."
LangString bulwarkRestartsAfter 1048 "${PRODUCT_NAME} va reporni după actualizare."
