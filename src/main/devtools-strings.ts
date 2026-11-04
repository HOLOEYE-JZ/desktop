/**
 * The warning before developer tools come on, in the webmail's 30 languages. Kept here, not in
 * the labels a page sends (strings.ts, `shell.setLanguages`): a same-origin plugin can reach that
 * call, and could reword the very warning that asks whether it may read everything.
 * No Electron in this file, so plain Node tests read it.
 */

export interface DevToolsText {
  title: string;
  detail: string;
  turnOn: string;
  cancel: string;
}

export const DEVTOOLS_TEXT: Record<string, DevToolsText> = {
  en: {
    title: 'Turn on developer tools?',
    detail: 'Anyone at this keyboard can then open developer tools and read everything in the app: your mail, your contacts and the passwords the app holds in memory. Turn this on only while you need it. It turns off again when the app locks.',
    turnOn: 'Turn on',
    cancel: 'Cancel',
  },
  de: {
    title: 'Entwicklertools einschalten?',
    detail: 'Dann kann jeder an dieser Tastatur die Entwicklertools öffnen und alles in der App lesen: Ihre E-Mails, Ihre Kontakte und die Passwörter, die die App im Speicher hält. Schalten Sie das nur ein, solange Sie es brauchen. Es schaltet sich wieder aus, wenn die App gesperrt wird.',
    turnOn: 'Einschalten',
    cancel: 'Abbrechen',
  },
  fr: {
    title: 'Activer les outils de développement ?',
    detail: "Toute personne devant ce clavier pourra alors ouvrir les outils de développement et lire tout ce que contient l'app : vos e-mails, vos contacts et les mots de passe que l'app garde en mémoire. Activez-les seulement le temps nécessaire. Ils se désactivent quand l'app se verrouille.",
    turnOn: 'Activer',
    cancel: 'Annuler',
  },
  es: {
    title: '¿Activar las herramientas para desarrolladores?',
    detail: 'Cualquiera que use este teclado podrá abrirlas y leer todo lo que hay en la app: tu correo, tus contactos y las contraseñas que la app guarda en memoria. Actívalas solo mientras las necesites. Se desactivan al bloquearse la app.',
    turnOn: 'Activar',
    cancel: 'Cancelar',
  },
  it: {
    title: 'Attivare gli strumenti per sviluppatori?',
    detail: "Chiunque sia a questa tastiera potrà aprirli e leggere tutto ciò che c'è nell'app: la tua posta, i tuoi contatti e le password che l'app tiene in memoria. Attivali solo finché ti servono. Si disattivano quando l'app si blocca.",
    turnOn: 'Attiva',
    cancel: 'Annulla',
  },
  pt: {
    title: 'Ligar as ferramentas de programador?',
    detail: 'Qualquer pessoa neste teclado poderá abri-las e ler tudo o que está na app: o seu correio, os seus contactos e as palavras-passe que a app guarda na memória. Ligue-as só enquanto precisar. Desligam-se quando a app bloqueia.',
    turnOn: 'Ligar',
    cancel: 'Cancelar',
  },
  nl: {
    title: 'Ontwikkelaarstools aanzetten?',
    detail: 'Iedereen achter dit toetsenbord kan ze dan openen en alles in de app lezen: je mail, je contacten en de wachtwoorden die de app in het geheugen heeft. Zet dit alleen aan zolang je het nodig hebt. Het gaat weer uit als de app vergrendelt.',
    turnOn: 'Aanzetten',
    cancel: 'Annuleren',
  },
  ca: {
    title: 'Vols activar les eines per a desenvolupadors?',
    detail: "Qualsevol persona davant d'aquest teclat les podrà obrir i llegir tot el que hi ha a l'app: el teu correu, els teus contactes i les contrasenyes que l'app té a la memòria. Activa-les només mentre les necessitis. Es desactiven quan l'app es bloqueja.",
    turnOn: 'Activa',
    cancel: 'Cancel·la',
  },
  cs: {
    title: 'Zapnout nástroje pro vývojáře?',
    detail: 'Kdokoli u této klávesnice je pak může otevřít a číst vše v aplikaci: vaši poštu, kontakty a hesla, která aplikace drží v paměti. Zapněte je jen na dobu, kdy je potřebujete. Vypnou se, když se aplikace zamkne.',
    turnOn: 'Zapnout',
    cancel: 'Zrušit',
  },
  da: {
    title: 'Slå udviklerværktøjer til?',
    detail: 'Så kan alle ved dette tastatur åbne dem og læse alt i appen: din mail, dine kontakter og de adgangskoder, appen har i hukommelsen. Slå det kun til, mens du har brug for det. Det slås fra igen, når appen låses.',
    turnOn: 'Slå til',
    cancel: 'Annuller',
  },
  et: {
    title: 'Kas lülitada arendaja tööriistad sisse?',
    detail: 'Siis saab igaüks selle klaviatuuri taga need avada ja lugeda kõike rakenduses: sinu kirju, kontakte ja paroole, mida rakendus mälus hoiab. Lülita see sisse ainult nii kauaks, kui vaja. See lülitub välja, kui rakendus lukustub.',
    turnOn: 'Lülita sisse',
    cancel: 'Loobu',
  },
  nb: {
    title: 'Slå på utviklerverktøy?',
    detail: 'Da kan alle ved dette tastaturet åpne dem og lese alt i appen: e-posten din, kontaktene dine og passordene appen har i minnet. Slå dette på bare mens du trenger det. Det slås av igjen når appen låses.',
    turnOn: 'Slå på',
    cancel: 'Avbryt',
  },
  pl: {
    title: 'Włączyć narzędzia dla deweloperów?',
    detail: 'Każdy przy tej klawiaturze będzie mógł je otworzyć i przeczytać wszystko w aplikacji: Twoją pocztę, kontakty i hasła, które aplikacja trzyma w pamięci. Włącz je tylko na czas, gdy ich potrzebujesz. Wyłączą się, gdy aplikacja się zablokuje.',
    turnOn: 'Włącz',
    cancel: 'Anuluj',
  },
  sk: {
    title: 'Zapnúť nástroje pre vývojárov?',
    detail: 'Ktokoľvek pri tejto klávesnici ich potom môže otvoriť a čítať všetko v aplikácii: vašu poštu, kontakty a heslá, ktoré aplikácia drží v pamäti. Zapnite ich len na čas, keď ich potrebujete. Vypnú sa, keď sa aplikácia zamkne.',
    turnOn: 'Zapnúť',
    cancel: 'Zrušiť',
  },
  hu: {
    title: 'Bekapcsolja a fejlesztői eszközöket?',
    detail: 'Ezután bárki ennél a billentyűzetnél megnyithatja őket, és mindent elolvashat az alkalmazásban: a leveleit, a névjegyeit és a jelszavakat, amelyeket az alkalmazás a memóriában tart. Csak addig kapcsolja be, amíg szüksége van rá. Kikapcsol, amikor az alkalmazás zárolódik.',
    turnOn: 'Bekapcsolás',
    cancel: 'Mégse',
  },
  ro: {
    title: 'Porniți instrumentele pentru dezvoltatori?',
    detail: 'Oricine de la această tastatură le va putea deschide și va putea citi tot ce este în aplicație: e-mailurile, contactele și parolele pe care aplicația le ține în memorie. Porniți-le doar cât timp aveți nevoie. Se opresc când aplicația se blochează.',
    turnOn: 'Porniți',
    cancel: 'Anulați',
  },
  tr: {
    title: 'Geliştirici araçları açılsın mı?',
    detail: 'Bu klavyenin başındaki herkes onları açıp uygulamadaki her şeyi okuyabilir: e-postalarınızı, kişilerinizi ve uygulamanın bellekte tuttuğu parolaları. Yalnızca gerektiği sürece açın. Uygulama kilitlenince yeniden kapanır.',
    turnOn: 'Aç',
    cancel: 'İptal',
  },
  lv: {
    title: 'Ieslēgt izstrādātāju rīkus?',
    detail: 'Tad ikviens pie šīs tastatūras var tos atvērt un lasīt visu lietotnē: jūsu e-pastu, kontaktus un paroles, ko lietotne glabā atmiņā. Ieslēdziet to tikai uz laiku, kamēr vajag. Tas izslēdzas, kad lietotne tiek bloķēta.',
    turnOn: 'Ieslēgt',
    cancel: 'Atcelt',
  },
  ru: {
    title: 'Включить инструменты разработчика?',
    detail: 'Тогда любой, кто сидит за этой клавиатурой, сможет открыть их и прочитать всё в приложении: вашу почту, контакты и пароли, которые приложение хранит в памяти. Включайте их только на то время, пока они нужны. Они выключатся при блокировке приложения.',
    turnOn: 'Включить',
    cancel: 'Отмена',
  },
  uk: {
    title: 'Увімкнути інструменти розробника?',
    detail: 'Тоді будь-хто за цією клавіатурою зможе відкрити їх і прочитати все в застосунку: вашу пошту, контакти й паролі, які застосунок тримає в пам’яті. Вмикайте їх лише на той час, поки вони потрібні. Вони вимкнуться, коли застосунок заблокується.',
    turnOn: 'Увімкнути',
    cancel: 'Скасувати',
  },
  mn: {
    title: 'Хөгжүүлэгчийн хэрэгслийг асаах уу?',
    detail: 'Тэгвэл энэ гарын ард байгаа хэн ч тэдгээрийг нээж, апп доторх бүх зүйлийг унших боломжтой: таны и-мэйл, харилцагчид болон аппын санах ойд хадгалж буй нууц үгс. Зөвхөн хэрэгтэй үедээ асаана уу. Апп түгжигдэхэд дахин унтарна.',
    turnOn: 'Асаах',
    cancel: 'Цуцлах',
  },
  ar: {
    title: 'تشغيل أدوات المطورين؟',
    detail: 'عندها يستطيع أي شخص أمام لوحة المفاتيح هذه فتحها وقراءة كل ما في التطبيق: بريدك وجهات اتصالك وكلمات المرور التي يحتفظ بها التطبيق في الذاكرة. شغّلها فقط ما دمت تحتاج إليها. تتوقف مرة أخرى عند قفل التطبيق.',
    turnOn: 'تشغيل',
    cancel: 'إلغاء',
  },
  fa: {
    title: 'ابزارهای توسعه‌دهنده روشن شود؟',
    detail: 'در این صورت هر کسی پشت این صفحه‌کلید می‌تواند آن‌ها را باز کند و همه چیز برنامه را بخواند: ایمیل‌ها، مخاطبان و گذرواژه‌هایی که برنامه در حافظه نگه می‌دارد. فقط تا وقتی لازم دارید روشنش کنید. وقتی برنامه قفل شود دوباره خاموش می‌شود.',
    turnOn: 'روشن کردن',
    cancel: 'لغو',
  },
  he: {
    title: 'להפעיל את הכלים למפתחים?',
    detail: 'אז כל מי שיושב מול המקלדת הזו יוכל לפתוח אותם ולקרוא הכול באפליקציה: הדואר שלכם, אנשי הקשר והסיסמאות שהאפליקציה שומרת בזיכרון. הפעילו רק כל עוד צריך. זה נכבה שוב כשהאפליקציה ננעלת.',
    turnOn: 'הפעלה',
    cancel: 'ביטול',
  },
  ja: {
    title: 'デベロッパー ツールをオンにしますか？',
    detail: 'オンにすると、このキーボードを使う人なら誰でもデベロッパー ツールを開いて、アプリ内のすべてを読めるようになります。メール、連絡先、アプリがメモリに保持しているパスワードも含まれます。必要な間だけオンにしてください。アプリがロックされるとオフに戻ります。',
    turnOn: 'オンにする',
    cancel: 'キャンセル',
  },
  ko: {
    title: '개발자 도구를 켤까요?',
    detail: '켜면 이 키보드 앞에 있는 누구나 개발자 도구를 열어 앱의 모든 내용을 읽을 수 있습니다. 메일, 연락처, 앱이 메모리에 보관한 비밀번호도 포함됩니다. 필요한 동안에만 켜세요. 앱이 잠기면 다시 꺼집니다.',
    turnOn: '켜기',
    cancel: '취소',
  },
  th: {
    title: 'เปิดเครื่องมือสำหรับนักพัฒนาซอฟต์แวร์ไหม',
    detail: 'เมื่อเปิดแล้ว ใครก็ตามที่ใช้แป้นพิมพ์นี้จะเปิดเครื่องมือและอ่านทุกอย่างในแอปได้ ทั้งอีเมล รายชื่อติดต่อ และรหัสผ่านที่แอปเก็บไว้ในหน่วยความจำ เปิดเฉพาะเท่าที่จำเป็น และจะปิดอีกครั้งเมื่อแอปล็อก',
    turnOn: 'เปิด',
    cancel: 'ยกเลิก',
  },
  vi: {
    title: 'Bật công cụ cho nhà phát triển?',
    detail: 'Khi đó bất kỳ ai ngồi trước bàn phím này cũng có thể mở chúng và đọc mọi thứ trong ứng dụng: thư, danh bạ và mật khẩu mà ứng dụng giữ trong bộ nhớ. Chỉ bật khi bạn cần. Chúng sẽ tắt lại khi ứng dụng khóa.',
    turnOn: 'Bật',
    cancel: 'Hủy',
  },
  zh: {
    title: '要打开开发者工具吗？',
    detail: '打开后，任何使用这台键盘的人都能打开开发者工具，读取应用中的所有内容：您的邮件、联系人，以及应用在内存中保存的密码。请只在需要时打开。应用锁定时会再次关闭。',
    turnOn: '打开',
    cancel: '取消',
  },
  'zh-TW': {
    title: '要開啟開發人員工具嗎？',
    detail: '開啟後，任何使用這個鍵盤的人都能開啟開發人員工具，讀取應用程式中的所有內容：您的郵件、聯絡人，以及應用程式在記憶體中保存的密碼。請只在需要時開啟。應用程式鎖定時會再次關閉。',
    turnOn: '開啟',
    cancel: '取消',
  },
};

/** The language's own, or its region's, or English. */
export function devToolsTextFor(language: string): DevToolsText {
  const lower = language.toLowerCase();
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-mo' || lower.startsWith('zh-hant')) return DEVTOOLS_TEXT['zh-TW'];
  const base = lower.split(/[-_]/)[0];
  if (base === 'no' || base === 'nn') return DEVTOOLS_TEXT.nb;
  return Object.hasOwn(DEVTOOLS_TEXT, base) ? DEVTOOLS_TEXT[base] : DEVTOOLS_TEXT.en;
}
