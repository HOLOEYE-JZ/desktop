/*
 * BulwarkSplash: the Windows installer's window, as a small NSIS plugin.
 *
 * NSIS draws its windows with dialog controls and gives a script no way to handle a window
 * message, so a borderless window that can be dragged, paints itself without flicker and
 * shows the progress in percent needs a window procedure. This is that procedure. It takes
 * over electron-builder's installer window (the one-click instfiles page): hides every
 * control, takes away the caption, makes the window a 300 by 340 square in the middle of the
 * screen, and paints the logo, a heading, a line under it, a rounded progress bar, the
 * percent and what it's doing now.
 *
 * One bar for the whole run. NSIS's own bar can't be that: it restarts with each part (the
 * unpacking fills it, then the file copy fills it again) and an update runs the old
 * uninstaller first. So the script tells the window each step (WM_SPLASH_STEP): its share of
 * the bar, from and to in percent, how long it usually takes, and the line to show under the
 * bar. Inside a step the bar follows real progress where the script reports some
 * (WM_SPLASH_PROGRESS, the unpacking) and otherwise moves on with the time the step usually
 * takes, slowing down so it stops short of the step's end. It never goes back, and shows
 * 100 only once the script says it's done (a step from 100 to 100). Until the first step it
 * follows NSIS's bar, never back either.
 *
 * Nothing here takes part in what the installer does. build/installer-theme.nsh calls it,
 * scripts/build-nsis-splash.mjs builds it (32-bit, as NSIS is), electron-builder takes it
 * from build/x86-unicode.
 *
 *   BulwarkSplash::Show <heading> <line> <percent> <logo.ico> <dpi> <rtl> <theme key>
 *
 * <percent> has a # where the number goes ("# %", "#%"). <dpi> 0 is the window's own, a
 * number draws as if at that DPI (for screenshots). <theme key> is the HKCU key holding
 * AppsUseLightTheme. Puts "ok" or an error on the stack.
 *
 * Then, from the script, with SendMessage to $HWNDPARENT:
 *
 *   WM_SPLASH_STEP      wParam: from | to << 8 | tenths of a second << 16, lParam: "STR:<line>"
 *                       (an empty line keeps the one shown)
 *   WM_SPLASH_PROGRESS  wParam: done, lParam: total, in any one unit
 */

#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <commctrl.h>
#include <dwmapi.h>
#include <math.h>
#include <stdlib.h>
#include <tlhelp32.h>

/* The NSIS plugin interface, as in NSIS's pluginapi.h. */
typedef struct stack_t {
  struct stack_t *next;
  WCHAR text[1];
} stack_t;

typedef struct {
  int autoclose, all_user_var, exec_error, abort, exec_reboot, reboot_called, XXX_cur_insttype,
      plugin_api_version, silent, instdir_error, rtl, errlvl, alter_reg_view, status_update;
} exec_flags_t;

enum NSPIM { NSPIM_UNLOAD, NSPIM_GUIUNLOAD };
typedef UINT_PTR (*NSISPLUGINCALLBACK)(enum NSPIM);

typedef struct {
  exec_flags_t *exec_flags;
  int(__stdcall *ExecuteCodeSegment)(int, HWND);
  void(__stdcall *validate_filename)(LPWSTR);
  int(__stdcall *RegisterPluginCallback)(HMODULE, NSISPLUGINCALLBACK);
} extra_parameters;

#define TEXT_MAX 1024
#define WM_SPLASH_INIT (WM_APP + 0x42)
#define WM_SPLASH_STEP (WM_APP + 0x43)
#define WM_SPLASH_PROGRESS (WM_APP + 0x44)
#define TIMER_ID 0x4257
/* Without progress of its own, a step moves on with its usual time and stops at this share of it. */
#define STEP_CREEP_LIMIT 0.9
#define DIP_WIDTH 300
#define DIP_HEIGHT 340

static HINSTANCE g_module;

