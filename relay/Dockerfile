# Build: docker build -t pane-relay relay/
FROM rust:1.97-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/pane-relay /usr/local/bin/pane-relay
USER nonroot
EXPOSE 443/tcp 53/udp 53/tcp 7842/udp
ENTRYPOINT ["/usr/local/bin/pane-relay"]
