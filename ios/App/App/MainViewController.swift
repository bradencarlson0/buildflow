import Capacitor
import UIKit

// Registers app-specific plugins that are not part of auto-registered Capacitor packages.
// This keeps the iOS Messages compose capability local to the app without requiring
// editing the generated capacitor.config.json packageClassList.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(MessageComposerPlugin())
    }
}