static struct {
  HWND window, bar;
  WNDPROC old;
  WCHAR heading[TEXT_MAX], line[TEXT_MAX], percent[64], logo[MAX_PATH], themeKey[512];
  int dpiOverride, rtl;
  int dpi, width, height;
  BOOL highContrast, dark, drawBorder;
  COLORREF bg, fg, muted, accent, track, border;
  HFONT headingFont, lineFont, percentFont;
  HICON icon;
  double shown;
  int shownPercent;
  /* The step the script said it's in. */
  BOOL stepped;
  WCHAR step[TEXT_MAX];
  double stepFrom, stepTo, stepMs, stepDone, stepTotal;
  ULONGLONG stepStarted;
} g;

static int Scale(int value) { return MulDiv(value, g.dpi, 96); }

static void PopString(stack_t **stacktop, WCHAR *out, int size) {
  out[0] = 0;
  if (!stacktop || !*stacktop) return;
  stack_t *top = *stacktop;
  lstrcpynW(out, top->text, size);
  *stacktop = top->next;
  GlobalFree((HGLOBAL)top);
}

static void PushString(stack_t **stacktop, const WCHAR *text, int stringSize) {
  if (!stacktop) return;
  stack_t *item = (stack_t *)GlobalAlloc(GPTR, sizeof(stack_t) + stringSize * sizeof(WCHAR));
  if (!item) return;
  lstrcpynW(item->text, text, stringSize);
  item->next = *stacktop;
  *stacktop = item;
}

