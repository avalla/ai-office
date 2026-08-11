# M6C native filesystem spike

This directory is disposable security research for M6C.0. It is deliberately
outside the Bun workspaces and is not imported by the connector SDK,
filesystem connector, daemon, or CLI. The N-API export exposes only the
read-only `probeCapabilities()` function; mutation helpers exist only as Rust
test fixtures operating on temporary directories.

The spike is Linux-only and has no path-based fallback. A missing syscall,
resolve flag, mount-identity field, or required filesystem behavior produces an
unsupported result.

## Commands

```bash
docker run --rm -v "$PWD:/spike" -w /spike rust:1.89-bookworm \
  cargo test --locked

docker run --rm --privileged \
  -e M6C_RUN_PRIVILEGED_MOUNT_TESTS=1 \
  -v "$PWD:/spike" -w /spike rust:1.89-bookworm \
  cargo test --locked privileged_mount

docker build -t ai-office-m6c-native-spike .
docker run --rm ai-office-m6c-native-spike
```

The privileged test is security evidence only when it actually runs. A skipped
test is reported as unverified, never as a pass.
