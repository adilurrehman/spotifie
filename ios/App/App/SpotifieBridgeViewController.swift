import Capacitor
import UIKit

/// Spotifie's iOS shell: one web view showing the same web application every
/// other copy runs. The only native code of its own is the music-folder plugin,
/// registered here once the bridge exists - the way Capacitor asks an app to
/// register a plugin that lives in the app rather than in a package.
///
/// NOT YET COMPILED OR RUN: written on Windows. See P15_MAC_HANDOFF.private.md.
class SpotifieBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(MusicFoldersPlugin())
    }
}