static COLORREF Hex(DWORD rgb) { return RGB((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff); }

/* The app's colours (app/globals.css in the webmail), or Windows' with High Contrast on. */
static void LoadColours(void) {
  HIGHCONTRASTW contrast = { sizeof(contrast) };
  g.highContrast = SystemParametersInfoW(SPI_GETHIGHCONTRAST, sizeof(contrast), &contrast, 0) && (contrast.dwFlags & HCF_HIGHCONTRASTON);
  DWORD light = 1, size = sizeof(light);
  g.dark = !g.highContrast && RegGetValueW(HKEY_CURRENT_USER, g.themeKey, L"AppsUseLightTheme", RRF_RT_REG_DWORD, NULL, &light, &size) == ERROR_SUCCESS && light == 0;
  if (g.highContrast) {
    g.bg = GetSysColor(COLOR_WINDOW);
    g.fg = g.muted = g.border = GetSysColor(COLOR_WINDOWTEXT);
    g.accent = GetSysColor(COLOR_HIGHLIGHT);
    g.track = GetSysColor(COLOR_WINDOW);
  } else if (g.dark) {
    g.bg = Hex(0x0a0a0a);
    g.fg = Hex(0xfafafa);
    g.muted = Hex(0xadadad);
    g.accent = Hex(0x60a5fa);
    g.track = Hex(0x262626);
    g.border = Hex(0x2e2e2e);
  } else {
    g.bg = Hex(0xffffff);
    g.fg = Hex(0x0f172a);
    g.muted = Hex(0x59687c);
    g.accent = Hex(0x185aea);
    g.track = Hex(0xe2e8f0);
    g.border = Hex(0xe2e8f0);
  }
}

static HFONT Font(int px, int weight) {
  return CreateFontW(-Scale(px), 0, 0, 0, weight, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
}

static void LoadResources(void) {
  if (g.headingFont) DeleteObject(g.headingFont);
  if (g.lineFont) DeleteObject(g.lineFont);
  if (g.percentFont) DeleteObject(g.percentFont);
  if (g.icon) DestroyIcon(g.icon);
  g.headingFont = Font(18, FW_SEMIBOLD);
  g.lineFont = Font(13, FW_NORMAL);
  g.percentFont = Font(12, FW_NORMAL);
  /* At its exact size from the .ico, which has one for every scale step. */
  g.icon = (HICON)LoadImageW(NULL, g.logo, IMAGE_ICON, Scale(96), Scale(96), LR_LOADFROMFILE);
}

/* DWM: rounded corners and the border on Windows 11, a dark frame for the dark theme. */
static void ApplyFrame(void) {
  DWM_WINDOW_CORNER_PREFERENCE corner = DWMWCP_ROUND;
  g.drawBorder = FAILED(DwmSetWindowAttribute(g.window, DWMWA_WINDOW_CORNER_PREFERENCE, &corner, sizeof(corner)));
  if (!g.drawBorder) {
    COLORREF border = g.border;
    DwmSetWindowAttribute(g.window, DWMWA_BORDER_COLOR, &border, sizeof(border));
  }
  BOOL dark = g.dark;
  DwmSetWindowAttribute(g.window, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark, sizeof(dark));
}

static double Clamp01(double value) { return value < 0 ? 0 : value > 1 ? 1 : value; }

/* How much of a pixel a pill (a bar with round ends) covers, 4 by 4 samples. */
static double Coverage(double px, double py, double left, double top, double length, double height) {
  double r = height / 2, cy = top + r, a = left + r, b = left + length - r;
  if (b < a) b = a;
  int inside = 0;
  for (int sy = 0; sy < 4; sy++) {
    for (int sx = 0; sx < 4; sx++) {
      double x = px + (sx + 0.5) / 4, y = py + (sy + 0.5) / 4;
      double nearest = x < a ? a : x > b ? b : x;
      double dx = x - nearest, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) inside++;
    }
  }
  return inside / 16.0;
}

static BYTE Mix(BYTE from, BYTE to, double amount) { return (BYTE)(from + (to - from) * Clamp01(amount) + 0.5); }

static COLORREF Blend(COLORREF from, COLORREF to, double amount) {
  return RGB(Mix(GetRValue(from), GetRValue(to), amount), Mix(GetGValue(from), GetGValue(to), amount), Mix(GetBValue(from), GetBValue(to), amount));
}

/* The bar, smooth at the ends: drawn pixel by pixel, it's a few hundred of them. */
static void PaintBar(HDC dc, RECT box, double fraction) {
  int w = box.right - box.left, h = box.bottom - box.top;
  BITMAPINFO info = { { sizeof(BITMAPINFOHEADER), w, -h, 1, 32, BI_RGB } };
  void *bits = NULL;
  HBITMAP bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &bits, NULL, 0);
  if (!bitmap) return;
  DWORD *pixels = (DWORD *)bits;
  double fill = fraction <= 0 ? 0 : h + (w - h) * Clamp01(fraction);
  for (int y = 0; y < h; y++) {
    for (int x = 0; x < w; x++) {
      COLORREF colour = Blend(g.bg, g.track, Coverage(x, y, 0, 0, w, h));
      if (g.highContrast) colour = Blend(g.bg, g.fg, Coverage(x, y, 0, 0, w, h) - Coverage(x, y, 1, 1, w - 2, h - 2));
      /* It fills from the end a line starts at: the right, in right-to-left languages. */
      if (fill > 0) colour = Blend(colour, g.accent, Coverage(x, y, g.rtl ? w - fill : 0, 0, fill, h));
      pixels[y * w + x] = (GetRValue(colour) << 16) | (GetGValue(colour) << 8) | GetBValue(colour);
    }
  }
  HDC source = CreateCompatibleDC(dc);
  HGDIOBJ old = SelectObject(source, bitmap);
  BitBlt(dc, box.left, box.top, w, h, source, 0, 0, SRCCOPY);
  SelectObject(source, old);
  DeleteDC(source);
  DeleteObject(bitmap);
}

static int TextHeight(HDC dc, HFONT font, const WCHAR *text, int width, UINT flags) {
  if (!text[0]) return 0;
  RECT box = { 0, 0, width, 0 };
  HGDIOBJ old = SelectObject(dc, font);
  DrawTextW(dc, text, -1, &box, flags | DT_CALCRECT);
  SelectObject(dc, old);
  return box.bottom;
}

static void PercentText(WCHAR *out, int size, int value) {
  WCHAR number[16];
  wsprintfW(number, L"%d", value);
  int at = 0;
  for (const WCHAR *c = g.percent; *c && at < size - 16; c++) {
    if (*c == L'#') {
      for (const WCHAR *n = number; *n; n++) out[at++] = *n;
    } else {
      out[at++] = *c;
    }
  }
  out[at] = 0;
}

