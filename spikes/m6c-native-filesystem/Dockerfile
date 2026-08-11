FROM rust:1.89-bookworm AS build

WORKDIR /spike
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src
RUN cargo build --release --locked

FROM oven/bun:1.3.6

WORKDIR /spike
COPY --from=build /spike/target/release/libm6c_native_filesystem_spike.so ./m6c_native_filesystem_spike.node
COPY bridge/probe.ts ./bridge/probe.ts

ENTRYPOINT ["bun", "run", "bridge/probe.ts", "./m6c_native_filesystem_spike.node"]
