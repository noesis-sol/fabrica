- A worker in a container now runs at `worker_nice` inside it: the mounted Node sets Pi's process as it starts, and
  the commands Pi spawns inherit that. Before, the nice value stayed on the host's `docker exec` client, and Pi ran
  at the container runtime's priority.
