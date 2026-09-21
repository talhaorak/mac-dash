class Macdash < Formula
  desc "Beautiful macOS system dashboard for monitoring services, processes and resources"
  homepage "https://talhaorak.github.io/mac-dash"
  license "MIT"
  version "1.0.5"

  on_arm do
    url "https://github.com/talhaorak/mac-dash/releases/download/v#{version}/macdash-#{version}-darwin-arm64.tar.gz"
    # sha256: the tap sets it from `arm64_sha256` in the `release`
    # repository_dispatch payload (.github/workflows/release.yml)
  end

  on_intel do
    url "https://github.com/talhaorak/mac-dash/releases/download/v#{version}/macdash-#{version}-darwin-x64.tar.gz"
    # sha256: the tap sets it from `x64_sha256` in the same payload
  end

  depends_on :macos

  def install
    if Hardware::CPU.arm?
      bin.install "macdash-darwin-arm64" => "macdash"
    else
      bin.install "macdash-darwin-x64" => "macdash"
    end
    # The binary looks for these in ../share/macdash (server/plugins/paths.ts)
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
    # The compiled binary has no --version flag: it always starts the server.
    port = free_port
    pid = spawn({ "PORT" => port.to_s }, bin/"macdash")
    begin
      sleep 3
      assert_match "\"status\":\"ok\"", shell_output("curl -s http://127.0.0.1:#{port}/api/health")
    ensure
      Process.kill("TERM", pid)
      Process.wait(pid)
    end
  end
end
