/* MDReader 启动器（M4-2）
 *
 * 存在意义：双击 .md 时，Windows 必然会创建一个进程。实测表明，
 * "进程创建前的外部开销"（安全软件同步扫描映像）与映像体积正相关：
 *   MDReader.exe    150.3 MB  → 约 3.0~3.3 s
 *   对照小 exe       200 KB   → 约 1.5 s
 * 所以这里刻意把映像做到约 15 KB（gcc -Os -s -static），把这一笔压到最小。
 *
 * 职责：把文件路径交给常驻实例；未常驻则拉起完整应用并给启动反馈。
 *   1. 连接 \\.\pipe\mdreader（常驻的 Electron 进程在监听；服务端用 Node 内置 net，
 *      零新增依赖）
 *      成功 → 写 "<进程引导毫秒数>\n<文件路径>"（UTF-16LE）→ 退出
 *   2. 连不上（未常驻）→ 先弹一个无边框启动浮窗「MDReader 正在启动…」（随系统
 *      明暗取色），再拉起同目录 MDReader.exe 并把文件路径透传；然后轮询管道，
 *      应用主进程就绪（管道可连）就把路径再走管道移交一次、关浮窗退出。
 *      路径仍透传 argv 作兑底：浮窗超时/应用异常退出都不丢文件。
 *      启动浮窗存在的意义：MDReader.exe 映像创建前的外部扫描约 3s，这段
 *      任何应用内代码都来不及跑 —— 只有这个 15KB 的小进程能在此期间给出视觉反馈。
 *      全局互斥体 Local\MDReaderSplash 防止连续双击时叠出多个浮窗。
 *
 * 路径按 UTF-16LE 原样传出，宿主侧用 Buffer.toString("utf16le") 解，
 * 不经任何代码页转换（这是相对 "cmd 重定向" 方案的关键优势：无 GBK 坑、
 * 无控制台闪窗、无引号转义问题）。
 *
 * 编译：node tools/build-launcher.js
 * 产物 native/launcher/MDReaderLauncher.exe 入库并随 dist 分发（打包机无需编译器）。
 * 依赖：仅 kernel32 / msvcrt / user32，Win10 自带，运行时零安装。
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winreg.h>

#define PIPE_NAME L"\\\\.\\pipe\\mdreader"
#define APP_EXE L"MDReader.exe"
#define BUF_CHARS 32768

/* 进程创建 → 现在（毫秒）。与 Electron 侧 procBootMs 同口径：
 * 宿主日志里直接就能看到"这次双击付了多少映像创建开销"。 */
static unsigned ProcBootMs(void)
{
    FILETIME create, exitT, kernel, user, now;
    ULARGE_INTEGER a, b;
    if (!GetProcessTimes(GetCurrentProcess(), &create, &exitT, &kernel, &user)) return 0;
    GetSystemTimeAsFileTime(&now);
    a.LowPart = create.dwLowDateTime;
    a.HighPart = create.dwHighDateTime;
    b.LowPart = now.dwLowDateTime;
    b.HighPart = now.dwHighDateTime;
    return (unsigned)((b.QuadPart - a.QuadPart) / 10000ULL);
}

/* 跳过 argv[0]（可能是带引号的路径），返回第一个参数起点 */
static const wchar_t *FirstArg(const wchar_t *cmd)
{
    const wchar_t *p = cmd;
    if (*p == L'"') {
        ++p;
        while (*p && *p != L'"') ++p;
        if (*p) ++p;
    } else {
        while (*p && *p != L' ' && *p != L'\t') ++p;
    }
    while (*p == L' ' || *p == L'\t') ++p;
    return *p ? p : NULL;
}

/* 取启动器所在目录（含尾反斜杠）与同目录下的 MDReader.exe 完整路径 */
static void ResolveAppPaths(wchar_t *dirBuf, wchar_t *exeBuf)
{
    wchar_t *slash;
    GetModuleFileNameW(NULL, dirBuf, MAX_PATH);
    slash = dirBuf;
    for (wchar_t *p = dirBuf; *p; ++p) {
        if (*p == L'\\') slash = p;
    }
    if (*slash == L'\\') *(slash + 1) = 0; else dirBuf[0] = 0;
    lstrcpynW(exeBuf, dirBuf, MAX_PATH);
    lstrcatW(exeBuf, APP_EXE);
}

