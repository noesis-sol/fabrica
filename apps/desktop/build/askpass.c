// The Windows app's SSH_ASKPASS helper (spec §9.1, fab-mgi.96): Windows' ssh runs a program by its path, so
// the relay's script (packages/client/src/transports/ssh.ts) can't serve there, and Electron's RunAsNode
// fuse is off. It speaks the script's protocol: ssh's prompt is its one argument and SSH_ASKPASS_PROMPT the
// hint; it sends {"prompt", "hint"} as one JSON line to the named pipe FABRICA_ASKPASS names, gets one
// reply line back, {"_tag":"Answer","text"} or {"_tag":"Cancel"}, and prints the answer. It exits 1 with
// nothing printed on a cancel or on anything else, which ssh takes as cancelled. It never reads its stdin,
// the bridge's pipe. A notice gets no reply: ssh ends it, as it waits on the pipe.
//
// electron-builder's beforePack hook builds it (askpass.ts). apps/desktop/test/windows-askpass.test.ts runs
// the installed one against a stub ssh on Windows CI.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <stdlib.h>
#include <string.h>

/** The most a reply line may hold. */
#define REPLY_MAX_BYTES (256 * 1024)

/** How long, in milliseconds, to wait for a free instance of a busy pipe. */
#define PIPE_BUSY_WAIT 5000

static char reply[REPLY_MAX_BYTES + 1];

/** `wide` as UTF-8, or NULL. */
static char *utf8_of(const wchar_t *wide) {
  int size = WideCharToMultiByte(CP_UTF8, 0, wide, -1, NULL, 0, NULL, NULL);
  char *text = size > 0 ? malloc((size_t)size) : NULL;
  if (text != NULL &&
      WideCharToMultiByte(CP_UTF8, 0, wide, -1, text, size, NULL, NULL) == 0) {
    return NULL;
  }
  return text;
}

/** The environment variable `name`, or NULL where it isn't set. */
static wchar_t *variable(const wchar_t *name) {
  DWORD size = GetEnvironmentVariableW(name, NULL, 0);
  wchar_t *value = size > 0 ? malloc(size * sizeof(wchar_t)) : NULL;
  if (value != NULL && GetEnvironmentVariableW(name, value, size) == 0) {
    return NULL;
  }
  return value;
}

/** Writes `text` at `out` as a JSON string, at most 6 bytes for each of its and 2 more; the end of it. */
static char *quoted(char *out, const char *text) {
  static const char hex[] = "0123456789abcdef";
  *out++ = '"';
  for (const unsigned char *at = (const unsigned char *)text; *at != 0; at++) {
    if (*at == '"' || *at == '\\') {
      *out++ = '\\';
      *out++ = (char)*at;
    } else if (*at < 0x20) {
      memcpy(out, "\\u00", 4);
      out += 4;
      *out++ = hex[*at >> 4];
      *out++ = hex[*at & 0xf];
    } else {
      *out++ = (char)*at;
    }
  }
  *out++ = '"';
  return out;
}

/** The request line for `prompt` and `hint`, its length in `length`, or NULL. */
static char *request_of(const char *prompt, const char *hint, DWORD *length) {
  static const char before_prompt[] = "{\"prompt\":";
  static const char before_hint[] = ",\"hint\":";
  static const char after[] = "}\n";
  size_t most = sizeof before_prompt + sizeof before_hint + sizeof after +
                (strlen(prompt) + strlen(hint) + 2) * 6;
  char *line = malloc(most);
  if (line == NULL) {
    return NULL;
  }
  char *end = line;
  memcpy(end, before_prompt, sizeof before_prompt - 1);
  end = quoted(end + sizeof before_prompt - 1, prompt);
  memcpy(end, before_hint, sizeof before_hint - 1);
  end = quoted(end + sizeof before_hint - 1, hint);
  memcpy(end, after, sizeof after - 1);
  end += sizeof after - 1;
  *length = (DWORD)(end - line);
  return line;
}

/** A connection to the pipe `name`, waiting while every instance is busy; INVALID_HANDLE_VALUE if none. */
static HANDLE connected(const wchar_t *name) {
  for (;;) {
    // Anonymous: whatever holds the name learns nothing of this process's identity.
    HANDLE pipe =
        CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
                    SECURITY_SQOS_PRESENT | SECURITY_ANONYMOUS, NULL);
    if (pipe != INVALID_HANDLE_VALUE || GetLastError() != ERROR_PIPE_BUSY ||
        !WaitNamedPipeW(name, PIPE_BUSY_WAIT)) {
      return pipe;
    }
  }
}

static BOOL write_all(HANDLE to, const char *bytes, DWORD length) {
  while (length > 0) {
    DWORD wrote = 0;
    if (!WriteFile(to, bytes, length, &wrote, NULL)) {
      return FALSE;
    }
    bytes += wrote;
    length -= wrote;
  }
  return TRUE;
}

/** Reads `reply` up to its line's end or the pipe's; FALSE where the line is too long. */
static BOOL read_reply(HANDLE pipe) {
  DWORD held = 0;
  while (held < REPLY_MAX_BYTES) {
    DWORD got = 0;
    if (!ReadFile(pipe, reply + held, REPLY_MAX_BYTES - held, &got, NULL) ||
        got == 0) {
      return TRUE;
    }
    if (memchr(reply + held, '\n', got) != NULL) {
      return TRUE;
    }
    held += got;
  }
  return FALSE;
}

static char *skip_space(char *at) {
  while (*at == ' ' || *at == '\t' || *at == '\r' || *at == '\n') {
    at++;
  }
  return at;
}

