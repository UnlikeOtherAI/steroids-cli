# Steroids CLI Makefile

.PHONY: build install clean test lint help restart launch stop-ui

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
	@echo "WebUI/API targets:"
	@echo "  make launch    - Start WebUI and API locally"
	@echo "  make stop-ui   - Stop WebUI and API"

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

# Launch WebUI and API locally (stops existing, rebuilds, starts fresh)
launch:
	@echo "Stopping existing services..."
	-@pkill -f "steroids-api" 2>/dev/null || true
	-@pkill -f "vite.*WebUI" 2>/dev/null || true
	-@lsof -ti:3500 -ti:3501 | xargs kill -9 2>/dev/null || true
	@sleep 1
	@echo "Building API..."
	@cd API && npm run build
	@echo "Building WebUI..."
	@cd WebUI && npm run build
	@echo "Starting Steroids API..."
	@cd API && npm start &
	@sleep 2
	@echo "Starting Steroids WebUI..."
	@cd WebUI && npm run dev &
	@sleep 2
	@echo ""
	@echo "Steroids Dashboard running:"
	@echo "  WebUI: http://localhost:3500"
	@echo "  API:   http://localhost:3501"
	@echo ""
	@echo "Use 'make stop-ui' to stop"

# Stop WebUI and API
stop-ui:
	@echo "Stopping Steroids UI services..."
	-@pkill -f "steroids-api" 2>/dev/null || true
	-@pkill -f "vite.*WebUI" 2>/dev/null || true
	@echo "Stopped"
