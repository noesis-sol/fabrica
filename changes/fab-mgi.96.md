- The Windows app relays ssh's prompts: an unknown host's key, a passphrase, a password, a confirmation and a
  security key's touch reach the app as they do on macOS and Linux, through a small helper program the app ships
  (packaging for Windows now takes clang). ssh there is no longer run in batch mode, so it takes OpenSSH 8.4 or
  later, and an older one is refused, saying how to install a newer one.
