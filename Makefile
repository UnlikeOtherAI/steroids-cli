# Steroids CLI Makefile

.PHONY: build install clean test lint help restart

# Default target
help:
	@echo "Steroids CLI Development Commands"
	@echo ""
	@echo "  make build     - Build CLI and link globally"
	@echo "  make restart   - Stop runners, rebuild, restart runner"
	@echo "  make install   - Install dependencies"
	@echo "  make clean     - Remove build artifacts"
	@echo "  make test      - Run tests"
	@echo "  make lint      - Run linter"
	@echo ""
	@echo "Docker targets (WebUI/API):"
	@echo "  make docker    - Build Docker images"
	@echo "  make push      - Push Docker images"

# Build CLI and link globally
build:
	npm run build
	npm link

# Stop runners, rebuild, and restart
restart:
	-steroids runners stop --all
	npm run build
	npm link
	steroids runners start --detach

# Install dependencies
install:
	npm install

# Clean build artifacts
clean:
	rm -rf dist/

# Run tests
test:
	npm test

# Run linter
lint:
	npm run lint

# Docker targets for WebUI/API
VERSION := $(shell npm pkg get version | tr -d '"')

docker:
	docker build -t unlikeotherai/steroids-web:$(VERSION) ./WebUI
	docker build -t unlikeotherai/steroids-api:$(VERSION) ./API
	docker tag unlikeotherai/steroids-web:$(VERSION) unlikeotherai/steroids-web:latest
	docker tag unlikeotherai/steroids-api:$(VERSION) unlikeotherai/steroids-api:latest

push:
	docker push unlikeotherai/steroids-web:$(VERSION)
	docker push unlikeotherai/steroids-web:latest
	docker push unlikeotherai/steroids-api:$(VERSION)
	docker push unlikeotherai/steroids-api:latest
