- A run's start refreshes a subscription's OAuth token with under an hour left before it probes it, so the first
  worker doesn't find the token expired. A refresh that fails is a start problem (`SETUP`, exit 2), said once for
  its provider with the other problems, and the sign-in is kept; a provider whose tokens last under the hour, as
  GitHub Copilot's do, passes once the refresh has gone through.
