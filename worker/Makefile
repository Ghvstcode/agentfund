# Worker build and test entry points. Run from worker/.
BIN        ?= bin/agentfund
IMAGES_DIR := ../images
DOCKER     ?= docker
DOCKER_ARCH = $(shell $(DOCKER) version --format '{{.Server.Arch}}')
E2E_SCENARIOS := happy scope verifyfail budget hang ratelimit autherror unreachable leak nochange

.PHONY: build test test-short test-integration vet fmt sync-spec images sandbox-image egress-image e2e-images snapshot clean

build:
	CGO_ENABLED=0 go build -o $(BIN) ./cmd/agentfund

# Copy the normative schemas into the module (they are embedded in the binary).
# TestEmbeddedSchemasMatchSpec fails when the copies drift.
sync-spec:
	go generate ./internal/spec

fmt:
	gofmt -l -w .

vet:
	go vet ./... && go vet -tags integration ./...

# Unit tests: no Docker, no network.
test:
	go test ./...

test-short:
	go test -short ./...

# Full pipeline against a fake server, a file:// repo and the e2e images. Needs Docker.
test-integration:
	go test -tags integration -count=1 -timeout 20m ./...

sandbox-image:
	$(DOCKER) build -t agentfund/sandbox:dev $(IMAGES_DIR)/sandbox

egress-image:
	$(DOCKER) build -t agentfund/egress-proxy:dev $(IMAGES_DIR)/egress-proxy

images: sandbox-image egress-image

# Test-only images whose `claude` is cmd/mock-agent, one per scripted scenario.
e2e-images:
	mkdir -p $(IMAGES_DIR)/sandbox/.build
	CGO_ENABLED=0 GOOS=linux GOARCH=$(DOCKER_ARCH) go build -o $(IMAGES_DIR)/sandbox/.build/mock-agent ./cmd/mock-agent
	for s in $(E2E_SCENARIOS); do \
	  $(DOCKER) build -q -f $(IMAGES_DIR)/sandbox/Dockerfile.e2e --build-arg MOCK_SCENARIO=$$s -t agentfund/sandbox-e2e:$$s $(IMAGES_DIR)/sandbox || exit 1; \
	done

snapshot:
	cd .. && goreleaser build --snapshot --clean

clean:
	rm -rf bin dist
