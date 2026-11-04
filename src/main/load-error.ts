/**
 * The page a window shows when an organisation's server doesn't load, in place of an empty
 * window. Two buttons: try again, and change the connection.
 *
 * The page has no script, and its buttons are links. "Try again" is a link to the server, which
 * the window's guards allow anyway. "Change connection…" is a link to an address on the server
 * with a random value in it, which main stops in will-navigate and acts on, but only while the
 * window shows this page: a web page can't take a window to a data: address, and only main
 * loads this one. (A data: page can't navigate to its own #fragment, so that's no way.)
 * The text is in the webmail's 30 languages, since this shows when the webmail didn't run.
 * No Electron in this file, so plain Node tests read it.
 */

export interface LoadErrorText {
  title: string;
  /** Takes {host}. */
  body: string;
  tryAgain: string;
  change: string;
}

export const LOAD_ERROR_TEXT: Record<string, LoadErrorText> = {
  en: {
    title: "Bulwark can't reach your organisation's server",
    body: "{host} isn't answering, or its connection isn't safe. Check your internet connection and try again. If it keeps happening, ask your organisation.",
    tryAgain: 'Try again',
    change: 'Change connection…',
  },
  de: {
    title: 'Bulwark erreicht den Server Ihrer Organisation nicht',
    body: '{host} antwortet nicht, oder die Verbindung ist nicht sicher. Prüfen Sie Ihre Internetverbindung und versuchen Sie es erneut. Passiert das weiterhin, fragen Sie Ihre Organisation.',
    tryAgain: 'Erneut versuchen',
    change: 'Verbindung ändern…',
  },
  fr: {
    title: 'Bulwark ne parvient pas à joindre le serveur de votre organisation',
    body: "{host} ne répond pas, ou sa connexion n'est pas sûre. Vérifiez votre connexion internet et réessayez. Si le problème persiste, contactez votre organisation.",
    tryAgain: 'Réessayer',
    change: 'Changer de connexion…',
  },
  es: {
    title: 'Bulwark no puede conectar con el servidor de tu organización',
    body: '{host} no responde o su conexión no es segura. Comprueba tu conexión a internet y vuelve a intentarlo. Si sigue pasando, pregunta a tu organización.',
    tryAgain: 'Reintentar',
    change: 'Cambiar de conexión…',
  },
  it: {
    title: 'Bulwark non riesce a raggiungere il server della tua organizzazione',
    body: '{host} non risponde, oppure la sua connessione non è sicura. Controlla la connessione a internet e riprova. Se succede ancora, chiedi alla tua organizzazione.',
    tryAgain: 'Riprova',
    change: 'Cambia connessione…',
  },
  pt: {
    title: 'O Bulwark não consegue contactar o servidor da sua organização',
    body: '{host} não responde ou a ligação não é segura. Verifique a sua ligação à internet e tente novamente. Se continuar a acontecer, pergunte à sua organização.',
    tryAgain: 'Tentar novamente',
    change: 'Mudar de ligação…',
  },
  nl: {
    title: 'Bulwark kan de server van uw organisatie niet bereiken',
    body: '{host} reageert niet, of de verbinding is niet veilig. Controleer uw internetverbinding en probeer het opnieuw. Blijft dit gebeuren, vraag het dan aan uw organisatie.',
    tryAgain: 'Opnieuw proberen',
    change: 'Verbinding wijzigen…',
  },
  ca: {
    title: 'Bulwark no pot connectar amb el servidor de la vostra organització',
    body: "{host} no respon o la connexió no és segura. Comproveu la connexió a internet i torneu-ho a provar. Si continua passant, pregunteu a la vostra organització.",
    tryAgain: 'Torneu-ho a provar',
    change: 'Canvia de connexió…',
  },
  cs: {
    title: 'Bulwark se nemůže spojit se serverem vaší organizace',
    body: '{host} neodpovídá nebo jeho připojení není bezpečné. Zkontrolujte připojení k internetu a zkuste to znovu. Pokud se to opakuje, obraťte se na svou organizaci.',
    tryAgain: 'Zkusit znovu',
    change: 'Změnit připojení…',
  },
  da: {
    title: 'Bulwark kan ikke nå din organisations server',
    body: '{host} svarer ikke, eller forbindelsen er ikke sikker. Tjek din internetforbindelse, og prøv igen. Hvis det bliver ved, så spørg din organisation.',
    tryAgain: 'Prøv igen',
    change: 'Skift forbindelse…',
  },
  et: {
    title: 'Bulwark ei jõua teie organisatsiooni serverini',
    body: '{host} ei vasta või selle ühendus pole turvaline. Kontrollige internetiühendust ja proovige uuesti. Kui see kordub, küsige oma organisatsioonilt.',
    tryAgain: 'Proovi uuesti',
    change: 'Vaheta ühendust…',
  },
  nb: {
    title: 'Bulwark når ikke serveren til organisasjonen din',
    body: '{host} svarer ikke, eller tilkoblingen er ikke sikker. Sjekk internettilkoblingen og prøv igjen. Hvis det fortsetter, spør organisasjonen din.',
    tryAgain: 'Prøv igjen',
    change: 'Bytt tilkobling…',
  },
  pl: {
    title: 'Bulwark nie może połączyć się z serwerem Twojej organizacji',
    body: '{host} nie odpowiada lub połączenie nie jest bezpieczne. Sprawdź połączenie z internetem i spróbuj ponownie. Jeśli to się powtarza, zapytaj swoją organizację.',
    tryAgain: 'Spróbuj ponownie',
    change: 'Zmień połączenie…',
  },
  sk: {
    title: 'Bulwark sa nemôže spojiť so serverom vašej organizácie',
    body: '{host} neodpovedá alebo jeho pripojenie nie je bezpečné. Skontrolujte pripojenie k internetu a skúste to znova. Ak sa to opakuje, obráťte sa na svoju organizáciu.',
    tryAgain: 'Skúsiť znova',
    change: 'Zmeniť pripojenie…',
  },
  hu: {
    title: 'A Bulwark nem éri el a szervezete szerverét',
    body: '{host} nem válaszol, vagy a kapcsolata nem biztonságos. Ellenőrizze az internetkapcsolatot, és próbálja újra. Ha ez továbbra is előfordul, kérdezze meg a szervezetét.',
    tryAgain: 'Újrapróbálás',
    change: 'Kapcsolat váltása…',
  },
  ro: {
    title: 'Bulwark nu poate contacta serverul organizației',
    body: '{host} nu răspunde sau conexiunea nu este sigură. Verificați conexiunea la internet și încercați din nou. Dacă se repetă, întrebați organizația.',
    tryAgain: 'Încercați din nou',
    change: 'Schimbare conexiune…',
  },
  tr: {
    title: 'Bulwark kuruluşunuzun sunucusuna ulaşamıyor',
    body: '{host} yanıt vermiyor ya da bağlantısı güvenli değil. İnternet bağlantınızı kontrol edip yeniden deneyin. Sorun sürerse kuruluşunuza danışın.',
    tryAgain: 'Yeniden dene',
    change: 'Bağlantıyı Değiştir…',
  },
  lv: {
    title: 'Bulwark nevar sasniegt jūsu organizācijas serveri',
    body: '{host} neatbild, vai tā savienojums nav drošs. Pārbaudiet interneta savienojumu un mēģiniet vēlreiz. Ja tas atkārtojas, jautājiet savai organizācijai.',
    tryAgain: 'Mēģināt vēlreiz',
    change: 'Mainīt savienojumu…',
  },
  ru: {
    title: 'Bulwark не может связаться с сервером вашей организации',
    body: '{host} не отвечает, или соединение с ним небезопасно. Проверьте подключение к интернету и попробуйте ещё раз. Если это повторяется, обратитесь в свою организацию.',
    tryAgain: 'Повторить',
    change: 'Сменить подключение…',
  },
  uk: {
    title: 'Bulwark не може зв’язатися із сервером вашої організації',
    body: '{host} не відповідає, або з’єднання з ним небезпечне. Перевірте підключення до інтернету та спробуйте ще раз. Якщо це повторюється, зверніться до своєї організації.',
    tryAgain: 'Спробувати ще раз',
    change: 'Змінити підключення…',
  },
  mn: {
    title: 'Bulwark танай байгууллагын серверт хүрч чадахгүй байна',
    body: '{host} хариу өгөхгүй байна, эсвэл холболт нь аюулгүй биш байна. Интернэт холболтоо шалгаад дахин оролдоно уу. Дахин давтагдвал байгууллагаасаа асуугаарай.',
    tryAgain: 'Дахин оролдох',
    change: 'Холболт солих…',
  },
  ar: {
    title: 'لا يستطيع Bulwark الوصول إلى خادم مؤسستك',
    body: '{host} لا يستجيب، أو أن الاتصال به غير آمن. تحقّق من اتصالك بالإنترنت وحاول مرة أخرى. إذا تكرّر ذلك، فاسأل مؤسستك.',
    tryAgain: 'إعادة المحاولة',
    change: 'تغيير الاتصال…',
  },
  fa: {
    title: 'Bulwark نمی‌تواند به سرور سازمان شما دسترسی پیدا کند',
    body: '{host} پاسخ نمی‌دهد یا اتصال آن امن نیست. اتصال اینترنت خود را بررسی کنید و دوباره امتحان کنید. اگر باز هم تکرار شد، از سازمان خود بپرسید.',
    tryAgain: 'تلاش دوباره',
    change: 'تغییر اتصال…',
  },
  he: {
    title: 'Bulwark לא מצליח להגיע לשרת של הארגון שלך',
    body: '{host} לא עונה, או שהחיבור אליו אינו מאובטח. יש לבדוק את החיבור לאינטרנט ולנסות שוב. אם זה חוזר, יש לפנות לארגון שלך.',
    tryAgain: 'ניסיון חוזר',
    change: 'שינוי חיבור…',
  },
  ja: {
    title: 'Bulwark が組織のサーバーに接続できません',
    body: '{host} が応答しないか、接続が安全ではありません。インターネット接続を確認して、もう一度お試しください。繰り返し起きる場合は、組織にお問い合わせください。',
    tryAgain: '再試行',
    change: '接続を変更…',
  },
  ko: {
    title: 'Bulwark가 조직의 서버에 연결할 수 없습니다',
    body: '{host}이(가) 응답하지 않거나 연결이 안전하지 않습니다. 인터넷 연결을 확인하고 다시 시도하세요. 계속 발생하면 조직에 문의하세요.',
    tryAgain: '다시 시도',
    change: '연결 변경…',
  },
  th: {
    title: 'Bulwark เชื่อมต่อเซิร์ฟเวอร์ขององค์กรคุณไม่ได้',
    body: '{host} ไม่ตอบสนอง หรือการเชื่อมต่อไม่ปลอดภัย ตรวจสอบการเชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง หากยังเกิดขึ้นอีก โปรดสอบถามองค์กรของคุณ',
    tryAgain: 'ลองอีกครั้ง',
    change: 'เปลี่ยนการเชื่อมต่อ…',
  },
  vi: {
    title: 'Bulwark không kết nối được với máy chủ của tổ chức bạn',
    body: '{host} không phản hồi, hoặc kết nối không an toàn. Hãy kiểm tra kết nối Internet rồi thử lại. Nếu vẫn xảy ra, hãy hỏi tổ chức của bạn.',
    tryAgain: 'Thử lại',
    change: 'Đổi kết nối…',
  },
  zh: {
    title: 'Bulwark 无法连接到您所在组织的服务器',
    body: '{host} 没有响应，或者连接不安全。请检查网络连接后重试。如果问题持续，请联系您的组织。',
    tryAgain: '重试',
    change: '更改连接…',
  },
  'zh-TW': {
    title: 'Bulwark 無法連線到您組織的伺服器',
    body: '{host} 沒有回應，或連線不安全。請檢查網路連線後再試一次。如果問題持續發生，請洽詢您的組織。',
    tryAgain: '再試一次',
    change: '變更連線…',
  },
};

