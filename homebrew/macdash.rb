class Macdash < Formula
  desc "Beautiful macOS system dashboard for monitoring services, processes and resources"
  homepage "https://talhaorak.github.io/mac-dash"
  license "MIT"
  version "1.0.5"

  on_arm do
    url "https://github.com/talhaorak/mac-dash/releases/download/v#{version}/macdash-#{version}-darwin-arm64.tar.gz"
    # sha256 will be auto-updated by CI
  end

  on_intel do
    url "https://github.com/talhaorak/mac-dash/releases/download/v#{version}/macdash-#{version}-darwin-x64.tar.gz"
    # sha256 will be auto-updated by CI
  end

  depends_on :macos

  def install
    if Hardware::CPU.arm?
      bin.install "macdash-darwin-arm64" => "macdash"
    else
      bin.install "macdash-darwin-x64" => "macdash"
    end
    pkgshare.install "dist"
    pkgshare.install "plugins"
  end

  service do
    run [opt_bin/"macdash"]
    keep_alive true
    log_path var/"log/macdash/stdout.log"
    error_log_path var/"log/macdash/stderr.log"
    environment_variables PORT: "7227", NODE_ENV: "production"
  end

  test do
    assert_match "macdash", shell_output("#{bin}/macdash --version 2>&1", 0)
  end
end
