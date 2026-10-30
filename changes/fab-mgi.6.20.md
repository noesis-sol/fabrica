- The app starts the local engine again when it stops answering while the app runs (a crash, `fabrica engine
  stop`, a restart after an update): the connection process asks for it before each connection to the local
  socket, and the console says why it couldn't be started, as it tries again.
