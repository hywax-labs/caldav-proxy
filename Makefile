.PHONY: build-docker
build-docker:
	docker build \
    -t ghcr.io/hywax-labs/caldav-proxy:local \
    -f Dockerfile \
    .
