- The desktop app's local-engine tests no longer terminate the check they run in. They stopped their fixture
  engine by the PID it wrote to a file, which a test timing out under load could read before the fixture had
  written it: the empty text read as PID 0, and a signal to 0 reaches the test runner's whole process group.
  The fixture now writes the file whole, renamed into place, and the test signals only a PID it read, a whole
  number above 1, through @fabrica/testkit's `notePid` and `stopNotedProcess`.
