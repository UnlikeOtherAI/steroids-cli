# Steroids CLI Makefile

.PHONY: build install clean test lint help restart launch launch-detached stop-ui

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
	@echo "  make launch          - Start WebUI and API (foreground, shows logs)"
	@echo "  make launch-detached - Start WebUI and API (background, no output)"
	@echo "  make stop-ui         - Stop WebUI and API"

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

# Launch WebUI and API in foreground (shows logs, Ctrl+C to stop)
# WebUI runs in dev mode with hot reload - no build needed
launch:
	@echo "Stopping existing services..."
	-@pkill -f "steroids-api" 2>/dev/null || true
	-@pkill -f "vite.*WebUI" 2>/dev/null || true
	-@lsof -ti:3500 -ti:3501 | xargs kill -9 2>/dev/null || true
	@sleep 1
	@echo "Building API..."
	@cd API && npm run build
	@echo ""
	@echo "Starting Steroids Dashboard (Ctrl+C to stop)..."
	@echo "  WebUI: http://localhost:3500 (dev mode - hot reload enabled)"
	@echo "  API:   http://localhost:3501"
	@echo ""
	@bash -c '\
		cleanup() { pkill -f "steroids-api" 2>/dev/null; pkill -f "vite.*WebUI" 2>/dev/null; exit 0; }; \
		trap cleanup INT TERM; \
		cd API && npm start & \
		cd WebUI && npm run dev & \
		wait \
	'

# Launch WebUI and API in background (detached, no terminal output)
# WebUI runs in dev mode with hot reload - no build needed
launch-detached:
	@echo "Stopping existing services..."
	-@pkill -f "steroids-api" 2>/dev/null || true
	-@pkill -f "vite.*WebUI" 2>/dev/null || true
	-@lsof -ti:3500 -ti:3501 | xargs kill -9 2>/dev/null || true
	@sleep 1
	@echo "Building API..."
	@cd API && npm run build
	@mkdir -p .steroids/logs
	@echo "Starting Steroids API (detached)..."
	@cd API && nohup npm start > ../.steroids/logs/api.log 2>&1 &
	@sleep 2
	@echo "Starting Steroids WebUI (detached)..."
	@cd WebUI && nohup npm run dev > ../.steroids/logs/webui.log 2>&1 &
	@sleep 2
	@echo ""
	@echo "Steroids Dashboard running (detached):"
	@echo "  WebUI: http://localhost:3500 (dev mode - hot reload enabled)"
	@echo "  API:   http://localhost:3501"
	@echo ""
	@echo "Logs: .steroids/logs/api.log, .steroids/logs/webui.log"
	@echo "Use 'make stop-ui' to stop"

# Stop WebUI and API
stop-ui:
	@echo "Stopping Steroids UI services..."
	-@pkill -f "steroids-api" 2>/dev/null || true
	-@pkill -f "vite.*WebUI" 2>/dev/null || true
	@echo "Stopped"