static void Paint(HWND window) {
  PAINTSTRUCT ps;
  HDC screen = BeginPaint(window, &ps);
  RECT client;
  GetClientRect(window, &client);
  int w = client.right, h = client.bottom;
  HDC dc = CreateCompatibleDC(screen);
  HBITMAP bitmap = CreateCompatibleBitmap(screen, w, h);
  HGDIOBJ oldBitmap = SelectObject(dc, bitmap);

  HBRUSH background = CreateSolidBrush(g.bg);
  FillRect(dc, &client, background);
  DeleteObject(background);
  SetBkMode(dc, TRANSPARENT);

  UINT flags = DT_CENTER | DT_WORDBREAK | DT_NOPREFIX | (g.rtl ? DT_RTLREADING : 0);
  int textWidth = w - 2 * Scale(20);
  int logo = Scale(96);
  int headingHeight = TextHeight(dc, g.headingFont, g.heading, textWidth, flags);
  int lineHeight = TextHeight(dc, g.lineFont, g.line, textWidth, flags);
  WCHAR percent[96];
  PercentText(percent, 96, g.shownPercent);
  int percentHeight = TextHeight(dc, g.percentFont, percent, textWidth, flags);
  /* What it's doing now: one line, cut short with an ellipsis rather than moving the rest. */
  UINT stepFlags = DT_CENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX | (g.rtl ? DT_RTLREADING : 0);
  int stepHeight = TextHeight(dc, g.percentFont, L"Ag", textWidth, stepFlags);
  int barHeight = Scale(6);

  /* Logo, 20, heading, 6, line, 24, bar, 10, percent, 4, step: centred as a block. The step's
     line is always counted, so the block doesn't move when the first step arrives. */
  int block = logo + Scale(20) + headingHeight + (lineHeight ? Scale(6) + lineHeight : 0) + Scale(24) + barHeight + Scale(10) + percentHeight + Scale(4) + stepHeight;
  int y = (h - block) / 2;
  if (g.icon) DrawIconEx(dc, (w - logo) / 2, y, g.icon, logo, logo, 0, NULL, DI_NORMAL);
  y += logo + Scale(20);

  RECT box = { (w - textWidth) / 2, y, (w + textWidth) / 2, y + headingHeight };
  SelectObject(dc, g.headingFont);
  SetTextColor(dc, g.fg);
  DrawTextW(dc, g.heading, -1, &box, flags);
  y += headingHeight;
  if (lineHeight) {
    y += Scale(6);
    RECT lineBox = { (w - textWidth) / 2, y, (w + textWidth) / 2, y + lineHeight };
    SelectObject(dc, g.lineFont);
    SetTextColor(dc, g.muted);
    DrawTextW(dc, g.line, -1, &lineBox, flags);
    y += lineHeight;
  }
  y += Scale(24);
  int barWidth = w - 2 * Scale(48);
  RECT bar = { (w - barWidth) / 2, y, (w + barWidth) / 2, y + barHeight };
  PaintBar(dc, bar, g.shown);
  y += barHeight + Scale(10);
  RECT percentBox = { (w - textWidth) / 2, y, (w + textWidth) / 2, y + percentHeight };
  SelectObject(dc, g.percentFont);
  SetTextColor(dc, g.muted);
  DrawTextW(dc, percent, -1, &percentBox, flags);
  y += percentHeight + Scale(4);
  if (g.step[0]) {
    RECT stepBox = { (w - textWidth) / 2, y, (w + textWidth) / 2, y + stepHeight };
    DrawTextW(dc, g.step, -1, &stepBox, stepFlags);
  }

  /* Windows 10 has no rounded corners or DWM border for this window: a 1 px line instead. */
  if (g.drawBorder || g.highContrast) {
    HBRUSH line = CreateSolidBrush(g.border);
    FrameRect(dc, &client, line);
    DeleteObject(line);
  }

  BitBlt(screen, 0, 0, w, h, dc, 0, 0, SRCCOPY);
  SelectObject(dc, oldBitmap);
  DeleteObject(bitmap);
  DeleteDC(dc);
  EndPaint(window, &ps);
}

