- The model proxy reads a subscription's usage windows from every response it passes on, allowed ones too:
  Anthropic's five-hour and seven-day utilisation and ChatGPT's primary and secondary windows. It keeps each
  account's latest figure per window, serves them (`windows`), and publishes each move as a `Windowed` event,
  which the run writes as a `usage_window` record, its reset in the run's zone.
