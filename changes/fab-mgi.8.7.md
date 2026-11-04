- A project's `container` setting now runs each worker and its verifier in a container of its own, through the
  `docker` or `podman` CLI: `container.runtime` chooses where both are present, a rootless runtime is preferred
  and a notice says when only a rootful daemon is found. The image is pulled, or a devcontainer file's built,
  before the run's first dispatch; memory and CPU limits default to the worker's share; the new
  `container.network` names a network; the container is removed with its worker, also when the engine is killed.
  A rootless host without cgroup cpu delegation fails the start checks, naming the one-time root step.