/* Where the bar is headed: inside the script's step, or the hidden bar until the first step. */
static double Target(void) {
  if (g.stepped) {
    double f = 0;
    if (g.stepTotal > 0) {
      f = Clamp01(g.stepDone / g.stepTotal);
    } else if (g.stepMs > 0) {
      /* About 80 % of the step after its usual time, and never all of it. */
      double elapsed = (double)(GetTickCount64() - g.stepStarted);
      f = STEP_CREEP_LIMIT * (1 - exp(-2 * elapsed / g.stepMs));
    }
    return (g.stepFrom + (g.stepTo - g.stepFrom) * f) / 100;
  }
  if (!g.bar || !IsWindow(g.bar)) return g.shown;
  int pos = (int)SendMessageW(g.bar, PBM_GETPOS, 0, 0);
  int low = (int)SendMessageW(g.bar, PBM_GETRANGE, TRUE, 0);
  int high = (int)SendMessageW(g.bar, PBM_GETRANGE, FALSE, 0);
  return high > low ? Clamp01((double)(pos - low) / (high - low)) : 0;
}

/* Eased so it glides instead of jumping, and never back. */
static void Tick(HWND window) {
  double target = Target();
  if (target < g.shown) target = g.shown;
  double next = g.shown + (target - g.shown) * 0.35;
  if (target - next < 0.002) next = target;
  int percent = (int)floor(next * 100 + 1e-9);
  /* 100 only once the script says it's done: a step from 100. */
  if (percent > 99 && !(g.stepped && g.stepFrom >= 100)) percent = 99;
  if (next != g.shown || percent != g.shownPercent) {
    g.shown = next;
    g.shownPercent = percent;
    InvalidateRect(window, NULL, FALSE);
  }
  /* What the window says, for tests: the percent plus one, 0 before the first tick. */
  SetPropW(window, L"BulwarkSplashPercent", (HANDLE)(INT_PTR)(g.shownPercent + 1));
}

/* Runs on the window's own thread: the script calls Show from the install thread. */
static void Init(HWND window) {
  g.dpi = g.dpiOverride;
  if (!g.dpi) {
    HDC dc = GetDC(window);
    g.dpi = GetDeviceCaps(dc, LOGPIXELSY);
    ReleaseDC(window, dc);
  }
  LoadColours();
  LoadResources();

  /* Every control hidden. The page's progress bar keeps working: NSIS moves it, this reads it. */
  for (HWND child = GetWindow(window, GW_CHILD); child; child = GetWindow(child, GW_HWNDNEXT)) ShowWindow(child, SW_HIDE);

  /* No caption, no system buttons, no frame. Still in the taskbar, with its title for Alt+Tab. */
  LONG style = GetWindowLongW(window, GWL_STYLE);
  style &= ~(WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_THICKFRAME | WS_BORDER | WS_DLGFRAME);
  style |= WS_POPUP;
  SetWindowLongW(window, GWL_STYLE, style);
  LONG ex = GetWindowLongW(window, GWL_EXSTYLE);
  ex &= ~(WS_EX_DLGMODALFRAME | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE);
  ex |= WS_EX_APPWINDOW;
  SetWindowLongW(window, GWL_EXSTYLE, ex);

  g.width = Scale(DIP_WIDTH);
  g.height = Scale(DIP_HEIGHT);
  MONITORINFO monitor = { sizeof(monitor) };
  GetMonitorInfoW(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), &monitor);
  RECT work = monitor.rcWork;
  int x = work.left + (work.right - work.left - g.width) / 2;
  int y = work.top + (work.bottom - work.top - g.height) / 2;
  SetWindowPos(window, NULL, x, y, g.width, g.height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  ApplyFrame();

  g.shown = 0;
  g.shownPercent = 0;
  g.stepped = FALSE;
  g.step[0] = 0;
  Tick(window);
  SetTimer(window, TIMER_ID, 50, NULL);

  /* Painted first, then shown: the script made the window see-through until now. */
  RedrawWindow(window, NULL, NULL, RDW_INVALIDATE | RDW_UPDATENOW | RDW_FRAME);
  SetWindowLongW(window, GWL_EXSTYLE, GetWindowLongW(window, GWL_EXSTYLE) & ~WS_EX_LAYERED);
  RedrawWindow(window, NULL, NULL, RDW_INVALIDATE | RDW_UPDATENOW | RDW_FRAME | RDW_ALLCHILDREN);
}

