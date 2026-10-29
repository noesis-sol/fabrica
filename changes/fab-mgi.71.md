- The app relays what ssh asks as it connects: the connection process runs ssh with an `SSH_ASKPASS` helper on
  the bundled engine's Node (the `node` on the PATH in a development build), asks main, and main asks the page,
  which shows an unknown host's key with its fingerprint to accept or refuse, a passphrase or password in a
  password field, a yes or no, or a notice; the answer goes back the same way, a prompt ssh no longer waits on
  is withdrawn, and main asks a page that reloads again what is still unanswered. On Windows ssh still asks
  nothing (`BatchMode`) until the app ships a helper of its own.
- A connection ssh or wsl.exe refuses (a changed host key, an unknown one refused, a failed sign-in, no fabrica
  on the host) is said to the page as refused, through a `Refused` signal on the engine port: the page's client
  stops reconnecting, and the app says why, with Try again, rather than reconnecting forever.
- Add engine refuses an ssh older than OpenSSH 8.4 at its check, saying how to get a newer one (on Windows,
  `winget install Microsoft.OpenSSH.Preview` or a Win32-OpenSSH release); the connection's own check says the
  same.