/** The four hex digits at `at`, or -1. */
static long hex4(const char *at) {
  long value = 0;
  for (int digit = 0; digit < 4; digit++) {
    char c = at[digit];
    int part = c >= '0' && c <= '9'   ? c - '0'
               : c >= 'a' && c <= 'f' ? c - 'a' + 10
               : c >= 'A' && c <= 'F' ? c - 'A' + 10
                                      : -1;
    if (part < 0) {
      return -1;
    }
    value = value * 16 + part;
  }
  return value;
}

/** Writes `code` at `out` as UTF-8; the end of what it wrote. */
static char *utf8_code(char *out, long code) {
  if (code < 0x80) {
    *out++ = (char)code;
  } else if (code < 0x800) {
    *out++ = (char)(0xc0 | (code >> 6));
    *out++ = (char)(0x80 | (code & 0x3f));
  } else if (code < 0x10000) {
    *out++ = (char)(0xe0 | (code >> 12));
    *out++ = (char)(0x80 | ((code >> 6) & 0x3f));
    *out++ = (char)(0x80 | (code & 0x3f));
  } else {
    *out++ = (char)(0xf0 | (code >> 18));
    *out++ = (char)(0x80 | ((code >> 12) & 0x3f));
    *out++ = (char)(0x80 | ((code >> 6) & 0x3f));
    *out++ = (char)(0x80 | (code & 0x3f));
  }
  return out;
}

/** One decoded string of the reply, which holds it in place. */
struct text {
  const char *start;
  size_t length;
};

/**
 * Decodes the JSON string at `*cursor` in place, never longer than it was, moving `*cursor` past it; FALSE
 * where it isn't one. A lone surrogate, which UTF-8 can't hold, becomes U+FFFD, as Node's decoding has it.
 */
static BOOL parse_string(char **cursor, struct text *into) {
  char *at = *cursor;
  if (*at != '"') {
    return FALSE;
  }
  at++;
  char *out = at;
  into->start = at;
  while (*at != '"') {
    if ((unsigned char)*at < 0x20) {
      return FALSE;
    }
    if (*at != '\\') {
      *out++ = *at++;
      continue;
    }
    at++;
    char escape = *at++;
    switch (escape) {
    case '"':
    case '\\':
    case '/':
      *out++ = escape;
      break;
    case 'b':
      *out++ = '\b';
      break;
    case 'f':
      *out++ = '\f';
      break;
    case 'n':
      *out++ = '\n';
      break;
    case 'r':
      *out++ = '\r';
      break;
    case 't':
      *out++ = '\t';
      break;
    case 'u': {
      long code = hex4(at);
      if (code < 0) {
        return FALSE;
      }
      at += 4;
      if (code >= 0xd800 && code <= 0xdbff && at[0] == '\\' && at[1] == 'u') {
        long low = hex4(at + 2);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          at += 6;
        }
      }
      out = utf8_code(out, code >= 0xd800 && code <= 0xdfff ? 0xfffd : code);
      break;
    }
    default:
      return FALSE;
    }
  }
  into->length = (size_t)(out - into->start);
  *cursor = at + 1;
  return TRUE;
}

static BOOL is(const struct text *text, const char *word) {
  size_t length = strlen(word);
  return text->start != NULL && text->length == length &&
         memcmp(text->start, word, length) == 0;
}

/** The answer in `reply`, a JSON object of strings; FALSE where it holds none, as a cancel doesn't. */
static BOOL answer_in(char *at, struct text *answer) {
  struct text tag = {NULL, 0};
  answer->start = NULL;
  at = skip_space(at);
  if (*at != '{') {
    return FALSE;
  }
  at = skip_space(at + 1);
  while (*at != '}') {
    struct text key = {NULL, 0};
    struct text value = {NULL, 0};
    if (!parse_string(&at, &key)) {
      return FALSE;
    }
    at = skip_space(at);
    if (*at != ':') {
      return FALSE;
    }
    at = skip_space(at + 1);
    if (!parse_string(&at, &value)) {
      return FALSE;
    }
    if (is(&key, "_tag")) {
      tag = value;
    } else if (is(&key, "text")) {
      *answer = value;
    }
    at = skip_space(at);
    if (*at == ',') {
      at = skip_space(at + 1);
    } else if (*at != '}') {
      return FALSE;
    }
  }
  return is(&tag, "Answer") && answer->start != NULL;
}

int wmain(int argc, wchar_t **argv) {
  const wchar_t *address = variable(L"FABRICA_ASKPASS");
  const wchar_t *hint = variable(L"SSH_ASKPASS_PROMPT");
  char *prompt_text = utf8_of(argc > 1 ? argv[1] : L"");
  char *hint_text = utf8_of(hint != NULL ? hint : L"");
  if (address == NULL || prompt_text == NULL || hint_text == NULL) {
    return 1;
  }
  DWORD length = 0;
  const char *request = request_of(prompt_text, hint_text, &length);
  if (request == NULL) {
    return 1;
  }
  HANDLE pipe = connected(address);
  if (pipe == INVALID_HANDLE_VALUE || !write_all(pipe, request, length) ||
      !read_reply(pipe)) {
    return 1;
  }
  CloseHandle(pipe);
  struct text answer;
  if (!answer_in(reply, &answer)) {
    return 1;
  }
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  return write_all(out, answer.start, (DWORD)answer.length) &&
                 write_all(out, "\n", 1)
             ? 0
             : 1;
}
