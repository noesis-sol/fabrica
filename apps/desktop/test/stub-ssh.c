// The stub ssh of windows-askpass.test.ts: `ssh` must be a program Windows can start, and Node can't stand
// in for it by name, reading ssh's -T as its own. It runs `STUB_NODE STUB_SCRIPT <its arguments>`, on its own
// stdio, and exits as that does.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <stdlib.h>
#include <wchar.h>

/** The command line past its program's name. */
static const wchar_t *arguments(const wchar_t *line) {
  if (*line == L'"') {
    line++;
    while (*line != 0 && *line != L'"') {
      line++;
    }
    if (*line == L'"') {
      line++;
    }
  } else {
    while (*line != 0 && *line != L' ' && *line != L'\t') {
      line++;
    }
  }
  return line;
}

static wchar_t *variable(const wchar_t *name) {
  DWORD size = GetEnvironmentVariableW(name, NULL, 0);
  wchar_t *value = size > 0 ? malloc(size * sizeof(wchar_t)) : NULL;
  if (value != NULL && GetEnvironmentVariableW(name, value, size) == 0) {
    return NULL;
  }
  return value;
}

int wmain(void) {
  const wchar_t *node = variable(L"STUB_NODE");
  const wchar_t *script = variable(L"STUB_SCRIPT");
  if (node == NULL || script == NULL) {
    return 127;
  }
  const wchar_t *rest = arguments(GetCommandLineW());
  size_t size = wcslen(node) + wcslen(script) + wcslen(rest) + 8;
  wchar_t *line = malloc(size * sizeof(wchar_t));
  if (line == NULL) {
    return 127;
  }
  swprintf(line, size, L"\"%ls\" \"%ls\"%ls", node, script, rest);
  STARTUPINFOW startup;
  PROCESS_INFORMATION process;
  ZeroMemory(&startup, sizeof startup);
  startup.cb = sizeof startup;
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  if (!CreateProcessW(NULL, line, NULL, NULL, TRUE, 0, NULL, NULL, &startup,
                      &process)) {
    return 127;
  }
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD code = 127;
  GetExitCodeProcess(process.hProcess, &code);
  return (int)code;
}