static LRESULT CALLBACK Proc(HWND window, UINT message, WPARAM w, LPARAM l) {
  switch (message) {
    case WM_SPLASH_INIT:
      Init(window);
      return 0;
    case WM_SPLASH_STEP: {
      /* Sent from the install thread; the line is the script's, copied before this returns. */
      int from = (int)(w & 0xff), to = (int)((w >> 8) & 0xff);
      if (from > 100) from = 100;
      if (to > 100) to = 100;
      if (to < from) to = from;
      g.stepped = TRUE;
      g.stepFrom = from;
      g.stepTo = to;
      g.stepMs = (double)((w >> 16) & 0xffff) * 100;
      g.stepDone = 0;
      g.stepTotal = 0;
      g.stepStarted = GetTickCount64();
      const WCHAR *text = (const WCHAR *)l;
      if (text && text[0]) lstrcpynW(g.step, text, TEXT_MAX);
      /* For tests: the step's from and to, plus one. */
      SetPropW(window, L"BulwarkSplashStep", (HANDLE)(INT_PTR)((from | to << 8) + 1));
      Tick(window);
      InvalidateRect(window, NULL, FALSE);
      return 0;
    }
    case WM_SPLASH_PROGRESS:
      g.stepDone = (double)(ULONG_PTR)w;
      g.stepTotal = (double)(ULONG_PTR)l;
      return 0;
    case WM_NCHITTEST: {
      /* Dragged by any point of it. */
      LRESULT hit = CallWindowProcW(g.old, window, message, w, l);
      return hit == HTCLIENT ? HTCAPTION : hit;
    }
    case WM_ERASEBKGND:
      return 1;
    case WM_PAINT:
      Paint(window);
      return 0;
    case WM_TIMER:
      if (w == TIMER_ID) {
        Tick(window);
        return 0;
      }
      break;
    case WM_SETTINGCHANGE:
    case WM_SYSCOLORCHANGE:
    case WM_THEMECHANGED:
      LoadColours();
      ApplyFrame();
      InvalidateRect(window, NULL, FALSE);
      break;
    case WM_NCDESTROY:
      KillTimer(window, TIMER_ID);
      RemovePropW(window, L"BulwarkSplashPercent");
      RemovePropW(window, L"BulwarkSplashStep");
      SetWindowLongPtrW(window, GWLP_WNDPROC, (LONG_PTR)g.old);
      g.window = NULL;
      return CallWindowProcW(g.old, window, message, w, l);
  }
  return CallWindowProcW(g.old, window, message, w, l);
}

static void Release(void) {
  if (g.window && IsWindow(g.window)) {
    KillTimer(g.window, TIMER_ID);
    if ((WNDPROC)GetWindowLongPtrW(g.window, GWLP_WNDPROC) == Proc) SetWindowLongPtrW(g.window, GWLP_WNDPROC, (LONG_PTR)g.old);
  }
  g.window = NULL;
}

static UINT_PTR PluginCallback(enum NSPIM message) {
  Release();
  (void)message;
  return 0;
}

static HWND FindBar(HWND window) {
  for (HWND child = GetWindow(window, GW_CHILD); child; child = GetWindow(child, GW_HWNDNEXT)) {
    HWND bar = GetDlgItem(child, 1004);
    if (bar) return bar;
  }
  return NULL;
}

