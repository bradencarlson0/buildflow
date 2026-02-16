import Capacitor
import Foundation
import MessageUI
import UniformTypeIdentifiers

@objc(MessageComposerPlugin)
public class MessageComposerPlugin: CAPPlugin, CAPBridgedPlugin, MFMessageComposeViewControllerDelegate {
    public let identifier = "MessageComposerPlugin"
    public let jsName = "MessageComposer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "composeMessage", returnType: CAPPluginReturnPromise)
    ]

    private var savedCall: CAPPluginCall?

    @objc public func composeMessage(_ call: CAPPluginCall) {
        guard MFMessageComposeViewController.canSendText() else {
            call.reject("cannot_send_text")
            return
        }

        let recipients = call.getArray("recipients", String.self) ?? []
        let body = call.getString("body") ?? ""
        let attachments = call.getArray("attachments", JSObject.self) ?? []

        if attachments.count > 0 && !MFMessageComposeViewController.canSendAttachments() {
            call.reject("cannot_send_attachments")
            return
        }

        call.keepAlive = true
        savedCall = call

        DispatchQueue.main.async {
            let vc = MFMessageComposeViewController()
            vc.messageComposeDelegate = self
            vc.recipients = recipients
            vc.body = body

            for raw in attachments {
                let base64 = raw["base64"] as? String ?? ""
                let mime = raw["mime"] as? String ?? "application/octet-stream"
                let fileName = raw["fileName"] as? String ?? "attachment"

                guard let data = Data(base64Encoded: base64) else { continue }
                let typeId = UTType(mimeType: mime)?.identifier ?? UTType.data.identifier
                _ = vc.addAttachmentData(data, typeIdentifier: typeId, filename: fileName)
            }

            guard let root = self.bridge?.viewController else {
                self.savedCall?.keepAlive = false
                self.savedCall?.reject("unknown")
                if let callToRelease = self.savedCall {
                    self.bridge?.releaseCall(callToRelease)
                }
                self.savedCall = nil
                return
            }

            root.present(vc, animated: true)
        }
    }

    public func messageComposeViewController(
        _ controller: MFMessageComposeViewController,
        didFinishWith result: MessageComposeResult
    ) {
        controller.dismiss(animated: true)

        let status: String
        switch result {
        case .sent:
            status = "sent"
        case .cancelled:
            status = "cancelled"
        case .failed:
            status = "failed"
        @unknown default:
            status = "failed"
        }

        if let call = savedCall {
            call.keepAlive = false
            call.resolve(["status": status])
            bridge?.releaseCall(call)
        }
        savedCall = nil
    }
}

