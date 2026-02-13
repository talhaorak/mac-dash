cask "macdash" do
  version "1.0.6"
  sha256 :no_check

  url "https://github.com/talhaorak/mac-dash/releases/download/v#{version}/Mac.Dash_#{version}_aarch64.dmg"
  name "Mac Dash"
  desc "Beautiful macOS system dashboard — monitor services, processes, resources and logs"
  homepage "https://github.com/talhaorak/mac-dash"

  depends_on macos: ">= :ventura"

  app "Mac Dash.app"

  zap trash: [
    "~/Library/Application Support/com.talhaorak.macdash",
    "~/Library/Caches/com.talhaorak.macdash",
    "~/Library/Preferences/com.talhaorak.macdash.plist",
  ]
end
