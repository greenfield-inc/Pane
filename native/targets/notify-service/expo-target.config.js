// The iPhone notification service extension that gives each Notify options
// alert its own choice buttons (see NotificationService.swift).
/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'notification-service',
  name: 'NotifyService',
  bundleIdentifier: '.notify-service',
  deploymentTarget: '16.4',
};
