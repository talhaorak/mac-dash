# mac-dash — Local CI/CD
# Usage: make desktop-build, make desktop-dmg, make desktop-release
# GitHub Actions remains available but optional (workflow_dispatch only)

DESKTOP_DIR  := packages/desktop
TAURI_DIR    := $(DESKTOP_DIR)/src-tauri
CLIENT_DIR   := client
DIST_DIR     := dist/client
TARGET       := universal-apple-darwin
VERSION      := $(shell node -p "require('./$(TAURI_DIR)/tauri.conf.json').version")
DMG_GLOB     := $(TAURI_DIR)/target/$(TARGET)/release/bundle/dmg/*.dmg
CASK_FILE    := homebrew/macdash-cask.rb

.PHONY: help check-tools client desktop-dev desktop-build desktop-dmg desktop-cask desktop-release lint clean version

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ─── Prerequisites ──────────────────────────────────────────────
check-tools:
	@command -v cargo >/dev/null || { echo "❌ cargo not found"; exit 1; }
	@command -v cargo-tauri >/dev/null || { echo "❌ tauri-cli not found. Run: cargo install tauri-cli --locked"; exit 1; }
	@command -v bun >/dev/null || { echo "❌ bun not found"; exit 1; }

# ─── Client ─────────────────────────────────────────────────────
client: ## Build the web client (vite)
	cd $(CLIENT_DIR) && bun install && bunx --bun vite build
	@test -f $(DIST_DIR)/index.html || { echo "❌ Client build failed — no index.html"; exit 1; }
	@echo "✅ Client built → $(DIST_DIR)/"

# ─── Desktop ────────────────────────────────────────────────────
desktop-dev: check-tools ## Run desktop in dev mode
	cd $(DESKTOP_DIR) && cargo tauri dev

# TODO(signing): the build below is unsigned and un-notarized. `cargo tauri build`
# reads APPLE_CERTIFICATE, APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD and
# APPLE_TEAM_ID (codesign + notarization) and TAURI_SIGNING_PRIVATE_KEY (updater
# artifacts) from the environment of this command.
desktop-build: check-tools client ## Build desktop (universal macOS binary)
	cd $(DESKTOP_DIR) && cargo tauri build --target $(TARGET)
	@echo "✅ Desktop built (v$(VERSION), $(TARGET))"

desktop-dmg: desktop-build ## Build desktop + locate DMG
	@ls $(DMG_GLOB) 2>/dev/null && echo "✅ DMG ready:" && ls -lh $(DMG_GLOB) || echo "⚠️  No DMG found"

desktop-cask: ## Write version + SHA-256 of the built DMG into the Homebrew cask
	@test -n "$$(ls $(DMG_GLOB) 2>/dev/null)" || { echo "❌ No DMG found. Run: make desktop-dmg"; exit 1; }
	@test "$$(ls $(DMG_GLOB) | wc -l | tr -d ' ')" = "1" || { echo "❌ More than one DMG matches $(DMG_GLOB)"; exit 1; }
	@SHA256="$$(shasum -a 256 $(DMG_GLOB) | awk '{print $$1}')"; \
		sed -E -i '' \
			-e "s|^  version \".*\"|  version \"$(VERSION)\"|" \
			-e "s|^  sha256 .*|  sha256 \"$$SHA256\"|" \
			$(CASK_FILE); \
		grep -q "^  sha256 \"$$SHA256\"$$" $(CASK_FILE) || { echo "❌ Could not update $(CASK_FILE)"; exit 1; }; \
		echo "✅ $(CASK_FILE) → v$(VERSION), sha256 $$SHA256"

desktop-release: desktop-dmg ## Build + create GitHub Release (requires gh CLI)
	@test -n "$$(ls $(DMG_GLOB) 2>/dev/null)" || { echo "❌ No DMG to release"; exit 1; }
	gh release create "desktop-v$(VERSION)" $(DMG_GLOB) \
		--title "Desktop v$(VERSION)" \
		--generate-notes
	@echo "🎉 Released desktop-v$(VERSION)"
	@echo "ℹ️  SHA-256: $$(shasum -a 256 $(DMG_GLOB) | awk '{print $$1}')"
	@echo "ℹ️  A local release sends no repository_dispatch to the tap. Run 'make desktop-cask' and copy $(CASK_FILE) to talhaorak/homebrew-tap."

# ─── Utilities ──────────────────────────────────────────────────
lint: ## Check for warnings
	cd $(DESKTOP_DIR) && cargo clippy --target aarch64-apple-darwin 2>&1 | grep -E "warning|error" || echo "✅ Clean"

clean: ## Clean build artifacts
	cd $(DESKTOP_DIR) && cargo clean
	rm -rf $(DIST_DIR)
	@echo "🧹 Cleaned"

version: ## Show current version
	@echo "v$(VERSION)"