/* 交给常驻实例；成功返回 TRUE（此时可以退出了） */
static BOOL SendToResident(const wchar_t *path)
{
    static wchar_t msg[BUF_CHARS];
    wchar_t digits[12];
    HANDLE h;
    DWORD written;
    unsigned boot;
    int i = 0, n = 0;

    h = CreateFileW(PIPE_NAME, GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        /* 管道正忙（宿主上一笔消息还没读完）稍等一次；不存在则说明未常驻 */
        if (GetLastError() != ERROR_PIPE_BUSY) return FALSE;
        if (!WaitNamedPipeW(PIPE_NAME, 300)) return FALSE;
        h = CreateFileW(PIPE_NAME, GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
        if (h == INVALID_HANDLE_VALUE) return FALSE;
    }

    boot = ProcBootMs();
    if (boot == 0) digits[n++] = L'0';
    while (boot) {
        digits[n++] = (wchar_t)(L'0' + (boot % 10));
        boot /= 10;
    }
    while (n) msg[i++] = digits[--n];
    msg[i++] = L'\n';
    if (path) {
        const wchar_t *p = path;
        while (*p && i < BUF_CHARS - 2) msg[i++] = *p++;
    }
    msg[i] = 0;

    WriteFile(h, msg, (DWORD)((i + 1) * sizeof(wchar_t)), &written, NULL);
    CloseHandle(h);
    return TRUE;
}

/* 未常驻：直接拉起完整应用（与引入启动器之前的行为一致）。
 * 返回 TRUE 时 pi 中是子进程句柄（调用方用于等待/轮询），用完必须 CloseHandle。 */
static BOOL ColdStart(const wchar_t *exe, const wchar_t *path, PROCESS_INFORMATION *pi)
{
    static wchar_t cmd[BUF_CHARS];
    STARTUPINFOW si;
    int i = 0;

    cmd[i++] = L'"';
    for (const wchar_t *p = exe; *p && i < BUF_CHARS - 8; ++p) cmd[i++] = *p;
    cmd[i++] = L'"';
    if (path && *path) {
        cmd[i++] = L' ';
        cmd[i++] = L'"';
        for (const wchar_t *p = path; *p && i < BUF_CHARS - 4; ++p) cmd[i++] = *p;
        cmd[i++] = L'"';
    }
    cmd[i] = 0;

    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(pi, sizeof(*pi));
    return CreateProcessW(NULL, cmd, NULL, NULL, FALSE, 0, NULL, NULL, &si, pi);
}

/* ---------- 启动等待浮窗 ----------
 * 冷启动时 MDReader.exe 从被创建到主进程就绪有数秒空窗（外部扫描 + Electron 引导），
 * 这段任何应用内代码都来不及跑，只有这个 15KB 小进程能给出视觉反馈。
 * 浮窗在拉起 MDReader.exe 之前就显示：应用图标 + 提示文字 + 底部流动进度条
 * （30ms 定时重绘，让等待「看得见在动」），淡色主题用白底 + 描边 + 投影
 * 保证在杂乱桌面上醒目；管道可连（= 主进程就绪）即关闭退出。 */

#define SPLASH_W 360
#define SPLASH_H 120
#define SPLASH_TIMEOUT_MS 20000

/* 高 DPI：物理像素坐标 + 按系统 DPI 缩放窗口与字号（文字不发虚） */
static int g_dpi = 96;
static int Dpi(int v) { return v * g_dpi / 96; }

static HWND g_splash = NULL;
static HFONT g_font = NULL;
static HICON g_icon = NULL;
static COLORREF g_bg, g_fg, g_border, g_track, g_accent;
static wchar_t g_appExe[MAX_PATH]; /* 供 ExtractIconExW 提取应用图标 */

/* 读系统「应用模式」明暗（与 MDReader 的跟随系统主题同源），读不到按浅色 */
static BOOL IsDarkMode(void)
{
    DWORD v = 1, cb = sizeof(v);
    if (RegGetValueW(HKEY_CURRENT_USER,
                     L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                     L"AppsUseLightTheme", RRF_RT_REG_DWORD, NULL, &v, &cb)
        != ERROR_SUCCESS) {
        return FALSE;
    }
    return v == 0;
}

/* 动态取 shell32 的 ExtractIconExW（避免为一次调用改链接依赖） */
static HICON LoadAppIcon(void)
{
    typedef UINT (WINAPI *ExtractIconExW_t)(LPCWSTR, int, HICON *, HICON *, UINT);
    HMODULE sh = LoadLibraryW(L"shell32.dll");
    if (!sh) return NULL;
    ExtractIconExW_t fn = (ExtractIconExW_t)GetProcAddress(sh, "ExtractIconExW");
    HICON icon = NULL;
    if (fn) fn(g_appExe, 0, &icon, NULL, 1);
    FreeLibrary(sh);
    return icon;
}

static LRESULT CALLBACK SplashProc(HWND h, UINT msg, WPARAM wp, LPARAM lp)
{
    switch (msg) {
    case WM_CREATE:
        SetTimer(h, 1, 30, NULL); /* 进度条动画的心跳 */
        return 0;
    case WM_TIMER:
        InvalidateRect(h, NULL, FALSE);
        return 0;
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        RECT rc;
        GetClientRect(h, &rc);
        HBRUSH brush;
        brush = CreateSolidBrush(g_bg);
        FillRect(dc, &rc, brush);
        DeleteObject(brush);
        brush = CreateSolidBrush(g_border);
        FrameRect(dc, &rc, brush); /* 1px 描边：淡色桌面上勾出轮廓 */
        DeleteObject(brush);

        /* 应用图标 + 文字，整体在窗口里垂直居中 */
        int isz = Dpi(32);
        int iconY = Dpi(16);
        if (g_icon) {
            DrawIconEx(dc, (rc.right - isz) / 2, iconY, g_icon, isz, isz, 0, NULL, DI_NORMAL);
        }
        HGDIOBJ oldFont = SelectObject(dc, g_font);
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, g_fg);
        RECT textRc;
        textRc.left = 0;
        textRc.top = iconY + isz + Dpi(10);
        textRc.right = rc.right;
        textRc.bottom = textRc.top + Dpi(24);
        DrawTextW(dc, L"MDReader 正在启动…", -1, &textRc,
                  DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);
        SelectObject(dc, oldFont);

        /* 底部流动进度条：1/3 宽的色块在轨道上循环移动 */
        int mx = Dpi(24), mw = rc.right - Dpi(48);
        int my = rc.bottom - Dpi(16), mh = Dpi(4);
        RECT track = {mx, my, mx + mw, my + mh};
        brush = CreateSolidBrush(g_track);
        FillRect(dc, &track, brush);
        DeleteObject(brush);
        int seg = mw / 3;
        int period = 1200; /* 一个循环的毫秒数 */
        int t = (int)(GetTickCount() % period);
        int x = mx - seg + (int)((LONG64)(mw + seg) * t / period);
        RECT mv = {x, my, x + seg, my + mh};
        if (mv.left < mx) mv.left = mx;
        if (mv.right > mx + mw) mv.right = mx + mw;
        if (mv.right > mv.left) {
            brush = CreateSolidBrush(g_accent);
            FillRect(dc, &mv, brush);
            DeleteObject(brush);
        }
        EndPaint(h, &ps);
        return 0;
    }
    case WM_DESTROY:
        KillTimer(h, 1);
        if (g_icon) DestroyIcon(g_icon);
        return 0;
    default:
        return DefWindowProcW(h, msg, wp, lp);
    }
}

