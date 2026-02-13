# Homebrew formula for mac-dash
# This file should be placed in a homebrew-tap repository
# Repository: https://github.com/talhaorak/homebrew-tap

class MacDash < Formula
  desc "Beautiful macOS system dashboard for monitoring services, processes and resources"
  homepage "https://talhaorak.github.io/mac-dash"
  license "MIT"
  version "1.0.0"

  on_arm do
    url "https://github.com/talhaorak/mac-dash/releases/download/v#{version}/mac-dash-#{version}-darwin-arm64.tar.gz"
    # sha256 will be auto-updated by CI
  end

  on_intel do
    url "https://github.com/talhaorak/mac-dash/releases/download/v#{version}/mac-dash-#{version}-darwin-x64.tar.gz"
    # sha256 will be auto-updated by CI
  end

  depends_on :macos

  def install
    if Hardware::CPU.arm?
      bin.install "mac-dash-darwin-arm64" => "mac-dash"
    else
      bin.install "mac-dash-darwin-x64" => "mac-dash"
    end
    # Install web assets
    pkgshare.install "dist"
    pkgshare.install "plugins"
  end

  service do
    run [opt_bin/"mac-dash"]
    keep_alive true
    log_path var/"log/mac-dash/stdout.log"
    error_log_path var/"log/mac-dash/stderr.log"
    environment_variables PORT: "7227", NODE_ENV: "production"
  end

  test do
    assert_match "mac-dash", shell_output("#{bin}/mac-dash --version 2>&1", 0)
  end
end
