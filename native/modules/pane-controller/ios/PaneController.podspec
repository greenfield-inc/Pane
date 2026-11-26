require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'PaneController'
  s.version        = package['version']
  s.summary        = package['description']
  s.license        = package['license']
  s.author         = 'Pane'
  s.homepage       = 'https://runpane.com'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/greenfield-inc/Pane.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '*.swift'
  s.frameworks = 'GameController', 'CoreHaptics'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
  }
end