static HWND CreateSplash(HINSTANCE hInst)
{
    WNDCLASSW wc;
    ZeroMemory(&wc, sizeof(wc));
    wc.style = CS_DROPSHADOW; /* 投影：淡色桌面上更醒目 */
    wc.lpfnWndProc = SplashProc;
    wc.hInstance = hInst;
    wc.hCursor = LoadCursor(NULL, IDC_APPSTARTING);
    wc.lpszClassName = L"MDReaderSplash";
    if (!RegisterClassW(&wc)) return NULL;

    g_dpi = GetDpiForSystem();
    const int w = Dpi(SPLASH_W), hgt = Dpi(SPLASH_H);

    if (IsDarkMode()) {
        g_bg     = RGB(0x0d, 0x11, 0x17); /* 与主题暗色背景一致 */
        g_fg     = RGB(0xe6, 0xed, 0xf3);
        g_border = RGB(0x30, 0x36, 0x3d);
        g_track  = RGB(0x21, 0x26, 0x2d);
        g_accent = RGB(0x58, 0xa6, 0xff);
    } else {
        g_bg     = RGB(0xff, 0xff, 0xff); /* 纯白 + 描边 + 投影，淡色桌面不隐身 */
        g_fg     = RGB(0x1f, 0x23, 0x28);
        g_border = RGB(0xd0, 0xd7, 0xde);
        g_track  = RGB(0xea, 0xee, 0xf2);
        g_accent = RGB(0x09, 0x69, 0xda);
    }
    g_font = CreateFontW(-Dpi(15), 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET,
                         OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                         DEFAULT_PITCH | FF_DONTCARE, L"Microsoft YaHei UI");
    g_icon = LoadAppIcon();

    int sw = GetSystemMetrics(SM_CXSCREEN);
    int sh = GetSystemMetrics(SM_CYSCREEN);
    /* 窗口标题仅用于自动化定位（WS_POPUP 无标题栏，用户不可见） */
    HWND h = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, wc.lpszClassName,
                             L"MDReader Splash", WS_POPUP, (sw - w) / 2,
                             (sh - hgt) / 2, w, hgt, NULL, NULL,
                             hInst, NULL);
    if (!h) return NULL;
    ShowWindow(h, SW_SHOWNA);
    UpdateWindow(h); /* 立即触发 WM_PAINT，不等消息循环 */
    return h;
}

