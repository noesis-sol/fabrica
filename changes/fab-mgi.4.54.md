- A run's `FABRICA_<key>` settings variables are the starting client's: `fabrica run` sends those in its own
  environment with its flags, and the engine resolves flag, then variable, then the project's settings, then
  its own. `FABRICA_CONCURRENT=1 fabrica run` now takes effect, and a variable left in whatever started the
  engine no longer applies to every project's runs; `FABRICA_AUTO_ANSWER` marks the run as `--auto-answer` does.