const RTL = new Set(['ar', 'fa', 'he']);

function languageFor(language: string): string {
  const lower = language.toLowerCase();
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-mo' || lower.startsWith('zh-hant')) return 'zh-TW';
  const base = lower.split(/[-_]/)[0];
  if (base === 'no' || base === 'nn') return 'nb';
  return Object.hasOwn(LOAD_ERROR_TEXT, base) ? base : 'en';
}

export function loadErrorTextFor(language: string): LoadErrorText {
  return LOAD_ERROR_TEXT[languageFor(language)];
}

/** -3 is a load replaced by another one, the app's own included. A frame's failure is the page's to show. */
export function showsLoadError(code: number, isMainFrame: boolean): boolean {
  return isMainFrame && code !== -3;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The address behind "Change connection…": on the server, so the guards let it through to main's check, and not to be guessed. */
export function changeConnectionUrl(origin: string, nonce: string): string {
  return `${origin}/?bulwark-change-connection=${encodeURIComponent(nonce)}`;
}

/**
 * The page as a data: address. `retryUrl` is on the server. Without a `changeUrl`, no
 * "Change connection…": the user can't change it.
 */
export function loadErrorPage(language: string, host: string, retryUrl: string, changeUrl: string | null): string {
  const code = languageFor(language);
  const text = LOAD_ERROR_TEXT[code];
  const button = (id: string, href: string, label: string, primary: boolean) => `<a href="${escapeHtml(href)}" id="${id}"${primary ? ' class="primary"' : ''}>${escapeHtml(label)}</a>`;
  const style = [
    ':root{color-scheme:light dark}',
    'html,body{height:100%}',
    'body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;background:Canvas;color:CanvasText;user-select:none;cursor:default}',
    // The window may have no frame: its top row is where it's dragged.
    'header{position:fixed;inset:0 0 auto 0;height:40px;-webkit-app-region:drag}',
    'main{max-width:34em;padding:2em}',
    'h1{font-size:1.3em;font-weight:600;margin:0 0 8px}',
    'p{margin:0 0 20px;opacity:.8}',
    '.actions{display:flex;gap:10px;flex-wrap:wrap}',
    'a{font:inherit;color:inherit;text-decoration:none;padding:8px 18px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 30%,transparent);-webkit-user-drag:none}',
    'a:hover{background:color-mix(in srgb,currentColor 8%,transparent)}',
    'a:focus-visible{outline:2px solid Highlight;outline-offset:2px}',
    'a.primary{background:color-mix(in srgb,currentColor 12%,transparent)}',
  ].join('');
  const buttons = button('retry', retryUrl, text.tryAgain, true) + (changeUrl ? button('change', changeUrl, text.change, false) : '');
  const html = `<!doctype html><html lang="${code}" dir="${RTL.has(code) ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(text.title)}</title><style>${style}</style></head><body><header></header><main><h1>${escapeHtml(text.title)}</h1><p>${escapeHtml(text.body.replaceAll('{host}', host))}</p><div class="actions">${buttons}</div></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** Where "Try again" goes: the failed address on the server, or its start page for one elsewhere (a sign-in provider's). */
export function retryTarget(failedUrl: string, origin: string, startUrl: string): string {
  try {
    return new URL(failedUrl).origin === origin ? failedUrl : startUrl;
  } catch {
    return startUrl;
  }
}

/**
 * The error page each window shows now. The tray's retry (os-resilience.ts) keeps going while
 * it's there, as it does for Chromium's own error page.
 */
const shownPages = new WeakMap<object, string>();

export function noteLoadErrorPage(contents: object, url: string | null): void {
  if (url) shownPages.set(contents, url);
  else shownPages.delete(contents);
}

export function showsLoadErrorPage(contents: object, currentUrl: string): boolean {
  const page = shownPages.get(contents);
  return !!page && currentUrl === page;
}