static void PumpMessages(void)
{
    MSG m;
    while (PeekMessageW(&m, NULL, 0, 0, PM_REMOVE)) {
        TranslateMessage(&m);
        DispatchMessageW(&m);
    }
}

/* 冷启动等待：拉起 MDReader.exe 后轮询管道，主进程就绪即移交路径并结束；
 * 子进程退出（异常）或超时也结束（路径已在 argv 里，应用自身仍会打开）。 */
static void ColdStartAndWait(HINSTANCE hInst, const wchar_t *exe, const wchar_t *path)
{
    lstrcpynW(g_appExe, exe, MAX_PATH);
    /* 防叠窗：已有另一个启动器浮窗在等，就不再画自己的 */
    HANDLE mutex = CreateMutexW(NULL, TRUE, L"Local\\MDReaderSplash");
    BOOL splashAllowed = mutex && GetLastError() != ERROR_ALREADY_EXISTS;
    if (splashAllowed) g_splash = CreateSplash(hInst);

    PROCESS_INFORMATION pi;
    if (ColdStart(exe, path, &pi)) {
        DWORD start = GetTickCount();
        BOOL done = FALSE;
        while (!done) {
            PumpMessages(); /* 浮窗保持可绘制/可响应（含进度动画） */
            if (SendToResident(path)) { /* 管道可连 = 主进程就绪，移交后收工 */
                done = TRUE;
                break;
            }
            if (WaitForSingleObject(pi.hProcess, 40) == WAIT_OBJECT_0) break;
            if (GetTickCount() - start > SPLASH_TIMEOUT_MS) break;
        }
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }

    PumpMessages();
    if (g_splash) DestroyWindow(g_splash);
    PumpMessages();
    if (g_font) DeleteObject(g_font);
    if (mutex) {
        ReleaseMutex(mutex);
        CloseHandle(mutex);
    }
}

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmdLine, int nShowCmd)
{
    static wchar_t dir[MAX_PATH], exe[MAX_PATH], arg[MAX_PATH];
    const wchar_t *p;

    (void)hPrev;
    (void)lpCmdLine;
    (void)nShowCmd;

    /* 先声明 DPI 感知再建窗口：GetDpiForSystem 才返回真实 DPI，文字按物理像素绘制不发虚 */
    SetProcessDPIAware();

    ResolveAppPaths(dir, exe);

    p = FirstArg(GetCommandLineW());
    arg[0] = 0;
    if (p) {
        int i = 0;
        if (*p == L'"') ++p;
        while (*p && *p != L'"' && i < MAX_PATH - 1) arg[i++] = *p++;
        arg[i] = 0;
    }

    /* 带路径时交给常驻实例打开；不带路径（裸跑）时只唤出窗口。
     * 常驻移交失败 = 未常驻 → 冷启动 + 启动浮窗 + 管道轮询。 */
    if (!SendToResident(arg[0] ? arg : NULL)) {
        ColdStartAndWait(hInst, exe, arg[0] ? arg : NULL);
    }
    return 0;
}
