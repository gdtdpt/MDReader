/* MDReader 启动器（M4-2，Heinrich 确认方案）
 *
 * 存在意义：双击 .md 时，Windows 必然会创建一个进程。目标机实测表明，
 * "进程创建前的外部开销"（企业 EDR 同步扫描映像）与映像体积正相关：
 *   MDReader.exe    150.3 MB  → 约 3.0~3.3 s
 *   对照小 exe       200 KB   → 约 1.5 s
 * 所以这里刻意把映像做到约 15 KB（gcc -Os -s -static），把这一笔压到最小。
 *
 * 职责只有一个：把文件路径交给常驻实例，然后立刻退出。
 *   1. 连接 \\.\pipe\mdreader（常驻的 Electron 进程在监听；服务端用 Node 内置 net，
 *      零新增依赖）
 *      成功 → 写 "<进程引导毫秒数>\n<文件路径>"（UTF-16LE）→ 退出
 *   2. 连不上（未常驻）→ 直接拉起同目录 MDReader.exe 并把文件路径透传，
 *      行为与引入启动器之前完全一致
 *
 * 路径按 UTF-16LE 原样传出，宿主侧用 Buffer.toString("utf16le") 解，
 * 不经任何代码页转换（这是相对 "cmd 重定向" 方案的关键优势：无 GBK 坑、
 * 无控制台闪窗、无引号转义问题）。
 *
 * 编译：node tools/build-launcher.js
 * 产物 native/launcher/MDReaderLauncher.exe 入库并随 dist 分发（打包机无需编译器）。
 * 依赖：仅 kernel32 / msvcrt / user32，Win10 1709 自带，运行时零安装。
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

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

/* 未常驻：直接拉起完整应用（与引入启动器之前的行为一致） */
static void ColdStart(const wchar_t *exe, const wchar_t *path)
{
    static wchar_t cmd[BUF_CHARS];
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
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
    ZeroMemory(&pi, sizeof(pi));
    if (CreateProcessW(NULL, cmd, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
}

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmdLine, int nShowCmd)
{
    static wchar_t dir[MAX_PATH], exe[MAX_PATH], arg[MAX_PATH];
    const wchar_t *p;

    (void)hInst;
    (void)hPrev;
    (void)lpCmdLine;
    (void)nShowCmd;

    ResolveAppPaths(dir, exe);

    p = FirstArg(GetCommandLineW());
    arg[0] = 0;
    if (p) {
        int i = 0;
        if (*p == L'"') ++p;
        while (*p && *p != L'"' && i < MAX_PATH - 1) arg[i++] = *p++;
        arg[i] = 0;
    }

    /* 带路径时交给常驻实例打开；不带路径（裸跑）时只唤出窗口 */
    if (!SendToResident(arg[0] ? arg : NULL)) {
        ColdStart(exe, arg[0] ? arg : NULL);
    }
    return 0;
}
