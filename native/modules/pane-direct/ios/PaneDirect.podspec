require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# Links the pane-direct Rust library (../../../../direct), which the script
# phase builds with cargo for the platform and architectures being built.
Pod::Spec.new do |s|
  s.name           = 'PaneDirect'
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

  s.source_files = '*.{h,swift}'
  s.public_header_files = 'pane_direct.h'
  s.frameworks = 'SystemConfiguration', 'Security'
  s.libraries = 'resolv'

  lib_dir = '${PODS_TARGET_SRCROOT}/../build/ios/${PLATFORM_NAME}'
  s.script_phase = {
    :name => 'Build pane-direct (Rust)',
    :script => 'bash "${PODS_TARGET_SRCROOT}/../scripts/build-ios.sh"',
    :execution_position => :before_compile,
    :output_files => ["#{lib_dir}/libpane_direct.a"],
    # Cargo decides what is stale; Xcode's own check would skip Rust edits.
    :always_out_of_date => '1',
  }
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
  }
  # The app target links the library: a static pod only archives its objects.
  s.user_target_xcconfig = {
    'OTHER_LDFLAGS' => '$(inherited) "${PODS_ROOT}/../../modules/pane-direct/build/ios/${PLATFORM_NAME}/libpane_direct.a"',
  }
end
