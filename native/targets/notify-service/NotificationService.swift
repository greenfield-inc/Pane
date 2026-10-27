import UserNotifications

/// Gives a Notify options alert (1 to 3 choices) its own buttons, labelled with the choices.
///
/// The host sends `notifyId`, `notifyChoices` (labels, recommended first) and `mutable-content: 1`
/// (main/src/daemon/mobilePushSender.ts). This registers the category
/// `pane.notify.options.<notifyId>` with one `choice.<n>` action per label and points the alert at
/// it, so two alerts never share labels. The app maps `choice.<n>` back to the label it answers
/// with (src/features/notify/notifyActions.ts). If anything here fails, the alert keeps the host's
/// `pane.notify.options` category, which has no buttons, and a tap opens the sheet.
class NotificationService: UNNotificationServiceExtension {
  private static let optionsPrefix = "pane.notify.options."
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var content: UNMutableNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    guard
      let content = request.content.mutableCopy() as? UNMutableNotificationContent,
      let notifyId = content.userInfo["notifyId"] as? String,
      let labels = content.userInfo["notifyChoices"] as? [String],
      !labels.isEmpty
    else {
      contentHandler(request.content)
      return
    }
    self.contentHandler = contentHandler
    self.content = content

    let center = UNUserNotificationCenter.current()
    center.getNotificationCategories { existing in
      center.getDeliveredNotifications { delivered in
        // Follow the app's choice (IOS_BUTTONS_OPEN_APP, D-13): its Approve button opens Pane or not.
        let opensApp = existing.first { $0.identifier == "pane.notify.approve" }?
          .actions.first?.options.contains(.foreground) ?? false
        let actions = labels.prefix(3).enumerated().map { index, label in
          UNNotificationAction(identifier: "choice.\(index)", title: label, options: opensApp ? [.foreground] : [])
        }
        let identifier = Self.optionsPrefix + notifyId
        // Keep the app's fixed sets, and per-question sets only while their alerts are still shown.
        let inUse = Set(delivered.map { $0.request.content.categoryIdentifier })
        let kept = existing.filter { !$0.identifier.hasPrefix(Self.optionsPrefix) || inUse.contains($0.identifier) }
        let category = UNNotificationCategory(identifier: identifier, actions: Array(actions), intentIdentifiers: [], options: [])
        center.setNotificationCategories(kept.union([category]))
        content.categoryIdentifier = identifier
        self.deliver()
      }
    }
  }

  override func serviceExtensionTimeWillExpire() {
    deliver()
  }

  private func deliver() {
    guard let contentHandler, let content else { return }
    self.contentHandler = nil
    contentHandler(content)
  }
}