__declspec(dllexport) void __cdecl Show(HWND parent, int stringSize, LPWSTR variables, stack_t **stacktop, extra_parameters *extra) {
  WCHAR number[32];
  (void)variables;
  PopString(stacktop, g.heading, TEXT_MAX);
  PopString(stacktop, g.line, TEXT_MAX);
  PopString(stacktop, g.percent, 64);
  PopString(stacktop, g.logo, MAX_PATH);
  PopString(stacktop, number, 32);
  g.dpiOverride = _wtoi(number);
  PopString(stacktop, number, 32);
  g.rtl = _wtoi(number) == 1;
  PopString(stacktop, g.themeKey, 512);

  if (g.window) {
    PushString(stacktop, L"already shown", stringSize);
    return;
  }
  g.bar = FindBar(parent);
  if (!parent || !g.bar) {
    PushString(stacktop, L"no progress bar", stringSize);
    return;
  }
  /* Kept loaded while it's the window's procedure; NSIS calls back before it unloads it. */
  if (!extra || !extra->RegisterPluginCallback || extra->RegisterPluginCallback(g_module, PluginCallback) < 0) {
    PushString(stacktop, L"can't stay loaded", stringSize);
    return;
  }
  g.window = parent;
  g.old = (WNDPROC)SetWindowLongPtrW(parent, GWLP_WNDPROC, (LONG_PTR)Proc);
  SendMessageW(parent, WM_SPLASH_INIT, 0, 0);
  PushString(stacktop, L"ok", stringSize);
}

/*
 * Whether Bulwark runs from the install folder, and ending it, for the installer's and the
 * uninstaller's "is the app running" check. electron-builder's asks PowerShell three times,
 * which took seven seconds of an install, and an update pays it twice: in the installer and in
 * the old uninstaller. This asks Windows directly.
 */
static BOOL InsideDir(const WCHAR *exe, const WCHAR *dir) {
  int n = lstrlenW(dir);
  while (n > 0 && (dir[n - 1] == L'\\' || dir[n - 1] == L'/')) n--;
  if (n == 0 || lstrlenW(exe) <= n || exe[n] != L'\\') return FALSE;
  return CompareStringOrdinal(exe, n, dir, n, TRUE) == CSTR_EQUAL;
}

/* How many processes run from inside dir, this one aside. With stop, each is ended and waited for. */
static int Inside(const WCHAR *dir, BOOL stop) {
  int found = 0;
  DWORD self = GetCurrentProcessId();
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return 0;
  PROCESSENTRY32W entry = { sizeof(entry) };
  for (BOOL more = Process32FirstW(snapshot, &entry); more; more = Process32NextW(snapshot, &entry)) {
    if (entry.th32ProcessID == self || entry.th32ProcessID == 0) continue;
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ProcessID);
    if (!process) continue;
    WCHAR exe[1024];
    DWORD size = 1024;
    BOOL inside = QueryFullProcessImageNameW(process, 0, exe, &size) && InsideDir(exe, dir);
    CloseHandle(process);
    if (!inside) continue;
    if (stop) {
      /* One run elevated can't be ended from here: it still counts, and the script asks the person. */
      HANDLE end = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE, entry.th32ProcessID);
      if (end) {
        BOOL ended = TerminateProcess(end, 1) && WaitForSingleObject(end, 5000) == WAIT_OBJECT_0;
        CloseHandle(end);
        if (ended) continue;
      }
    }
    found++;
  }
  CloseHandle(snapshot);
  return found;
}

/* BulwarkSplash::Running <dir>: "1" if a process runs from inside dir, else "0". */
__declspec(dllexport) void __cdecl Running(HWND parent, int stringSize, LPWSTR variables, stack_t **stacktop, extra_parameters *extra) {
  WCHAR dir[1024];
  (void)parent;
  (void)variables;
  (void)extra;
  PopString(stacktop, dir, 1024);
  PushString(stacktop, Inside(dir, FALSE) ? L"1" : L"0", stringSize);
}

/* BulwarkSplash::Stop <dir>: ends every process running from inside dir. "1" if one is left, else "0". */
__declspec(dllexport) void __cdecl Stop(HWND parent, int stringSize, LPWSTR variables, stack_t **stacktop, extra_parameters *extra) {
  WCHAR dir[1024];
  (void)parent;
  (void)variables;
  (void)extra;
  PopString(stacktop, dir, 1024);
  PushString(stacktop, Inside(dir, TRUE) ? L"1" : L"0", stringSize);
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
  (void)reserved;
  if (reason == DLL_PROCESS_ATTACH) g_module = instance;
  return TRUE;
}
