# 1. pm2 instead of containers

**Status:** accepted

## Context

Apps are mostly Node services owned by the same person who owns the machine. The host is a Mac mini with 8 to 16 GB of memory. Docker Desktop, OrbStack or Colima on macOS all run a Linux VM that reserves memory up front, and Kubernetes (minikube, k3d) adds a control plane on top of that VM.

## Decision

Run apps directly on macOS under pm2, one process per app, with a generated ecosystem file. Homeport drives pm2 through its CLI.

## Consequences

- Restarts on crash, log files, memory limits and graceful reloads come from pm2 with no VM and no image builds. A deploy is a `git fetch`, an install and a reload, usually under ten seconds for a small app.
- Apps share the host's Node and system libraries. An app that needs a different Node version must pin it itself (for example `npx -y node@20` as the start command).
- There is no filesystem or network isolation between apps. This is acceptable because every app on the machine is trusted by its owner; Homeport is not a multi-tenant host.
- pm2's own quirks become Homeport's problem. One example: pm2 7 reads the `name` variable from its environment, which made child processes inherit Homeport's own name. Homeport now strips pm2 metadata from every child environment and has a test for it.
