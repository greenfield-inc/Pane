//! JNI entry points for `expo.modules.panedirect.PaneDirectNative`, wrapping
//! the C ABI in `ffi.rs`.

use std::ffi::{CStr, CString, c_char};

use jni::{
    JNIEnv,
    objects::{JClass, JObject, JString},
    sys::{jint, jlong, jstring},
};

use crate::ffi;

/// Gives iroh the JVM and application context, which it needs to read the
/// network's DNS servers (for relay names). Call once before `connect`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_panedirect_PaneDirectNative_init(
    env: JNIEnv,
    _class: JClass,
    context: JObject,
) {
    let Ok(vm) = env.get_java_vm() else { return };
    let Ok(context) = env.new_global_ref(context) else {
        return;
    };
    let context_ptr = context.as_obj().as_raw();
    // The process keeps the application context; the global ref must outlive it.
    std::mem::forget(context);
    unsafe {
        iroh::dns::install_android_jni_context(vm.get_java_vm_pointer().cast(), context_ptr.cast());
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_panedirect_PaneDirectNative_connect(
    mut env: JNIEnv,
    _class: JClass,
    config: JString,
) -> jstring {
    let text: String = match env.get_string(&config) {
        Ok(text) => text.into(),
        Err(_) => return std::ptr::null_mut(),
    };
    let config = CString::new(text).unwrap_or_default();
    let result = unsafe { ffi::pane_direct_connect(config.as_ptr()) };
    into_jstring(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_panedirect_PaneDirectNative_nextEvent(
    mut env: JNIEnv,
    _class: JClass,
    id: jlong,
    timeout_ms: jint,
) -> jstring {
    let result = ffi::pane_direct_next_event(id as u64, timeout_ms.max(0) as u32);
    into_jstring(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_panedirect_PaneDirectNative_close(
    _env: JNIEnv,
    _class: JClass,
    id: jlong,
) {
    ffi::pane_direct_close(id as u64);
}

/// Copies a string from the C ABI into a Java string and frees it; null stays null.
fn into_jstring(env: &mut JNIEnv, text: *mut c_char) -> jstring {
    if text.is_null() {
        return std::ptr::null_mut();
    }
    let value = unsafe { CStr::from_ptr(text) }
        .to_string_lossy()
        .into_owned();
    unsafe { ffi::pane_direct_free_string(text) };
    env.new_string(value)
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}
