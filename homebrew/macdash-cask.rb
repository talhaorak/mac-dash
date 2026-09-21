# Template for the cask published in talhaorak/homebrew-tap.
#
# `.github/workflows/desktop-release.yml` (step "Render Homebrew cask") rewrites
# the `version` and `sha256` lines for every desktop release and sends the same
# values to the tap in the `desktop-release` repository_dispatch payload
# (`version`, `dmg_url`, `sha256`). Local releases: `make desktop-cask`.
#
# Keep both lines in the exact form `  version "..."` / `  sha256 "..."`:
# the workflow and the Makefile match them with sed.
# Never ship `sha256 :no_check`: it disables Homebrew's download verification.
cask "macdash" do
  version "1.0.9"
  sha256 "aa07395f9ae1f45536ed21ce44d41113cbf619f857fe6cd10d02a111b0fd6cb8"

  url "https://github.com/talhaorak/mac-dash/releases/download/desktop-v#{version}/Mac.Dash_#{version}_universal.dmg"
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
