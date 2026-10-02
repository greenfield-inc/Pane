cask "pane" do
  arch arm: "arm64", intel: "x64"

  version "@VERSION@"
  sha256 arm:   "@SHA256:Pane-@VERSION@-macOS-arm64.dmg@",
         intel: "@SHA256:Pane-@VERSION@-macOS-x64.dmg@"

  url "https://github.com/greenfield-inc/Pane/releases/download/v#{version}/Pane-#{version}-macOS-#{arch}.dmg"
  name "Pane"
  desc "Run any coding agent in terminals, from desktop or phone"
  homepage "https://runpane.com/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: :monterey

  app "Pane.app"

  zap trash: [
    "~/.pane",
    "~/Library/Application Support/Pane",
    "~/Library/Caches/com.dcouple.pane",
    "~/Library/Caches/com.dcouple.pane.ShipIt",
    "~/Library/Caches/pane-updater",
    "~/Library/HTTPStorages/com.dcouple.pane",
    "~/Library/Preferences/com.dcouple.pane.plist",
    "~/Library/Saved Application State/com.dcouple.pane.savedState",
  ]
end
