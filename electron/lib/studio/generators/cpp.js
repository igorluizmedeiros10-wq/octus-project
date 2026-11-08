'use strict';

/**
 * Gerador C++ (Win32 API pura, sem dependências externas).
 * Produz um aplicativo Windows real com interface nativa, persistência em disco
 * e lógica específica por modelo (notas, tarefas ou calculadora).
 */

function cppSource(bp) {
  const isCalculator = bp.kind === 'calculator';
  const accent = bp.accent.replace('#', '');
  const r = parseInt(accent.slice(0, 2), 16);
  const g = parseInt(accent.slice(2, 4), 16);
  const b = parseInt(accent.slice(4, 6), 16);
  const placeholder = isCalculator ? 'Expressao (ex.: (2+3)*4)' : bp.kind === 'tasks' ? 'Nova tarefa' : 'Nova nota';
  const addLabel = isCalculator ? 'Calcular' : 'Adicionar';

  return `// ${bp.title}
// Gerado pelo Executive AI Studio — C++ / Win32 API
// Modelo: ${bp.kindLabel}
//
// Compilar no Windows:
//   build.ps1  (CMake + MSVC ou MinGW g++)
//
// Nenhuma dependencia externa: apenas user32, gdi32 e comctl32.

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>
#include <commctrl.h>
#include <string>
#include <vector>
#include <fstream>
#include <sstream>
#include <cstdlib>
#include <cmath>

#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")

namespace {

const wchar_t* kWindowTitle = L"${bp.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}";
const wchar_t* kAppFolder = L"${bp.name}";
const bool kCalculator = ${isCalculator ? 'true' : 'false'};

const COLORREF kBackground = RGB(16, 17, 19);
const COLORREF kPanel = RGB(25, 27, 31);
const COLORREF kText = RGB(230, 234, 240);
const COLORREF kAccent = RGB(${r}, ${g}, ${b});

HWND g_input = nullptr;
HWND g_list = nullptr;
HWND g_status = nullptr;
HBRUSH g_backgroundBrush = nullptr;
HBRUSH g_panelBrush = nullptr;
HFONT g_font = nullptr;
HFONT g_titleFont = nullptr;
std::vector<std::wstring> g_items;
std::wstring g_dataPath;

std::wstring AppDataPath() {
    wchar_t buffer[MAX_PATH] = {0};
    DWORD size = GetEnvironmentVariableW(L"APPDATA", buffer, MAX_PATH);
    std::wstring base = (size > 0 && size < MAX_PATH) ? std::wstring(buffer, size) : std::wstring(L".");
    std::wstring dir = base + L"\\\\Executive AI Studio\\\\" + kAppFolder;
    CreateDirectoryW((base + L"\\\\Executive AI Studio").c_str(), nullptr);
    CreateDirectoryW(dir.c_str(), nullptr);
    return dir + L"\\\\data.txt";
}

void LoadItems() {
    g_items.clear();
    std::wifstream file(g_dataPath.c_str());
    if (!file.is_open()) return;
    std::wstring line;
    while (std::getline(file, line)) {
        if (!line.empty()) g_items.push_back(line);
    }
}

void SaveItems() {
    std::wofstream file(g_dataPath.c_str(), std::ios::trunc);
    if (!file.is_open()) return;
    for (const std::wstring& item : g_items) file << item << L"\\n";
}

void RefreshList() {
    SendMessageW(g_list, LB_RESETCONTENT, 0, 0);
    for (const std::wstring& item : g_items) {
        SendMessageW(g_list, LB_ADDSTRING, 0, reinterpret_cast<LPARAM>(item.c_str()));
    }
    std::wstringstream status;
    status << g_items.size() << (g_items.size() == 1 ? L" item" : L" itens");
    SetWindowTextW(g_status, status.str().c_str());
}

// Avaliador aritmetico seguro (sem eval): soma, subtracao, multiplicacao, divisao e parenteses.
struct Parser {
    const std::wstring& text;
    size_t pos = 0;
    bool ok = true;
    explicit Parser(const std::wstring& value) : text(value) {}

    void Skip() { while (pos < text.size() && iswspace(text[pos])) ++pos; }

    double ParseExpression() {
        double value = ParseTerm();
        for (;;) {
            Skip();
            if (pos < text.size() && (text[pos] == L'+' || text[pos] == L'-')) {
                wchar_t op = text[pos++];
                double right = ParseTerm();
                value = (op == L'+') ? value + right : value - right;
            } else {
                return value;
            }
        }
    }

    double ParseTerm() {
        double value = ParseFactor();
        for (;;) {
            Skip();
            if (pos < text.size() && (text[pos] == L'*' || text[pos] == L'/')) {
                wchar_t op = text[pos++];
                double right = ParseFactor();
                if (op == L'/' && right == 0.0) { ok = false; return 0.0; }
                value = (op == L'*') ? value * right : value / right;
            } else {
                return value;
            }
        }
    }

    double ParseFactor() {
        Skip();
        if (pos < text.size() && text[pos] == L'-') { ++pos; return -ParseFactor(); }
        if (pos < text.size() && text[pos] == L'(') {
            ++pos;
            double value = ParseExpression();
            Skip();
            if (pos < text.size() && text[pos] == L')') ++pos; else ok = false;
            return value;
        }
        size_t start = pos;
        while (pos < text.size() && (iswdigit(text[pos]) || text[pos] == L'.')) ++pos;
        if (start == pos) { ok = false; return 0.0; }
        return wcstod(text.substr(start, pos - start).c_str(), nullptr);
    }
};

std::wstring FormatNumber(double value) {
    std::wstringstream stream;
    stream.precision(12);
    stream << value;
    return stream.str();
}

void SubmitInput() {
    wchar_t buffer[512] = {0};
    GetWindowTextW(g_input, buffer, 511);
    std::wstring entry(buffer);
    if (entry.empty()) return;

    if (kCalculator) {
        Parser parser(entry);
        double result = parser.ParseExpression();
        parser.Skip();
        if (!parser.ok || parser.pos != entry.size()) {
            MessageBoxW(nullptr, L"Expressao invalida. Use numeros, +, -, *, / e parenteses.", L"Calculadora", MB_ICONWARNING | MB_OK);
            return;
        }
        g_items.push_back(entry + L" = " + FormatNumber(result));
    } else if (kCalculator == false && !entry.empty()) {
        g_items.push_back(entry);
    }

    SetWindowTextW(g_input, L"");
    SaveItems();
    RefreshList();
    SendMessageW(g_list, LB_SETCURSEL, static_cast<WPARAM>(g_items.size() - 1), 0);
}

void RemoveSelected() {
    int index = static_cast<int>(SendMessageW(g_list, LB_GETCURSEL, 0, 0));
    if (index < 0 || index >= static_cast<int>(g_items.size())) return;
    g_items.erase(g_items.begin() + index);
    SaveItems();
    RefreshList();
}

void ClearAll() {
    if (g_items.empty()) return;
    if (MessageBoxW(nullptr, L"Remover todos os itens?", L"Confirmar", MB_ICONQUESTION | MB_YESNO) != IDYES) return;
    g_items.clear();
    SaveItems();
    RefreshList();
}

void Layout(HWND hwnd) {
    RECT area;
    GetClientRect(hwnd, &area);
    const int margin = 24;
    const int inputHeight = 42;
    const int buttonWidth = 132;
    const int width = area.right - area.left;

    MoveWindow(g_input, margin, margin + 52, width - margin * 2 - buttonWidth - 12, inputHeight, TRUE);
    MoveWindow(GetDlgItem(hwnd, 1001), width - margin - buttonWidth, margin + 52, buttonWidth, inputHeight, TRUE);
    MoveWindow(GetDlgItem(hwnd, 1002), width - margin - buttonWidth, margin + 52 + inputHeight + 12, buttonWidth, inputHeight, TRUE);
    MoveWindow(GetDlgItem(hwnd, 1003), width - margin - buttonWidth, margin + 52 + (inputHeight + 12) * 2, buttonWidth, inputHeight, TRUE);
    MoveWindow(g_list, margin, margin + 52 + inputHeight + 12, width - margin * 2 - buttonWidth - 12,
               area.bottom - (margin + 52 + inputHeight + 12) - margin - 28, TRUE);
    MoveWindow(g_status, margin, area.bottom - margin - 18, width - margin * 2, 18, TRUE);
}

void CreateControls(HWND hwnd) {
    HINSTANCE instance = GetModuleHandleW(nullptr);
    g_font = CreateFontW(-16, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                         CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
    g_titleFont = CreateFontW(-26, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                              CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");

    HWND title = CreateWindowExW(0, L"STATIC", kWindowTitle, WS_CHILD | WS_VISIBLE | SS_LEFT,
                                 24, 18, 600, 34, hwnd, nullptr, instance, nullptr);
    SendMessageW(title, WM_SETFONT, reinterpret_cast<WPARAM>(g_titleFont), TRUE);

    g_input = CreateWindowExW(0, L"EDIT", L"", WS_CHILD | WS_VISIBLE | WS_BORDER | ES_AUTOHSCROLL,
                              0, 0, 0, 0, hwnd, reinterpret_cast<HMENU>(1000), instance, nullptr);
    SendMessageW(g_input, WM_SETFONT, reinterpret_cast<WPARAM>(g_font), TRUE);
    SendMessageW(g_input, EM_SETCUEBANNER, TRUE, reinterpret_cast<LPARAM>(L"${placeholder}"));

    CreateWindowExW(0, L"BUTTON", L"${addLabel}", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                    0, 0, 0, 0, hwnd, reinterpret_cast<HMENU>(1001), instance, nullptr);
    CreateWindowExW(0, L"BUTTON", L"Remover", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                    0, 0, 0, 0, hwnd, reinterpret_cast<HMENU>(1002), instance, nullptr);
    CreateWindowExW(0, L"BUTTON", L"Limpar", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                    0, 0, 0, 0, hwnd, reinterpret_cast<HMENU>(1003), instance, nullptr);

    g_list = CreateWindowExW(WS_EX_CLIENTEDGE, L"LISTBOX", L"",
                             WS_CHILD | WS_VISIBLE | WS_VSCROLL | LBS_NOTIFY | LBS_NOINTEGRALHEIGHT,
                             0, 0, 0, 0, hwnd, reinterpret_cast<HMENU>(1004), instance, nullptr);
    SendMessageW(g_list, WM_SETFONT, reinterpret_cast<WPARAM>(g_font), TRUE);

    g_status = CreateWindowExW(0, L"STATIC", L"", WS_CHILD | WS_VISIBLE | SS_LEFT,
                               0, 0, 0, 0, hwnd, nullptr, instance, nullptr);
    SendMessageW(g_status, WM_SETFONT, reinterpret_cast<WPARAM>(g_font), TRUE);

    for (int id = 1001; id <= 1003; ++id) {
        SendMessageW(GetDlgItem(hwnd, id), WM_SETFONT, reinterpret_cast<WPARAM>(g_font), TRUE);
    }
}

LRESULT CALLBACK WindowProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
    case WM_CREATE:
        g_backgroundBrush = CreateSolidBrush(kBackground);
        g_panelBrush = CreateSolidBrush(kPanel);
        g_dataPath = AppDataPath();
        LoadItems();
        CreateControls(hwnd);
        RefreshList();
        Layout(hwnd);
        return 0;

    case WM_SIZE:
        Layout(hwnd);
        return 0;

    case WM_GETMINMAXINFO: {
        MINMAXINFO* info = reinterpret_cast<MINMAXINFO*>(lParam);
        info->ptMinTrackSize.x = 720;
        info->ptMinTrackSize.y = 480;
        return 0;
    }

    case WM_COMMAND: {
        const int id = LOWORD(wParam);
        const int code = HIWORD(wParam);
        if (id == 1001) SubmitInput();
        if (id == 1002) RemoveSelected();
        if (id == 1003) ClearAll();
        if (id == 1000 && code == EN_UPDATE) return 0;
        return 0;
    }

    case WM_CTLCOLORSTATIC: {
        HDC dc = reinterpret_cast<HDC>(wParam);
        SetTextColor(dc, kText);
        SetBkColor(dc, kBackground);
        return reinterpret_cast<LRESULT>(g_backgroundBrush);
    }

    case WM_CTLCOLOREDIT:
    case WM_CTLCOLORLISTBOX: {
        HDC dc = reinterpret_cast<HDC>(wParam);
        SetTextColor(dc, kText);
        SetBkColor(dc, kPanel);
        return reinterpret_cast<LRESULT>(g_panelBrush);
    }

    case WM_ERASEBKGND: {
        RECT area;
        GetClientRect(hwnd, &area);
        FillRect(reinterpret_cast<HDC>(wParam), &area, g_backgroundBrush);
        return 1;
    }

    case WM_DESTROY:
        SaveItems();
        if (g_backgroundBrush) DeleteObject(g_backgroundBrush);
        if (g_panelBrush) DeleteObject(g_panelBrush);
        if (g_font) DeleteObject(g_font);
        if (g_titleFont) DeleteObject(g_titleFont);
        PostQuitMessage(0);
        return 0;

    default:
        return DefWindowProcW(hwnd, message, wParam, lParam);
    }
}

} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int showCommand) {
    INITCOMMONCONTROLSEX controls = {sizeof(INITCOMMONCONTROLSEX), ICC_STANDARD_CLASSES};
    InitCommonControlsEx(&controls);

    const wchar_t* className = L"ExecutiveAIStudioWindow";
    WNDCLASSEXW windowClass = {0};
    windowClass.cbSize = sizeof(WNDCLASSEXW);
    windowClass.style = CS_HREDRAW | CS_VREDRAW;
    windowClass.lpfnWndProc = WindowProc;
    windowClass.hInstance = instance;
    windowClass.hCursor = LoadCursor(nullptr, IDC_ARROW);
    windowClass.hbrBackground = nullptr;
    windowClass.lpszClassName = className;
    RegisterClassExW(&windowClass);

    HWND hwnd = CreateWindowExW(0, className, kWindowTitle, WS_OVERLAPPEDWINDOW,
                                CW_USEDEFAULT, CW_USEDEFAULT, ${bp.window.width}, ${bp.window.height},
                                nullptr, nullptr, instance, nullptr);
    if (!hwnd) return 0;

    ShowWindow(hwnd, showCommand);
    UpdateWindow(hwnd);

    MSG message;
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    return static_cast<int>(message.wParam);
}
`;
}

module.exports = { cppSource };
