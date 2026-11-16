# The image each release publishes as ghcr.io/greenfield-inc/pane-relay
# (.github/workflows/build.yml). It packs the release's static Linux binaries,
# so it builds for every platform without compiling or emulating:
#   <context>/amd64/pane-relay and <context>/arm64/pane-relay
#   docker buildx build --platform linux/amd64,linux/arm64 -f relay/release.Dockerfile <context>
# To build from source instead: docker build -t pane-relay relay/
FROM --platform=$BUILDPLATFORM busybox:1.37 AS state
RUN mkdir -p /var/lib/pane-relay/acme

FROM gcr.io/distroless/static-debian12:nonroot
ARG TARGETARCH
LABEL org.opencontainers.image.source=https://github.com/greenfield-inc/Pane \
      org.opencontainers.image.description="Pane relay: give your Pane computers https addresses on your own domain" \
      org.opencontainers.image.licenses=AGPL-3.0-only
COPY --chmod=755 ${TARGETARCH}/pane-relay /usr/local/bin/pane-relay
# A named volume mounted here starts out writable by the nonroot user (uid 65532).
COPY --from=state --chown=65532:65532 /var/lib/pane-relay /var/lib/pane-relay
USER nonroot
EXPOSE 443/tcp 53/udp 53/tcp 7842/udp
ENTRYPOINT ["/usr/local/bin/pane-relay"]
