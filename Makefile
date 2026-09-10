SHELL := /bin/sh

NODE_MAJOR := 22
PREK_VERSION := 0.5.2
PREK := $(HOME)/.local/bin/prek
WEB_EXT_VERSION := 10.6.0
WEB_EXT := $(HOME)/.local/bin/web-ext
ENV_FILE := .env
ENV_EXAMPLE := .env.example

VERSION = $(shell node -p "require('./manifest.json').version")
DIST_DIR := dist
PACKAGE_DIR := $(DIST_DIR)/extension
SIGNED_DIR := $(DIST_DIR)/signed
RELEASE_XPI := $(DIST_DIR)/REnew-firefox-v$(VERSION).xpi

.PHONY: install-dev lint static check package clean

install-dev:
	@current_node_major="$$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf '0')"; \
	if [ "$$current_node_major" != "$(NODE_MAJOR)" ]; then \
		if ! command -v apt-get >/dev/null 2>&1; then \
			echo "Node.js $(NODE_MAJOR) is required." >&2; \
			echo "Automatic installation is currently supported on Debian/Ubuntu systems." >&2; \
			exit 1; \
		fi; \
		echo "Installing Node.js $(NODE_MAJOR)..."; \
		sudo apt-get update; \
		sudo apt-get install -y curl ca-certificates; \
		curl -fsSL https://deb.nodesource.com/setup_$(NODE_MAJOR).x \
			| sudo -E bash -; \
		sudo apt-get install -y nodejs; \
	fi
	@node_major="$$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf '0')"; \
	if [ "$$node_major" != "$(NODE_MAJOR)" ]; then \
		echo "Node.js $(NODE_MAJOR) installation failed." >&2; \
		echo "Found: $$(node --version 2>/dev/null || echo 'not installed')" >&2; \
		exit 1; \
	fi
	@echo "Using Node.js $$(node --version)"
	@echo "Using npm $$(npm --version)"
	npm ci
	@current_web_ext_version="$$($(WEB_EXT) --version 2>/dev/null || true)"; \
	if [ "$$current_web_ext_version" != "$(WEB_EXT_VERSION)" ]; then \
		echo "Installing web-ext $(WEB_EXT_VERSION)..."; \
		npm install --global --prefix "$(HOME)/.local" "web-ext@$(WEB_EXT_VERSION)"; \
	fi
	@current_prek_version="$$($(PREK) --version 2>/dev/null | awk '{print $$2}')"; \
	if [ "$$current_prek_version" != "$(PREK_VERSION)" ]; then \
		if ! command -v pipx >/dev/null 2>&1; then \
			if ! command -v apt-get >/dev/null 2>&1; then \
				echo "pipx is required to install prek $(PREK_VERSION)." >&2; \
				echo "Automatic pipx installation is currently supported on Debian/Ubuntu systems." >&2; \
				exit 1; \
			fi; \
			echo "Installing pipx..."; \
			sudo apt-get update; \
			sudo apt-get install -y pipx; \
		fi; \
		echo "Installing prek $(PREK_VERSION) from PyPI..."; \
		PIPX_BIN_DIR="$(HOME)/.local/bin" pipx install --force "prek==$(PREK_VERSION)"; \
	fi
	@$(PREK) --version
	@$(WEB_EXT) --version
	@if [ ! -f "$(ENV_FILE)" ]; then \
		cp "$(ENV_EXAMPLE)" "$(ENV_FILE)"; \
		chmod 600 "$(ENV_FILE)"; \
		echo "Created $(ENV_FILE). Add your Mozilla Add-ons API credentials before running 'make package'."; \
	else \
		chmod 600 "$(ENV_FILE)"; \
		echo "Keeping existing $(ENV_FILE)."; \
	fi
	@if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then \
		$(PREK) install -f; \
		echo "Configured prek Git hook."; \
	else \
		echo "Dependencies installed."; \
		echo "Initialize Git and rerun 'make install-dev' to install the prek hook."; \
	fi

lint:
	$(PREK) run --all-files

static:
	npm run static

check: lint static

package: check
	@test -f "$(ENV_FILE)" || { \
		echo "$(ENV_FILE) is missing. Run 'make install-dev' first." >&2; \
		exit 1; \
	}
	@set -a; \
	. "./$(ENV_FILE)"; \
	set +a; \
	if [ -z "$${WEB_EXT_API_KEY:-}" ]; then \
		echo "WEB_EXT_API_KEY is not set in $(ENV_FILE)." >&2; \
		exit 1; \
	fi; \
	if [ -z "$${WEB_EXT_API_SECRET:-}" ]; then \
		echo "WEB_EXT_API_SECRET is not set in $(ENV_FILE)." >&2; \
		exit 1; \
	fi
	@rm -rf "$(PACKAGE_DIR)" "$(SIGNED_DIR)"
	@mkdir -p "$(PACKAGE_DIR)" "$(SIGNED_DIR)"
	@cp manifest.json background.js contentScript.js icon16.png icon48.png icon128.png "$(PACKAGE_DIR)/"
	@cp -R assets "$(PACKAGE_DIR)/assets"
	@"$(WEB_EXT)" lint --source-dir="$(PACKAGE_DIR)"
	@set -a; \
	. "./$(ENV_FILE)"; \
	set +a; \
	"$(WEB_EXT)" sign \
		--channel=unlisted \
		--source-dir="$(PACKAGE_DIR)" \
		--artifacts-dir="$(SIGNED_DIR)" \
		--no-input
	@xpi="$$(find "$(SIGNED_DIR)" -type f -name '*.xpi' -print -quit)"; \
	if [ -z "$$xpi" ]; then \
		echo "web-ext completed but no signed XPI was produced." >&2; \
		exit 1; \
	fi; \
	rm -f "$(RELEASE_XPI)"; \
	mv "$$xpi" "$(RELEASE_XPI)"; \
	rm -rf "$(PACKAGE_DIR)" "$(SIGNED_DIR)"; \
	echo "Created $(RELEASE_XPI)"

clean:
	rm -rf $(DIST_DIR)
